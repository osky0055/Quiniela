'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

appendFile.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const PUBLIC_DIR = path.join(__dirname, 'public');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TIMEOUT_MS = 25000;

const PROVINCES = {
  nacional: { label: 'Nacional (Ciudad de Bs. As.)' },
  buenosaires: { label: 'Provincia de Buenos Aires' },
  santafe: { label: 'Santa Fe' },
  entrerios: { label: 'Entre Ríos' },
  cordoba: { label: 'Córdoba' },
  montevideo: { label: 'Montevideo (Uruguay)' },
};

const TYPES = {
  previa: { label: 'La Previa', hora: '10:15' },
  primera: { label: 'La Primera', hora: '12:00' },
  matutina: { label: 'Matutina', hora: '15:00' },
  vespertina: { label: 'Vespertina (Tarde)', hora: '18:00' },
  nocturna: { label: 'Nocturna (Noche)', hora: '21:00' },
};





const TYPE_ORDER = ['previa', 'primera', 'matutina', 'vespertina', 'nocturna'];
const PROVINCE_ORDER = ['nacional', 'buenosaires', 'santafe', 'entrerios', 'cordoba', 'montevideo'];

const Q6_BASE = 'https://www.quini-6-resultados.com.ar';
const JOKER_URL = 'https://jokerapuestas.com/sorteos-resultados';

const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function toKey(dateStr) {
  const p = dateStr.split('-');
  return `${p[2]}-${p[1]}-${p[0]}`;
}

function todayKey() {
  return toKey(new Date().toISOString().slice(0, 10));
}

function argToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay();
}

function validDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateStr;
}

async function fetchText(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'User-Agent': UA, Referer: opts.referer || url, ...(opts.headers || {}) },
      body: opts.body,
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/&nbsp;|\u00a0/g, ' ').trim();
}

