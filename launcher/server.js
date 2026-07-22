const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 39262;
const ROOT = path.join(__dirname, '..');
const LAUNCHER_DIR = __dirname;
const EXTENSION_DIR = path.join(ROOT, 'internet_extension');
const CHROME_PROFILE = path.join(ROOT, '.chrome-pet-profile');
const BILIBILI_URL = 'https://www.bilibili.com';

/** @type {import('child_process').ChildProcess | null} */
let petProcess = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function isPetAlive() {
  if (!petProcess || petProcess.killed || petProcess.exitCode != null) {
    petProcess = null;
    return false;
  }
  try {
    process.kill(petProcess.pid, 0);
    return true;
  } catch {
    petProcess = null;
    return false;
  }
}

function statusPayload() {
  const running = isPetAlive();
  return {
    ok: true,
    running,
    petPid: running ? petProcess.pid : null,
    message: running ? '运行中' : '未运行',
  };
}

function findElectronBin() {
  const local = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (fs.existsSync(local)) return local;
  return null;
}

function findChromeBin() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

function startPet() {
  if (isPetAlive()) {
    return { started: false, pid: petProcess.pid, message: '宠物已在运行' };
  }

  const electronBin = findElectronBin();
  if (!electronBin) {
    throw new Error('未找到 electron，请先在项目根目录执行 npm install');
  }

  const child = spawn(electronBin, ['.'], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  child.on('exit', () => {
    if (petProcess === child) petProcess = null;
  });
  petProcess = child;

  return { started: true, pid: child.pid, message: '宠物已启动' };
}

function startChrome() {
  const chromeBin = findChromeBin();
  if (!chromeBin) {
    return { status: 'skipped', message: '未找到 Chrome / Edge / Chromium，请手动加载扩展' };
  }

  if (!fs.existsSync(EXTENSION_DIR)) {
    return { status: 'skipped', message: '扩展目录不存在：internet_extension' };
  }

  fs.mkdirSync(CHROME_PROFILE, { recursive: true });

  const args = [
    `--user-data-dir=${CHROME_PROFILE}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    BILIBILI_URL,
  ];

  const child = spawn(chromeBin, args, {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  return { status: 'started', message: '已打开带扩展的浏览器' };
}

function stopPet() {
  if (!isPetAlive()) {
    petProcess = null;
    return { stopped: false, message: '宠物未在运行' };
  }

  const pid = petProcess.pid;
  try {
    // 杀进程组，避免残留子进程
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      process.kill(pid, 'SIGTERM');
    }
  } catch (err) {
    petProcess = null;
    throw new Error(`终止失败：${err.message || err}`);
  }

  petProcess = null;
  return { stopped: true, message: '已终止宠物' };
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  if (rel.includes('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const filePath = path.join(LAUNCHER_DIR, rel);
  if (!filePath.startsWith(LAUNCHER_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, urlPath) {
  if (req.method === 'GET' && urlPath === '/api/status') {
    sendJson(res, 200, statusPayload());
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/start') {
    await readBody(req);
    try {
      const pet = startPet();
      const chrome = startChrome();
      sendJson(res, 200, {
        ok: true,
        petPid: pet.pid,
        chrome: chrome.status,
        message: `${pet.message}；${chrome.message}`,
        running: true,
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, message: String(err.message || err), running: isPetAlive() });
    }
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/stop') {
    await readBody(req);
    try {
      const result = stopPet();
      sendJson(res, 200, {
        ok: true,
        ...result,
        running: false,
        petPid: null,
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, message: String(err.message || err), running: isPetAlive() });
    }
    return;
  }

  sendJson(res, 404, { ok: false, message: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath.startsWith('/api/')) {
    try {
      await handleApi(req, res, urlPath);
    } catch (err) {
      sendJson(res, 500, { ok: false, message: String(err.message || err) });
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, urlPath);
    return;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`[launcher] ${url}`);

  if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
});
