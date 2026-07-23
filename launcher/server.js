const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const {
  listNoteDocs,
  loadNoteDoc,
  saveNoteDoc,
  deleteNoteDoc,
  searchNotes,
  listCourseGroups,
  getCourseGroup,
  createCourseGroup,
  updateCourseGroup,
  deleteCourseGroup,
  createCourseFolder,
  updateCourseFolder,
  deleteCourseFolder,
  addCourseGroupItem,
  updateCourseGroupItem,
  removeCourseGroupItem,
  ASSETS_DIR,
} = require('../notes-db');

const HOST = '127.0.0.1';
const PORT = 39262;
const ROOT = path.join(__dirname, '..');
const LAUNCHER_DIR = __dirname;
const EXTENSION_DIR = path.join(ROOT, 'internet_extension');
const CHROME_PROFILE = path.join(ROOT, '.chrome-pet-profile');
const PID_FILE = path.join(ROOT, '.bili-pet.pid');
const BILIBILI_URL = 'https://www.bilibili.com';

/** @type {{ pid: number, kill?: Function, killed?: boolean, exitCode?: number | null } | import('child_process').ChildProcess | null} */
let petProcess = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function clearPidFile() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

function findPetPidsViaPgrep() {
  try {
    const out = execFileSync(
      'pgrep',
      ['-f', `electron.*${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`],
      { encoding: 'utf8' }
    );
    return out
      .split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function adoptExistingPet() {
  const fromFile = readPidFile();
  if (fromFile && pidAlive(fromFile)) {
    petProcess = { pid: fromFile };
    return fromFile;
  }

  const found = findPetPidsViaPgrep();
  if (found.length) {
    const pid = found[0];
    petProcess = { pid };
    try {
      fs.writeFileSync(PID_FILE, String(pid), 'utf8');
    } catch {
      // ignore
    }
    return pid;
  }

  if (fromFile) clearPidFile();
  return null;
}

function isPetAlive() {
  if (petProcess && pidAlive(petProcess.pid)) {
    return true;
  }
  if (petProcess && (petProcess.killed || petProcess.exitCode != null)) {
    petProcess = null;
  } else if (petProcess && !pidAlive(petProcess.pid)) {
    petProcess = null;
  }

  const adopted = adoptExistingPet();
  return adopted != null;
}

function statusPayload() {
  const running = isPetAlive();
  return {
    ok: true,
    running,
    petPid: running && petProcess ? petProcess.pid : null,
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
    clearPidFile();
  });
  petProcess = child;

  try {
    fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
  } catch {
    // ignore
  }

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

function killPidTree(pid) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      throw err;
    }
  }
  // 稍后再强杀残留
  setTimeout(() => {
    if (pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }, 800);
}

