const serverless = require('serverless-http');
const express = require('express');
const app = express();

app.get('/api/hola', (req, res) => {
    res.json({ message: 'Hola desde Netlify!' });
});

module.exports.handler = serverless(app);