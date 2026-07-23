const http = require('http');
const fs = require('fs');
const path = require('path');
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
  getCourseMindmap,
  saveCourseMindmap,
  listStudyActivity,
  getStudyDay,
  ASSETS_DIR,
} = require('../notes-db');
const { generateCourseMindmap } = require('../course-mindmap');

const HOST = '127.0.0.1';
const PORT = 39262;
const ROOT = path.join(__dirname, '..');
const HOME_DIR = __dirname;

/** @type {import('http').Server | null} */
let homeServer = null;

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
    filePath = path.join(HOME_DIR, rel);
    if (!filePath.startsWith(HOME_DIR)) {
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
    sendJson(res, 200, { ok: true, service: 'bili-pet-home' });
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/activity/heatmap') {
    const rawUrl = req.url || '';
    const qs = rawUrl.includes('?') ? new URL(rawUrl, 'http://127.0.0.1').searchParams : null;
    const days = qs ? Number(qs.get('days') || 371) : 371;
    const daysList = listStudyActivity({ days });
    const today = getStudyDay();
    const totals = daysList.reduce(
      (acc, row) => {
        acc.studyMs += row.studyMs || 0;
        acc.switchCount += row.switchCount || 0;
        acc.distractCount += row.distractCount || 0;
        acc.interruptCount += row.interruptCount || 0;
        return acc;
      },
      { studyMs: 0, switchCount: 0, distractCount: 0, interruptCount: 0 }
    );
    sendJson(res, 200, {
      ok: true,
      days: daysList,
      today,
      totals,
    });
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

  const courseMindmapMatch = urlPath.match(
    /^\/api\/course-groups\/([^/]+)\/mindmap(?:\/(generate))?$/
  );
  if (courseMindmapMatch) {
    const groupId = decodeURIComponent(courseMindmapMatch[1]);
    const action = courseMindmapMatch[2] || '';

    if (action === 'generate' && req.method === 'POST') {
      await readBody(req);
      try {
        const result = await generateCourseMindmap(groupId);
        if (!result.ok) {
          const map = {
            not_found: '课程组不存在',
            no_items: '课程组还没有视频',
            no_chunks: '组内笔记尚无切块，请先写笔记',
            no_id: '课程组无效',
          };
          sendJson(res, result.error === 'not_found' ? 404 : 400, {
            ok: false,
            message: result.message || map[result.error] || result.error || '生成失败',
          });
          return;
        }
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { ok: false, message: String(err.message || err) });
      }
      return;
    }

    if (!action && req.method === 'GET') {
      const result = getCourseMindmap(groupId);
      if (!result.ok) {
        sendJson(res, result.error === 'not_found' ? 404 : 400, {
          ok: false,
          message:
            result.error === 'not_found' ? '课程组不存在' : result.error || '读取失败',
        });
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (!action && req.method === 'PUT') {
      try {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};
        const result = saveCourseMindmap(
          groupId,
          data.mindmapMd != null ? data.mindmapMd : data.mindmap_md
        );
        if (!result.ok) {
          sendJson(res, result.error === 'not_found' ? 404 : 400, {
            ok: false,
            message:
              result.error === 'not_found' ? '课程组不存在' : result.error || '保存失败',
          });
          return;
        }
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { ok: false, message: String(err.message || err) });
      }
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

function createHomeServer() {
  return http.createServer(async (req, res) => {
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
}

function listenHomeServer() {
  return new Promise((resolve, reject) => {
    const server = createHomeServer();
    const onError = (err) => {
      server.off('listening', onListening);
      try {
        server.close();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      homeServer = server;
      console.log(`[bili-pet] home listening on http://${HOST}:${PORT}`);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, HOST);
  });
}

/** 杀掉占用 home 端口、且不是当前进程的残留监听（常见于异常退出后的孤儿 node） */
function freeHomePort() {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = String(out || '')
      .split(/\s+/)
      .map((x) => Number(x))
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
        console.warn(`[bili-pet] freed home port ${PORT} by stopping pid ${pid}`);
      } catch (err) {
        console.warn(
          `[bili-pet] could not stop pid ${pid} on :${PORT}:`,
          err.message || err
        );
      }
    }
    return pids.length > 0;
  } catch {
    return false;
  }
}

function probeHomeServer(timeoutMs = 600) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: HOST,
        port: PORT,
        path: '/api/status',
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(raw || '{}');
            resolve(Boolean(res.statusCode === 200 && data && data.ok));
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function startHomeServer() {
  if (homeServer) return homeServer;

  try {
    return await listenHomeServer();
  } catch (err) {
    if (!err || err.code !== 'EADDRINUSE') throw err;

    // 端口被占：先探测是否已有可用服务；否则清残留再重试一次
    if (await probeHomeServer()) {
      console.warn(
        `[bili-pet] home port ${PORT} already in use; reusing existing server`
      );
      homeServer = { external: true, close: (cb) => cb && cb() };
      return homeServer;
    }

    freeHomePort();
    await new Promise((r) => setTimeout(r, 350));
    try {
      return await listenHomeServer();
    } catch (retryErr) {
      if (retryErr && retryErr.code === 'EADDRINUSE' && (await probeHomeServer())) {
        console.warn(
          `[bili-pet] home port ${PORT} still busy; opening against existing server`
        );
        homeServer = { external: true, close: (cb) => cb && cb() };
        return homeServer;
      }
      throw retryErr;
    }
  }
}

function stopHomeServer() {
  return new Promise((resolve) => {
    if (!homeServer) {
      resolve();
      return;
    }
    const server = homeServer;
    homeServer = null;
    if (server.external) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

module.exports = {
  startHomeServer,
  stopHomeServer,
  probeHomeServer,
  HOME_HOST: HOST,
  HOME_PORT: PORT,
  HOME_URL: `http://${HOST}:${PORT}/`,
};
