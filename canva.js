const { app, BrowserWindow, ipcMain, globalShortcut, screen, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { startBridgeServer } = require('./bridge-server');
const { loadEnv } = require('./load-env');
const { createNotesOrganizer, chatCompletion } = require('./llm');
const { getSystemPrompt } = require('./prompts');
const { tryHandleCourseChat } = require('./course-actions');
const {
  closeNotesDb,
  loadNoteDoc,
  saveNoteDoc,
  saveNoteAsset,
  searchNoteChunks,
  listNoteDocs,
  ASSETS_DIR,
} = require('./notes-db');

loadEnv(path.join(__dirname, '.env'));

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bilinotes',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);

function mimeFromExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'gif') return 'image/gif';
  if (e === 'webp') return 'image/webp';
  if (e === 'svg') return 'image/svg+xml';
  return 'image/png';
}

function resolveBilinotesUrl(requestUrl) {
  const u = new URL(requestUrl);
  // bilinotes://asset/<bvid>/<file>
  const parts = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  if (u.hostname !== 'asset' || parts.length < 2) return null;
  const rel = parts.map((p) => decodeURIComponent(p)).join(path.sep);
  const full = path.normalize(path.join(ASSETS_DIR, rel));
  const root = path.normalize(ASSETS_DIR + path.sep);
  if (full !== path.normalize(ASSETS_DIR) && !full.startsWith(root)) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}
const PID_FILE = path.join(__dirname, '.bili-pet.pid');

const PET_WINDOW = { width: 160, height: 180 };

const LAUNCHER_HOME = 'http://127.0.0.1:39262/';

let mainWindow;
let notesWindow = null;
let chatWindow = null;
let homeWindow = null;
let bridgeServer;
let latestEvent = null;
/** 本片最完整的跟播快照（供一键整理用，不因 heartbeat 变瘦） */
let noteContext = null;
let notesOrganizer = null;

const MAX_NOTE_ASSET_BYTES = 8 * 1024 * 1024;

/** ⌘D / ⌘O 近同时按下 → 结束学习 */
let lastChordD = 0;
let lastChordO = 0;
const CHORD_MS = 500;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function writePidFile() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch (err) {
    console.error('[bili-pet] failed to write pid file:', err.message || err);
  }
}

function clearPidFile() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

/** 关闭前先让宠物窗播 closing.mp3，播完再真正退出 */
let allowQuit = false;
let closingSoundPending = false;

function quitAfterClosingSound() {
  if (allowQuit) {
    app.quit();
    return;
  }
  if (closingSoundPending) return;
  closingSoundPending = true;

  const finish = () => {
    if (allowQuit) return;
    allowQuit = true;
    closingSoundPending = false;
    clearPidFile();
    app.quit();
  };

  if (!mainWindow || mainWindow.isDestroyed()) {
    finish();
    return;
  }

  const fallback = setTimeout(finish, 5000);
  ipcMain.once('pet:closing-finished', () => {
    clearTimeout(fallback);
    finish();
  });
  mainWindow.webContents.send('pet:closing');
}

function endStudy() {
  quitAfterClosingSound();
}