function normalizeName(raw) {
  return String(raw)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function normNum(raw) {
  const m = String(raw).match(/\d{2,6}/);
  return m ? m[0] : null;
}

function jokerLoteriaId(raw) {
  const n = normalizeName(raw);
  if (n.includes('nacional')) return 'nacional';
  if (n.includes('bs') || n.includes('buenos')) return 'buenosaires';
  if (n.includes('santafe') || (n.includes('santa') && n.includes('fe'))) return 'santafe';
  if (n.includes('entrerios')) return 'entrerios';
  if (n.includes('cordob')) return 'cordoba';
  if (n.includes('montevideo')) return 'montevideo';
  return null;
}

function jokerTypeId(raw) {
  const n = normalizeName(raw);
  if (n.includes('previa')) return 'previa';
  if (n.includes('primera') || n.includes('primer')) return 'primera';
  if (n.includes('matutin')) return 'matutina';
  if (n.includes('vespertin')) return 'vespertina';
  if (n.includes('nocturn')) return 'nocturna';
  return null;
}

function q6TypeId(raw) {
  const n = normalizeName(raw);
  if (n.includes('primera')) return 'primera';
  if (n.includes('matutina')) return 'matutina';
  if (n.includes('vespertina')) return 'vespertina';
  if (n.includes('nocturna')) return 'nocturna';
  return null;
}

function parseJoker(html) {
  const chunks = html.split(/<table class="table-dis1">/i);
  const result = {};

  for (const chunk of chunks.slice(1)) {
    const th = chunk.match(/<th[^>]*>[\s\S]*?Resultados del Sorteo\s+([^<]*?)\s*<\/th>/i);
    if (!th) continue;
    const type = jokerTypeId(th[1]);
    if (!type) continue;

    const rows = [...chunk.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
    if (rows.length < 3) continue;

    const headerCells = [...rows[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    if (headerCells.length < 2) continue;

    for (let i = 2; i < rows.length; i++) {
      const cells = [...rows[i].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
      if (cells.length < 2) continue;
      const pos = parseInt(cells[0], 10);
      if (Number.isNaN(pos) || pos < 1) continue;
      for (let k = 1; k < cells.length && k < headerCells.length; k++) {
        const loteriaId = jokerLoteriaId(headerCells[k]);
        const num = normNum(cells[k]);
        if (!loteriaId || !num) continue;
        if (!result[loteriaId]) result[loteriaId] = {};
        if (!result[loteriaId][type]) result[loteriaId][type] = [];
        result[loteriaId][type][pos - 1] = num;
      }
    }
  }

  return result;
}

function parseQuini6(html) {
  const headings = [...html.matchAll(/<h3[^>]*>\s*([^<]*?)\s*<\/h3>/gi)].map((m) => m[1]);
  if (!headings.length) return null;

  const draws = [];
  let remaining = html;

  for (const heading of headings) {
    const type = q6TypeId(heading);
    const idx = remaining.indexOf(heading);
    if (idx === -1 || !type) continue;

    const nextStart = remaining.indexOf('<h3', idx + heading.length);
    const slice = nextStart === -1 ? remaining.slice(idx) : remaining.slice(idx, nextStart);

    const nums = {};
    for (const m of slice.matchAll(/<small>\s*(\d+)\s*\.\s*<\/small>[^<]*?(?:<b[^>]*>)?\s*(\d{2,6})(?:\s*<\/b>)?/g)) {
      const pos = parseInt(m[1], 10);
      if (pos >= 1 && pos <= 20) nums[pos] = m[2];
    }

    if (Object.keys(nums).length) {
      const numbers = [];
      for (let i = 1; i <= 20; i++) numbers[i - 1] = nums[i] || null;
      draws.push({ type, numbers });
    }

    remaining = nextStart === -1 ? '' : remaining.slice(nextStart);
  }

  return draws.length ? draws : null;
}

async function fetchJoker(dateStr) {
  const body = new URLSearchParams({ fecha_sorteo: dateStr }).toString();
  const { status, text } = await fetchText(JOKER_URL, {
    method: 'POST',
    referer: 'https://jokerapuestas.com/',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (status !== 200) return null;
  return parseJoker(text);
}

async function fetchQuini6(dateStr) {
  const url = `${Q6_BASE}/quinielas/nacional/sorteo-${toKey(dateStr)}.htm`;
  const { status, text } = await fetchText(url);
  if (status !== 200) return null;
  return parseQuini6(text);
}

function handleApi(dateStr, res) {
  if (!validDate(dateStr)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Fecha inválida. Usá el formato YYYY-MM-DD.' }));
    return;
  }

  const cached = cache.get(dateStr);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(cached.payload));
    return;
  }

  const q6 = fetchQuini6(dateStr).catch(() => null);
  const joker = fetchJoker(dateStr).catch(() => null);

  const notes = [];
  const map = new Map();

  function add(province, type, numbers, source) {
    if (!PROVINCES[province] || !TYPES[type] || !numbers) return;
    const cleaned = [];
    let count = 0;
    for (let i = 0; i < 20; i++) {
      const n = numbers[i] === null || numbers[i] === undefined ? '' : String(numbers[i]);
      cleaned.push(n);
      if (n) count++;
    }
    if (!count) return;

    const key = `${province}|${type}`;
    const exist = map.get(key);
    if (exist) {
      const complete = (a) => a.numbers.filter((n) => n).length === 20;
      if (!complete(exist) && count === 20) {
        exist.numbers = cleaned;
        exist.source = source;
      }
      return;
    }
    map.set(key, {
      id: `${province}-${type}`,
      date: dateStr,
      province,
      provinceLabel: PROVINCES[province].label,
      type,
      typeLabel: TYPES[type].label,
      hora: TYPES[type].hora,
      numbers: cleaned,
      source,
    });
  }

  Promise.all([q6, joker])
    .then(([q6Draws, jokerDraws]) => {
      if (q6Draws) {
        notes.push('Nacional: archivo histórico de quini-6-resultados.com.ar.');
        for (const d of q6Draws) add('nacional', d.type, d.numbers, 'quini6');
      }

      if (jokerDraws) {
        notes.push('Otras provincias y La Previa: jokerapuestas.com (conserva completo solo las últimas semanas).');
        for (const prov of Object.keys(jokerDraws)) {
          for (const type of Object.keys(jokerDraws[prov])) {
            add(prov, type, jokerDraws[prov][type], 'joker');
          }
        }
      }

      if (q6Draws === null && jokerDraws === null) {
        notes.push('Las fuentes no respondieron en este momento.');
      }

      const draws = [...map.values()].sort((a, b) => {
        const pi = PROVINCE_ORDER.indexOf(a.province) - PROVINCE_ORDER.indexOf(b.province);
        if (pi !== 0) return pi;
        return TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
      });

      const payload = {
        date: dateStr,
        sources: { quini6: !!q6Draws, joker: !!jokerDraws },
        notes,
        draws,
      };
      cache.set(dateStr, { at: Date.now(), payload });

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=120',
      });
      res.end(JSON.stringify(payload));
    })
    .catch((err) => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'No se pudieron obtener resultados: ' + err.message }));
    });
}

