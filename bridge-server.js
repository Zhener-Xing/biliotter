const http = require('http');

const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = 39261;//直接放在本地了

function startBridgeServer(onEvent) {
  const server = http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'bili-pet-bridge' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/event') {
      try {
        const body = await readBody(req);
        const payload = body ? JSON.parse(body) : null;
        if (!payload || typeof payload !== 'object') {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        onEvent?.(payload);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
      return;
    }

    res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
      console.log(`[bili-pet] bridge listening on http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
      resolve(server);
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = { startBridgeServer, BRIDGE_HOST, BRIDGE_PORT };