async function launcherReachable() {
  try {
    const res = await fetch(`${LAUNCHER_HOME}api/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 若未跑 npm run launcher，则后台拉起 launcher/server.js */
async function ensureLauncherRunning() {
  if (await launcherReachable()) return true;

  const script = path.join(__dirname, 'launcher', 'server.js');
  const candidates = ['node', '/usr/local/bin/node', '/opt/homebrew/bin/node'];
  let started = false;
  for (const bin of candidates) {
    try {
      const child = spawn(bin, [script], {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.on('error', () => {});
      child.unref();
      started = true;
      break;
    } catch {
      // try next
    }
  }
  if (!started) return false;

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await launcherReachable()) return true;
  }
  return false;
}

function homePageBounds() {
  const anchor =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getBounds()
      : { x: 0, y: 0, width: 1, height: 1 };
  const { workArea } = screen.getDisplayMatching(anchor);
  const width = Math.min(1100, Math.max(860, Math.round(workArea.width * 0.72)));
  const height = Math.min(760, Math.max(560, Math.round(workArea.height * 0.78)));
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}

/** 主页弹窗：打开 launcher，宠物保持显示；仅 ⌘D+O 结束进程 */
async function goHome() {
  const ok = await ensureLauncherRunning();
  if (!ok) {
    console.warn('[bili-pet] launcher 未能启动，请先执行 npm run launcher');
    return { ok: false, launcher: false, error: 'launcher_unavailable' };
  }

  if (homeWindow && !homeWindow.isDestroyed()) {
    homeWindow.focus();
    return { ok: true, focused: true, launcher: true };
  }

  const bounds = homePageBounds();
  homeWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minWidth: 720,
    minHeight: 480,
    hasShadow: true,
    backgroundColor: '#f4efe6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  homeWindow.loadURL(LAUNCHER_HOME);
  homeWindow.on('closed', () => {
    homeWindow = null;
  });

  return { ok: true, opened: true, launcher: true };
}

function registerStopChord() {
  // 学习期间占用 ⌘D / ⌘O：两者在短时间内先后触发即结束（≈ ⌘+D+O）
  const okD = globalShortcut.register('CommandOrControl+D', () => {
    lastChordD = Date.now();
    if (lastChordD - lastChordO <= CHORD_MS) endStudy();
  });
  const okO = globalShortcut.register('CommandOrControl+O', () => {
    lastChordO = Date.now();
    if (lastChordO - lastChordD <= CHORD_MS) endStudy();
  });
  if (!okD || !okO) {
    console.warn('[bili-pet] failed to register ⌘D+O stop chord');
  }
}

function registerChatShortcut() {
  const ok = globalShortcut.register('CommandOrControl+C', () => {
    openChatWindow();
  });
  if (!ok) {
    console.warn('[bili-pet] failed to register ⌘C chat shortcut');
  }
}

function notesPageBounds() {
  const anchor =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getBounds()
      : { x: 0, y: 0, width: 1, height: 1 };
  const { workArea } = screen.getDisplayMatching(anchor);
  const width = Math.min(820, Math.max(640, Math.round(workArea.width * 0.55)));
  const height = Math.min(680, Math.max(480, Math.round(workArea.height * 0.7)));
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}

function chatPageBounds() {
  const anchor =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getBounds()
      : { x: 0, y: 0, width: 1, height: 1 };
  const { workArea } = screen.getDisplayMatching(anchor);
  const width = Math.min(520, Math.max(420, Math.round(workArea.width * 0.36)));
  const height = Math.min(640, Math.max(480, Math.round(workArea.height * 0.62)));
  // 放在宠物右侧，避免完全挡住
  const pet = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  let x = Math.round(workArea.x + (workArea.width - width) / 2);
  let y = Math.round(workArea.y + (workArea.height - height) / 2);
  if (pet) {
    x = Math.min(workArea.x + workArea.width - width - 16, pet.x + pet.width + 12);
    y = Math.max(workArea.y + 16, Math.min(pet.y, workArea.y + workArea.height - height - 16));
  }
  return { width, height, x, y };
}

function eventBvid(ev) {
  return ev?.bvid || ev?.modelInput?.video?.bvid || null;
}

function currentBvidFromEvent(ev = latestEvent) {
  return eventBvid(ev) || eventBvid(noteContext);
}

function currentVideoMeta() {
  const bvid = currentBvidFromEvent();
  const title =
    latestEvent?.title ||
    latestEvent?.modelInput?.video?.title ||
    noteContext?.title ||
    noteContext?.modelInput?.video?.title ||
    '';
  return {
    bvid: bvid || null,
    title: String(title || '').trim(),
  };
}

function updateNoteContext(payload) {
  if (!payload?.kind) return;
  const kind = String(payload.kind);
  if (kind.startsWith('notes_') || kind === 'llm_reply') return;

  const bvid = eventBvid(payload);
  const prevBvid = eventBvid(noteContext);
  const transcript = String(payload.transcriptText || '').trim();
  const fullSubtitle = String(payload.fullSubtitleText || '').trim();
  const contextText = String(
    payload.contextText ||
      payload.modelInput?.context?.text ||
      payload.currentSubtitle?.content ||
      ''
  ).trim();
  const switchedBvid = Boolean(bvid && prevBvid && bvid !== prevBvid);

  // 换片才整表重置；同片二次 session_start（未播完重启）保留字幕快照，否则一键整理会丢上下文
  if (switchedBvid) {
    noteContext = { ...payload };
    return;
  }

  if (kind === 'session_start') {
    if (!noteContext) {
      noteContext = { ...payload };
      return;
    }
    noteContext = {
      ...noteContext,
      ...payload,
      bvid: bvid || noteContext.bvid,
      title: payload.title || noteContext.title,
      sessionId: payload.sessionId || noteContext.sessionId,
      transcriptText: transcript || noteContext.transcriptText,
      fullSubtitleText: fullSubtitle || noteContext.fullSubtitleText,
      contextText: contextText || noteContext.contextText,
      modelInput: payload.modelInput || noteContext.modelInput,
      currentSubtitle: payload.currentSubtitle || noteContext.currentSubtitle,
    };
    return;
  }

  if (!noteContext) {
    noteContext = { ...payload };
    return;
  }

  noteContext = {
    ...noteContext,
    ...payload,
    bvid: bvid || noteContext.bvid,
    title: payload.title || noteContext.title,
    sessionId: payload.sessionId || noteContext.sessionId,
    transcriptText: (() => {
      const next = transcript ? String(payload.transcriptText) : '';
      const prev = String(noteContext.transcriptText || '');
      if (!next) return prev;
      if (!prev) return next;
      // 同片二次启动瞬间可能先推很短的 transcript，勿覆盖已有长串
      return next.length >= prev.length ? next : prev;
    })(),
    fullSubtitleText: fullSubtitle
      ? payload.fullSubtitleText
      : noteContext.fullSubtitleText,
    contextText: contextText
      ? payload.contextText ||
        payload.modelInput?.context?.text ||
        payload.currentSubtitle?.content ||
        noteContext.contextText
      : noteContext.contextText,
    modelInput: payload.modelInput || noteContext.modelInput,
    currentSubtitle: payload.currentSubtitle || noteContext.currentSubtitle,
  };
}

function broadcastPetEvent(payload, opts = {}) {
  const touchLatest = opts.touchLatest !== false;
  const kind = String(payload?.kind || '');
  // 笔记/LLM 旁路事件不得覆盖跟播 latestEvent，否则整理会丢字幕上下文
  const isSideChannel =
    kind.startsWith('notes_') || kind === 'llm_reply';
  if (touchLatest && !isSideChannel) {
    latestEvent = payload;
    updateNoteContext(payload);
  }
  for (const win of [mainWindow, notesWindow, chatWindow, homeWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('pet:event', payload);
    }
  }
}

function openNotesWindow() {
  if (notesWindow && !notesWindow.isDestroyed()) {
    notesWindow.focus();
    return { ok: true, focused: true };
  }

  const bounds = notesPageBounds();
  notesWindow = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minWidth: 640,
    minHeight: 480,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  notesWindow.loadFile(path.join(__dirname, 'note_cornell', 'notes.html'));
  notesWindow.webContents.once('did-finish-load', () => {
    if (latestEvent) {
      notesWindow.webContents.send('pet:event', latestEvent);
    }
    const bvid = currentBvidFromEvent();
    const doc = bvid
      ? notesOrganizer?.loadForBvid?.(bvid) || loadNoteDoc(bvid)
      : null;
    if (doc) {
      notesWindow.webContents.send('pet:event', {
        kind: 'notes_document',
        ts: Date.now(),
        bvid: doc.bvid,
        mode: 'user',
        bodyMd: doc.bodyMd,
        notes: doc.notes,
        title: doc.title,
        fromDb: true,
        status: '已从数据库恢复笔记',
      });
    } else {
      notesWindow.webContents.send('pet:event', {
        kind: 'notes_status',
        ts: Date.now(),
        status: '已打开：手写笔记会实时保存，需要时点「一键整理」',
      });
    }
  });
  notesWindow.on('closed', () => {
    notesWindow = null;
  });

  return { ok: true, opened: true };
}

function openChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.focus();
    return { ok: true, focused: true };
  }

  const bounds = chatPageBounds();
  chatWindow = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minWidth: 380,
    minHeight: 420,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  chatWindow.loadFile(path.join(__dirname, 'chat', 'chat.html'));
  chatWindow.on('closed', () => {
    chatWindow = null;
  });

  return { ok: true, opened: true };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: PET_WINDOW.width,
    height: PET_WINDOW.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile('face.html');

  mainWindow.on('close', (e) => {
    if (allowQuit) return;
    e.preventDefault();
    quitAfterClosingSound();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (notesWindow && !notesWindow.isDestroyed()) {
      notesWindow.close();
    }
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.close();
    }
    if (homeWindow && !homeWindow.isDestroyed()) {
      homeWindow.close();
    }
  });
}

function onBridgeEvent(payload) {
  broadcastPetEvent(payload);
  void notesOrganizer?.maybeHandle(payload);
}

ipcMain.handle('pet:getLatest', () => latestEvent);

ipcMain.handle('pet:openNotesPage', () => openNotesWindow());

ipcMain.handle('pet:openChatPage', () => openChatWindow());

ipcMain.handle('pet:goHome', () => goHome());

/**
 * 用用户问题检索笔记块：优先当前视频，再补全库，去重后最多 5 条。
 * 元问题（篇数/最近一篇/这个视频）额外注入目录或当前笔记正文。
 */
function isNotesMetaQuestion(question) {
  const q = String(question || '');
  return /几篇|多少.*笔记|有没有.*笔记|笔记.*(列表|目录|有哪些|一共)|最近.*(一篇)?笔记|我的笔记|笔记.*(内容|讲了|讲什么)|这个视频.*(讲|关于|内容)|当前.*(视频|笔记)/.test(
    q
  );
}

function formatNotesCatalog(docs, { recentLimit = 5 } = {}) {
  const list = Array.isArray(docs) ? docs : [];
  if (!list.length) return '笔记库为空：目前 0 篇笔记。';
  const recent = list.slice(0, recentLimit);
  const lines = recent.map((d, i) => {
    const preview = String(d.preview || '').trim() || '(空正文)';
    return `${i + 1}. [${d.bvid}] ${d.title || d.bvid}\n${preview}`;
  });
  return `笔记库共 ${list.length} 篇。按更新时间最近 ${recent.length} 篇：\n\n${lines.join('\n\n')}`;
}

function retrieveNotesForChat(question) {
  const q = String(question || '').trim();
  if (!q) return { hits: [], catalogText: '' };

  const seen = new Set();
  const hits = [];
  const currentBvid = currentBvidFromEvent();

  const pushAll = (rows) => {
    for (const row of rows || []) {
      const id = Number(row.id);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      hits.push(row);
      if (hits.length >= 5) break;
    }
  };

  if (currentBvid) {
    pushAll(searchNoteChunks(q, { bvid: currentBvid, limit: 4 }));
  }
  if (hits.length < 5) {
    pushAll(searchNoteChunks(q, { limit: 5 }));
  }

  // 问「这个视频」但 chunk 没命中时，直接塞当前笔记正文前段
  if (
    currentBvid &&
    hits.length === 0 &&
    /这个视频|当前视频|这集|本集|在讲什么|讲了什么/.test(q)
  ) {
    const doc = loadNoteDoc(currentBvid);
    const body = String(doc?.bodyMd || '').trim();
    if (body) {
      hits.push({
        id: -1,
        bvid: currentBvid,
        chunkIndex: 0,
        heading: doc.title || '当前视频笔记',
        text: body.slice(0, 1200),
      });
    }
  }

  let catalogText = '';
  if (isNotesMetaQuestion(q) || hits.length === 0) {
    const docs = listNoteDocs();
    if (docs.length) {
      catalogText = formatNotesCatalog(docs);
      if (/最近/.test(q) && docs[0]) {
        const latest = loadNoteDoc(docs[0].bvid);
        const body = String(latest?.bodyMd || '').trim();
        if (body) {
          catalogText += `\n\n最近一篇全文摘录 [${docs[0].bvid}] ${docs[0].title || ''}：\n${body.slice(0, 1500)}`;
        }
      }
    } else if (isNotesMetaQuestion(q)) {
      catalogText = '笔记库为空：目前 0 篇笔记。';
    }
  }

  return { hits, catalogText };
}

function formatNotesContext(hits) {
  if (!hits.length) return '';
  return hits
    .map((h, i) => {
      const title = h.heading ? ` · ${h.heading}` : '';
      return `${i + 1}. [${h.bvid}${title}]\n${h.text}`;
    })
    .join('\n\n');
}

ipcMain.handle('pet:chat', async (_event, payload = {}) => {
  const raw = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .map((m) => ({ role: m.role, content: String(m.content).trim() }))
    .slice(-20);
  if (!messages.length) return { ok: false, error: 'empty' };

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const question = lastUser?.content || '';

  // 课程组管理指令：优先走 SQLite 结构化操作，再回落到普通笔记问答
  try {
    const courseResult = await tryHandleCourseChat(question, currentVideoMeta(), {
      history: messages,
    });
    if (courseResult?.handled) {
      return {
        ok: true,
        text: courseResult.message || (courseResult.ok ? '已完成' : '操作失败'),
        sources: [],
        courseAction: true,
        needsConfirm: Boolean(courseResult.needsConfirm),
      };
    }
  } catch (err) {
    console.warn('[bili-pet] course chat action failed:', err.message || err);
  }

  const { hits, catalogText } = retrieveNotesForChat(question);
  const chunkContext = formatNotesContext(hits);
  const notesContext = [catalogText, chunkContext].filter(Boolean).join('\n\n');

  const ragBlock = notesContext
    ? `【笔记库检索结果】下面是与用户问题相关的笔记摘录/目录。回答知识库/笔记类问题时，只能依据这些内容，不要编造；摘录不足以回答时明确说「我不知道」。\n\n${notesContext}`
    : '【笔记库检索结果】未检索到相关摘录。若用户在问笔记或知识库内容，请回答「我不知道」；普通闲聊或学习方法类问题可正常简短回复。';

  try {
    const system = getSystemPrompt('chat');
    const history = messages.slice(0, -1);
    const text = await chatCompletion({
      max_tokens: 600,
      timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 20000,
      messages: [
        { role: 'system', content: system },
        { role: 'system', content: ragBlock },
        ...history,
        messages[messages.length - 1],
      ],
    });
    return {
      ok: true,
      text,
      sources: hits
        .filter((h) => Number(h.id) > 0)
        .map((h) => ({
          bvid: h.bvid,
          heading: h.heading || '',
          chunkIndex: h.chunkIndex,
        })),
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('pet:notesLoad', (_event, payload = {}) => {
  const bvid = String(payload.bvid || currentBvidFromEvent() || '').trim();
  if (!bvid) return { ok: false, error: 'no_bvid', doc: null };
  const doc = loadNoteDoc(bvid);
  return { ok: true, bvid, doc };
});

ipcMain.handle('pet:notesSave', (_event, payload = {}) => {
  const bvid = String(payload.bvid || currentBvidFromEvent() || '').trim();
  if (!bvid) return { ok: false, error: 'no_bvid' };
  const doc = saveNoteDoc(bvid, {
    mode: 'user',
    bodyMd: payload.bodyMd,
    title: payload.title,
    sessionId:
      payload.sessionId ??
      noteContext?.sessionId ??
      latestEvent?.sessionId ??
      null,
  });
  notesOrganizer?.loadForBvid?.(bvid);
  return { ok: true, doc };
});

/** 关窗前同步落盘，避免 beforeunload 异步丢笔 */
ipcMain.on('pet:notesSaveSync', (event, payload = {}) => {
  try {
    const bvid = String(payload.bvid || currentBvidFromEvent() || '').trim();
    if (!bvid) {
      event.returnValue = { ok: false, error: 'no_bvid' };
      return;
    }
    const doc = saveNoteDoc(bvid, {
      mode: 'user',
      bodyMd: payload.bodyMd,
      title: payload.title,
      sessionId:
        payload.sessionId ??
        noteContext?.sessionId ??
        latestEvent?.sessionId ??
        null,
    });
    notesOrganizer?.loadForBvid?.(bvid);
    event.returnValue = { ok: true, doc };
  } catch (err) {
    event.returnValue = { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('pet:notesOrganize', async (_event, payload = {}) => {
  const bvid = String(payload.bvid || currentBvidFromEvent() || '').trim();
  if (!bvid) return { ok: false, error: 'no_bvid' };
  if (payload.bodyMd != null) {
    saveNoteDoc(bvid, {
      mode: 'user',
      bodyMd: String(payload.bodyMd),
      title: payload.title,
      sessionId: noteContext?.sessionId ?? latestEvent?.sessionId ?? null,
    });
  }
  const ctx =
    noteContext && eventBvid(noteContext) === bvid
      ? noteContext
      : latestEvent && eventBvid(latestEvent) === bvid
        ? latestEvent
        : noteContext || latestEvent;
  const result = await notesOrganizer?.organizeOnce?.({
    payload: ctx,
    bodyMd: payload.bodyMd,
    bvid,
    title: payload.title || '',
  });
  return result || { ok: false, error: 'organizer_unavailable' };
});

ipcMain.handle('pet:notesSaveAsset', async (_event, payload = {}) => {
  const bvid = String(payload.bvid || currentBvidFromEvent() || '').trim() || '_draft';
  const dataUrl = String(payload.dataUrl || '');
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
  if (!m) return { ok: false, error: 'bad_data_url' };
  const mime = m[1] || 'image/png';
  const ext = mime.includes('jpeg') || mime.includes('jpg')
    ? 'jpg'
    : mime.includes('gif')
      ? 'gif'
      : mime.includes('webp')
        ? 'webp'
        : 'png';
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_NOTE_ASSET_BYTES) {
    return {
      ok: false,
      error: `too_large`,
      maxBytes: MAX_NOTE_ASSET_BYTES,
      size: bytes.length,
    };
  }
  try {
    const asset = saveNoteAsset(bvid, { bytes, ext, mime });
    return {
      ok: true,
      asset: {
        ...asset,
        dataUrl,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('pet:notesAssetDataUrl', (_event, payload = {}) => {
  try {
    const src = String(payload.src || payload.url || '');
    if (!src.startsWith('bilinotes://')) {
      return { ok: false, error: 'not_bilinotes' };
    }
    const full = resolveBilinotesUrl(src);
    if (!full) return { ok: false, error: 'not_found' };
    const buf = fs.readFileSync(full);
    const mime = mimeFromExt(path.extname(full).slice(1));
    return {
      ok: true,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('pet:closeWindow', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});

ipcMain.on('pet:moveBy', (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + (Number(dx) || 0)), Math.round(y + (Number(dy) || 0)));
});

if (gotTheLock) {
  app.whenReady().then(async () => {
    protocol.handle('bilinotes', async (request) => {
      try {
        const full = resolveBilinotesUrl(request.url);
        if (!full) return new Response('Not Found', { status: 404 });
        const data = fs.readFileSync(full);
        const mime = mimeFromExt(path.extname(full).slice(1));
        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(data.length),
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
          },
        });
      } catch (err) {
        console.warn('[bili-pet] bilinotes protocol:', err.message || err);
        return new Response('Bad Request', { status: 400 });
      }
    });

    writePidFile();
    createWindow();
    registerStopChord();
    registerChatShortcut();

    notesOrganizer = createNotesOrganizer({
      onStatus(status) {
        broadcastPetEvent({
          v: 1,
          source: 'bili-pet-llm',
          kind: 'notes_status',
          ts: Date.now(),
          status,
        });
      },
      onUpdate(notes, meta) {
        const doc = meta.doc || null;
        broadcastPetEvent({
          v: 1,
          source: 'bili-pet-llm',
          kind: 'notes_document',
          ts: Date.now(),
          notes,
          bodyMd: doc?.bodyMd || meta.bodyMd || '',
          mode: 'user',
          title: doc?.title || notes?.title || '',
          sessionId: meta.sessionId,
          bvid: meta.bvid,
          final: Boolean(meta.final),
          fromDb: Boolean(meta.fromDb),
          organized: Boolean(meta.organized),
          error: meta.error || null,
        });
      },
      onError(err) {
        console.error('[bili-pet] notes:', err.message || err);
      },
    });
    if (notesOrganizer.enabled) {
      console.log('[bili-pet] notes organizer enabled (manual one-click)');
    }

    try {
      bridgeServer = await startBridgeServer(onBridgeEvent);
    } catch (err) {
      console.error('[bili-pet] bridge failed to start:', err.message || err);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    closeNotesDb();
    clearPidFile();
  });

  app.on('window-all-closed', () => {
    if (bridgeServer) {
      bridgeServer.close();
      bridgeServer = null;
    }
    clearPidFile();
    if (process.platform !== 'darwin') app.quit();
  });
}
