// Minimal CORS-bypass relay. Forwards LLM calls only — no state, no logging of bodies/keys.
// POST /relay  body: { baseUrl: string, path: string, headers: object, body: object }
// Passes headers/body through untouched to `${baseUrl}${path}`.
const http = require('http');

const PORT = process.env.RELAY_PORT || 8787;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST' || req.url !== '/relay') { res.writeHead(404); return res.end('not found'); }

  let chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const { baseUrl, path, headers, body } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const upstream = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(text);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'relay error: ' + err.message } }));
    }
  });
});

server.listen(PORT, () => console.log(`relay listening on http://localhost:${PORT}`));