function stopPet() {
  isPetAlive();
  const pids = new Set();
  if (petProcess && petProcess.pid) pids.add(petProcess.pid);
  const fromFile = readPidFile();
  if (fromFile) pids.add(fromFile);
  for (const pid of findPetPidsViaPgrep()) pids.add(pid);

  if (pids.size === 0) {
    petProcess = null;
    clearPidFile();
    return { stopped: false, message: '宠物未在运行' };
  }

  const errors = [];
  for (const pid of pids) {
    try {
      killPidTree(pid);
    } catch (err) {
      errors.push(`${pid}: ${err.message || err}`);
    }
  }

  petProcess = null;
  clearPidFile();

  if (errors.length && errors.length === pids.size) {
    throw new Error(`终止失败：${errors.join('; ')}`);
  }

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

function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
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

  let filePath;
  if (rel === '/assets' || rel.startsWith('/assets/')) {
    filePath = path.join(ROOT, rel);
    if (!filePath.startsWith(path.join(ROOT, 'assets'))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
  } else if (rel === '/notes-vendor' || rel.startsWith('/notes-vendor/')) {
    const sub = rel.slice('/notes-vendor'.length).replace(/^\/+/, '');
    filePath = path.join(ROOT, 'note_cornell', 'vendor', sub);
    const root = path.join(ROOT, 'note_cornell', 'vendor');
    if (!path.normalize(filePath).startsWith(path.normalize(root + path.sep)) &&
        path.normalize(filePath) !== path.normalize(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
  } else {
    filePath = path.join(LAUNCHER_DIR, rel);
    if (!filePath.startsWith(LAUNCHER_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
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
      // 已在运行时不再重复拉起浏览器
      const chrome = pet.started
        ? startChrome()
        : { status: 'skipped', message: '宠物已在运行，跳过浏览器启动' };
      sendJson(res, 200, {
        ok: true,
        petPid: pet.pid,
        chrome: chrome.status,
        started: pet.started,
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

  if (req.method === 'GET' && urlPath === '/api/notes') {
    sendJson(res, 200, { ok: true, notes: listNoteDocs() });
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/notes/search') {
    const rawUrl = req.url || '';
    const qs = rawUrl.includes('?') ? new URL(rawUrl, 'http://127.0.0.1').searchParams : null;
    const q = qs ? String(qs.get('q') || '') : '';
    const result = searchNotes(q, { limit: 20 });
    sendJson(res, 200, { ok: true, query: q, ...result });
    return;
  }

  const assetMatch = urlPath.match(/^\/api\/notes-assets\/([^/]+)\/([^/]+)$/);
  if (req.method === 'GET' && assetMatch) {
    const bvid = decodeURIComponent(assetMatch[1]);
    const file = decodeURIComponent(assetMatch[2]);
    if (
      !bvid ||
      !file ||
      bvid.includes('..') ||
      file.includes('..') ||
      file.includes('/') ||
      file.includes('\\')
    ) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const full = path.normalize(path.join(ASSETS_DIR, bvid, file));
    const root = path.normalize(ASSETS_DIR + path.sep);
    if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
    return;
  }

  const noteMatch = urlPath.match(/^\/api\/notes\/([^/]+)$/);
  if (noteMatch) {
    const bvid = decodeURIComponent(noteMatch[1]);

    if (req.method === 'GET') {
      const doc = loadNoteDoc(bvid);
      if (!doc) {
        sendJson(res, 404, { ok: false, message: '笔记不存在' });
        return;
      }
      sendJson(res, 200, { ok: true, doc });
      return;
    }

    if (req.method === 'PUT') {
      try {
        const body = await readBody(req, 5e6);
        const data = body ? JSON.parse(body) : {};
        const doc = saveNoteDoc(bvid, {
          mode: 'user',
          bodyMd: data.bodyMd != null ? String(data.bodyMd) : undefined,
          title: data.title != null ? String(data.title) : undefined,
        });
        sendJson(res, 200, { ok: true, doc });
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String(err.message || err) });
      }
      return;
    }

    if (req.method === 'DELETE') {
      const result = deleteNoteDoc(bvid);
      if (!result.ok) {
        sendJson(res, 400, { ok: false, message: result.error || '删除失败' });
        return;
      }
      if (!result.deleted) {
        sendJson(res, 404, { ok: false, message: '笔记不存在' });
        return;
      }
      sendJson(res, 200, { ok: true, bvid: result.bvid });
      return;
    }
  }

  if (req.method === 'GET' && urlPath === '/api/course-groups') {
    sendJson(res, 200, { ok: true, groups: listCourseGroups() });
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/course-groups') {
    try {
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const result = createCourseGroup({
        title: data.title,
        topic: data.topic,
        items: data.items,
        meta: data.meta,
      });
      if (!result.ok) {
        const msg =
          result.error === 'title_required'
            ? '请填写课程组名称'
            : result.error || '创建失败';
        sendJson(res, 400, { ok: false, message: msg });
        return;
      }
      sendJson(res, 200, { ok: true, group: result.group });
    } catch (err) {
      sendJson(res, 400, { ok: false, message: String(err.message || err) });
    }
    return;
  }

  const courseItemMatch = urlPath.match(
    /^\/api\/course-groups\/([^/]+)\/items(?:\/([^/]+))?$/
  );
  if (courseItemMatch) {
    const groupId = decodeURIComponent(courseItemMatch[1]);
    const itemBvid = courseItemMatch[2]
      ? decodeURIComponent(courseItemMatch[2])
      : null;

    if (req.method === 'POST' && !itemBvid) {
      try {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};
        const result = addCourseGroupItem(groupId, {
          bvid: data.bvid || data.url,
          title: data.title,
          ord: data.ord,
          folderId: data.folderId,
        });
        if (!result.ok) {
          if (result.error === 'already_in_group') {
            const moved = updateCourseGroupItem(groupId, data.bvid || data.url, {
              folderId: data.folderId,
              title: data.title,
            });
            if (moved.ok) {
              sendJson(res, 200, {
                ok: true,
                group: moved.group,
                moved: true,
                message: '该笔记已在课程组中，已更新所在文件夹',
              });
              return;
            }
          }
          const map = {
            not_found: '课程组不存在',
            invalid_bvid: '请输入有效的 BV 号或视频链接',
            already_in_group: '该视频已在课程组中',
            no_group: '课程组无效',
            folder_not_found: '文件夹不存在',
          };
          sendJson(res, result.error === 'not_found' ? 404 : 400, {
            ok: false,
            message: map[result.error] || result.error || '添加失败',
          });
          return;
        }
        sendJson(res, 200, { ok: true, group: result.group });
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String(err.message || err) });
      }
      return;
    }

    if (req.method === 'PUT' && itemBvid) {
      try {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(data, 'folderId')) {
          patch.folderId = data.folderId;
        }
        if (Object.prototype.hasOwnProperty.call(data, 'title')) {
          patch.title = data.title;
        }
        const result = updateCourseGroupItem(groupId, itemBvid, patch);
        if (!result.ok) {
          const map = {
            not_found: '视频不在该课程组中',
            invalid_bvid: '无效的 BV 号',
            no_group: '课程组无效',
            folder_not_found: '文件夹不存在',
          };
          sendJson(res, result.error === 'not_found' ? 404 : 400, {
            ok: false,
            message: map[result.error] || result.error || '更新失败',
          });
          return;
        }
        sendJson(res, 200, { ok: true, group: result.group });
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String(err.message || err) });
      }
      return;
    }

    if (req.method === 'DELETE' && itemBvid) {
      const result = removeCourseGroupItem(groupId, itemBvid);
      if (!result.ok) {
        const map = {
          not_found: '视频不在该课程组中',
          invalid_bvid: '无效的 BV 号',
          no_group: '课程组无效',
        };
        sendJson(res, result.error === 'not_found' ? 404 : 400, {
          ok: false,
          message: map[result.error] || result.error || '移除失败',
        });
        return;
      }
      sendJson(res, 200, { ok: true, group: result.group });
      return;
    }
  }

  const courseFolderMatch = urlPath.match(
    /^\/api\/course-groups\/([^/]+)\/folders(?:\/([^/]+))?$/
  );
  if (courseFolderMatch) {
    const groupId = decodeURIComponent(courseFolderMatch[1]);
    const folderId = courseFolderMatch[2]
      ? decodeURIComponent(courseFolderMatch[2])
      : null;

    if (req.method === 'POST' && !folderId) {
      try {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};
        const result = createCourseFolder(groupId, {
          title: data.title,
          ord: data.ord,
        });
        if (!result.ok) {
          const map = {
            not_found: '课程组不存在',
            title_required: '请填写文件夹名称',
            no_group: '课程组无效',
          };
          sendJson(res, result.error === 'not_found' ? 404 : 400, {
            ok: false,
            message: map[result.error] || result.error || '创建失败',
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          folderId: result.folderId,
          group: result.group,
        });
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String(err.message || err) });
      }
      return;
    }

    if (req.method === 'PUT' && folderId) {
      try {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};
        const result = updateCourseFolder(groupId, folderId, {
          title: data.title,
        });
        if (!result.ok) {
          const map = {
            not_found: '文件夹不存在',
            title_required: '请填写文件夹名称',
            no_group: '课程组无效',
            no_folder: '文件夹无效',
          };
          sendJson(res, result.error === 'not_found' ? 404 : 400, {
            ok: false,
            message: map[result.error] || result.error || '更新失败',
          });
          return;
        }
        sendJson(res, 200, { ok: true, group: result.group });
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String(err.message || err) });
      }
      return;
    }

    if (req.method === 'DELETE' && folderId) {
      const result = deleteCourseFolder(groupId, folderId);
      if (!result.ok) {
        const map = {
          not_found: '文件夹不存在',
          no_group: '课程组无效',
          no_folder: '文件夹无效',
        };
        sendJson(res, result.error === 'not_found' ? 404 : 400, {
          ok: false,
          message: map[result.error] || result.error || '删除失败',
        });
        return;
      }
      sendJson(res, 200, { ok: true, group: result.group });
      return;
    }
  }

  const courseMatch = urlPath.match(/^\/api\/course-groups\/([^/]+)$/);
  if (courseMatch) {
    const groupId = decodeURIComponent(courseMatch[1]);

    if (req.method === 'GET') {
      const group = getCourseGroup(groupId);
      if (!group) {
        sendJson(res, 404, { ok: false, message: '课程组不存在' });
        return;
      }
      sendJson(res, 200, { ok: true, group });
      return;
    }

    if (req.method === 'PUT') {
      try {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};
        const result = updateCourseGroup(groupId, {
          title: data.title,
          topic: data.topic,
          meta: data.meta,
        });
        if (!result.ok) {
          const map = {
            not_found: '课程组不存在',
            title_required: '请填写课程组名称',
            no_id: '课程组无效',
          };
          sendJson(res, result.error === 'not_found' ? 404 : 400, {
            ok: false,
            message: map[result.error] || result.error || '更新失败',
          });
          return;
        }
        sendJson(res, 200, { ok: true, group: result.group });
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String(err.message || err) });
      }
      return;
    }

    if (req.method === 'DELETE') {
      const result = deleteCourseGroup(groupId);
      if (!result.ok) {
        sendJson(res, 400, { ok: false, message: result.error || '删除失败' });
        return;
      }
      if (!result.deleted) {
        sendJson(res, 404, { ok: false, message: '课程组不存在' });
        return;
      }
      sendJson(res, 200, { ok: true, id: result.id });
      return;
    }
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
