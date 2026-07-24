const http = require('http');

const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = 39261; //直接放在本地了

/** @type {Array<{ id: string, action: string, bvid?: string, title?: string, ts: number }>} */
const pendingCommands = [];
/** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const commandWaiters = new Map();

function makeCommandId() {
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Queue a command for the browser extension to execute
 * @param {{ action: string, bvid?: string, timeoutMs?: number }} cmd
 */
function enqueueExtensionCommand(cmd) {
  const id = makeCommandId();
  const timeoutMs = Math.max(3000, Number(cmd.timeoutMs) || 20000);
  const item = {
    id,
    action: String(cmd.action || '').trim(),
    bvid: cmd.bvid ? String(cmd.bvid).trim() : undefined,
    ts: Date.now(),
  };
  if (!item.action) {
    return Promise.reject(new Error('action_required'));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      commandWaiters.delete(id);
      // leave orphan command; extension may still ack later (ignored)
      reject(new Error('extension_command_timeout'));
    }, timeoutMs);
    commandWaiters.set(id, { resolve, reject, timer });
    pendingCommands.push(item);
    // Cap queue
    while (pendingCommands.length > 20) {
      const dropped = pendingCommands.shift();
      const w = dropped && commandWaiters.get(dropped.id);
      if (w) {
        clearTimeout(w.timer);
        commandWaiters.delete(dropped.id);
        w.reject(new Error('extension_command_dropped'));
      }
    }
  });
}

function resolveExtensionCommand(result) {
  const id = String(result?.id || '').trim();
  if (!id) return false;
  const waiter = commandWaiters.get(id);
  // Remove from pending if still there
  const idx = pendingCommands.findIndex((c) => c.id === id);
  if (idx >= 0) pendingCommands.splice(idx, 1);

  if (!waiter) return false;
  clearTimeout(waiter.timer);
  commandWaiters.delete(id);
  waiter.resolve({
    ok: Boolean(result?.ok),
    message: String(result?.message || ''),
    error: result?.error || null,
    data: result?.data || null,
  });
  return true;
}

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

    const urlPath = String(req.url || '').split('?')[0];

    if (req.method === 'GET' && (urlPath === '/health' || urlPath === '/')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'bili-pet-bridge' }));
      return;
    }

    // Extension polls this for B站侧写操作
    if (req.method === 'GET' && urlPath === '/commands') {
      const batch = pendingCommands.splice(0, pendingCommands.length);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, commands: batch }));
      return;
    }

    if (req.method === 'POST' && urlPath === '/commands/result') {
      try {
        const body = await readBody(req);
        const payload = body ? JSON.parse(body) : null;
        if (!payload || typeof payload !== 'object') {
          res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
        resolveExtensionCommand(payload);
        // Also fan-out as bridge event for logging / UI
        try {
          onEvent?.({
            v: 1,
            source: 'bili-pet-extension',
            kind: 'bili_action_result',
            ts: Date.now(),
            ...payload,
          });
        } catch {
          /* ignore */
        }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
      return;
    }

    if (req.method === 'POST' && urlPath === '/event') {
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
} //启动连接函数

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
} //读请求体格式函数

module.exports = {
  startBridgeServer,
  enqueueExtensionCommand,
  resolveExtensionCommand,
  BRIDGE_HOST,
  BRIDGE_PORT,
};