const statsCache = new Map();
const STATS_TTL_MS = 6 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function computeStats(weeks) {
  const today = argToday();
  const from = addDays(today, -(7 * weeks - 1));

  const days = [];
  for (let cur = from; cur <= today; cur = addDays(cur, 1)) {
    if (weekdayOf(cur) !== 0) days.push(cur); // sin domingos
  }

  const counts = new Map(); // province -> Map(twoDigit -> count)
  const lastSeen = new Map(); // province -> Map(twoDigit -> índice del último sorteo)
  const drawCounts = new Map(); // province -> cantidad de sorteos
  let totalDraws = 0;

  const poolSize = 5;
  for (let i = 0; i < days.length; i += poolSize) {
    const batch = days.slice(i, i + poolSize);
    const results = await Promise.all(
      batch.map((day) => fetchJoker(day).catch(() => null))
    );
    for (let k = 0; k < batch.length; k++) {
      const jd = results[k];
      if (!jd) continue;
      for (const prov of Object.keys(jd)) {
        if (!counts.has(prov)) {
          counts.set(prov, new Map());
          lastSeen.set(prov, new Map());
          drawCounts.set(prov, 0);
        }
        const cm = counts.get(prov);
        const ls = lastSeen.get(prov);
        let provDraws = drawCounts.get(prov);
        for (const type of Object.keys(jd[prov])) {
          const present = (jd[prov][type] || []).filter((n) => n);
          if (!present.length) continue;
          provDraws++;
          totalDraws++;
          for (const n of present) {
            const td = String(n).padStart(2, '0').slice(-2);
            cm.set(td, (cm.get(td) || 0) + 1);
            ls.set(td, provDraws);
          }
        }
        drawCounts.set(prov, provDraws);
      }
    }
    if (i + poolSize < days.length) await sleep(80);
  }

  const loteries = [];
  for (const prov of counts.keys()) {
    const entries = [...counts.get(prov).entries()];
    const map = new Map(entries);
    const top = entries
      .slice()
      .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))
      .slice(0, 5)
      .map(([n, count]) => ({ n, count }));

    const ls = lastSeen.get(prov);
    const totalProv = drawCounts.get(prov) || 0;
    const delayList = [];
    for (let i = 0; i < 100; i++) {
      const key = String(i).padStart(2, '0');
      const gap = totalProv - (ls.has(key) ? ls.get(key) : 0);
      delayList.push([key, gap]);
    }
    const atrasados = delayList
      .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))
      .slice(0, 5)
      .map(([n, atraso]) => ({ n, atraso }));

    if (top.length || atrasados.length) {
      loteries.push({
        province: prov,
        label: PROVINCES[prov] ? PROVINCES[prov].label : prov,
        draws: totalProv,
        top,
        atrasados,
      });
    }
  }
  loteries.sort(
    (a, b) => PROVINCE_ORDER.indexOf(a.province) - PROVINCE_ORDER.indexOf(b.province)
  );

  return {
    weeks,
    range: { from, to: today, days: days.length },
    draws: totalDraws,
    generatedAt: new Date().toISOString(),
    loteries,
  };
}

function handleStats(weeks, res) {
  const key = `stats:${weeks}`;
  const cached = statsCache.get(key);
  if (cached && Date.now() - cached.at < STATS_TTL_MS) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(cached.payload));
    return;
  }

  computeStats(weeks)
    .then((payload) => {
      statsCache.set(key, { at: Date.now(), payload });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    })
    .catch((err) => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'No se pudieron calcular las estadísticas: ' + err.message }));
    });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let relative = decodeURIComponent(urlPath);
  if (relative === '/') relative = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 - No encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/draws') {
    handleApi(url.searchParams.get('date') || todayKey(), res);
    return;
  }
  if (url.pathname === '/api/stats') {
    const weeksRaw = parseInt(url.searchParams.get('weeks') || '6', 10);
    const weeks = Number.isNaN(weeksRaw) ? 6 : Math.min(12, Math.max(1, weeksRaw));
    handleStats(weeks, res);
    return;
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Quiniela por Fecha -> http://localhost:${PORT}`);
});