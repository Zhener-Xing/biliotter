const { app, BrowserWindow, ipcMain, globalShortcut, screen, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { initAppPaths, dataPath, ensureEnvFile } = require('./paths');
const { loadEnv } = require('./load-env');

// Writable data must resolve before DB / token / cookie modules load.
app.setName('BiliOtter');
initAppPaths(app);
ensureEnvFile();
loadEnv(dataPath('.env'));

const { startBridgeServer } = require('./bridge-server');
const { startHomeServer, stopHomeServer, HOME_URL } = require('./launcher/server');
const { createNotesOrganizer, chatCompletion } = require('./llm');
const { getSystemPrompt } = require('./prompts');
const { tryHandleCourseChat } = require('./course-actions');
const {
  tryHandleGameChat,
  answerGame,
  stopGame,
  isPlaying,
  isActive: isGameActive,
  setPetNotifier,
} = require('./skills/game-quiz');
const { tryHandlePlanChat, learningPlanSkill } = require('./skills/learning-plan');
const { handleAccountPayload, loadAccount, saveAccount, clearBinding, commitBinding } = require('./account-bind');
const {
  closeNotesDb,
  loadNoteDoc,
  saveNoteDoc,
  saveNoteAsset,
  searchNoteChunks,
  listNoteDocs,
  addStudyMs,
  addSwitchCount,
  addDistractCount,
  normalizeBvid,
  setActiveUid,
  getActiveUid,
  getAssetsDir,
} = require('./notes-db');
const {
  startCloudSync,
  onAccountReady,
  flushAndPurgeUid,
  handleAuthCookiePayload,
  flushBeforeQuit,
  stopCloudSync,
  cloudEnabled,
  scheduleBackgroundPurge,
  sweepOrphanLocalStores,
  loadTokenForUid,
} = require('./cloud-sync');
const {
  startFriendsCloud,
  stopFriendsCloud,
  listFriends,
  getInvite,
  createInvite,
  cancelInvite,
  joinInvite,
  removeFriend,
  petFriend,
  shareNote,
  listNoteInbox,
  acceptNoteShare,
  rejectNoteShare,
} = require('./friends-cloud');
const {
  touchExtensionPresence,
  isExtensionAlive,
  pollExtensionPresence,
  setPresenceChangeHandler,
} = require('./extension-presence');
const {
  setAccountOpsReady,
  isAccountOpsReady,
  gateMessage,
} = require('./session-gate');
const { setBiliCookieHeader, getBiliCookieHeader } = require('./bili-web-api');

function rememberBiliCookieFromPayload(payload) {
  const cookie =
    payload?.cookieHeader ||
    payload?.cookie ||
    payload?.account?.cookieHeader ||
    '';
  if (cookie) setBiliCookieHeader(cookie);
}
const STUDY_SWITCH_REASONS = new Set([
  'pagehide',
  'tab_hidden',
  'window_blur',
  'route_change',
  'switch_bvid',
]);

/** 知识区 / 学习相关分区（与扩展侧保持一致） */
const STUDY_ZONE_TIDS = new Set([
  36, 201, 124, 228, 207, 208, 209, 229, 122, 39, 96, 98,
  1010, 2084, 2085, 2086, 2087, 2088, 2089, 2090, 2091, 2092, 2093, 2094, 2095,
]);
const STUDY_ZONE_RE = /学习|知识|课堂/;

let studyClock = null;
const STUDY_CREDIT_CAP_MS = 10_000;
/** Serialize account switch / bind so overlapping hellos cannot clobber the active DB. */
let accountOpChain = Promise.resolve();
let accountOpSeq = 0;
/** Prevent heartbeat from restarting an in-flight first-pull for the same uid. */
let accountReadyInFlightUid = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bilinotes',//自定义协议地址，所有保存的截图都在本地寻找
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);//加载.env文件

function mimeFromExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'gif') return 'image/gif';
  if (e === 'webp') return 'image/webp';
  if (e === 'svg') return 'image/svg+xml';
  return 'image/png';
}//根据文件扩展名返回对应图片文件

function resolveBilinotesUrl(requestUrl) {
  const u = new URL(requestUrl);
  const parts = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  if (u.hostname !== 'asset' || parts.length < 2) return null;
  const rel = parts.map((p) => decodeURIComponent(p)).join(path.sep);
  const assetsRoot = getAssetsDir();
  const full = path.normalize(path.join(assetsRoot, rel));
  const root = path.normalize(assetsRoot + path.sep);
  if (full !== path.normalize(assetsRoot) && !full.startsWith(root)) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}//拼接url，把协议地址转化为真实地址
function pidFile() {
  return dataPath('.bili-pet.pid');
}

const PET_WINDOW = { width: 160, height: 180 };

const HOME_PAGE = HOME_URL;

let mainWindow;
let notesWindow = null;
let chatWindow = null;
let homeWindow = null;
let friendsWindow = null;
let bridgeServer;
let homeServer;
let latestEvent = null;
let noteContext = null;
let notesOrganizer = null;

const MAX_NOTE_ASSET_BYTES = 8 * 1024 * 1024;

let lastChordD = 0;
let lastChordC = 0;
let lastChordO = 0;
let lastChordS = 0;
let lastChordG = 0;
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
}//electron一次一个进程

function writePidFile() {
  try {
    fs.writeFileSync(pidFile(), String(process.pid), 'utf8');
  } catch (err) {
    console.error('[bili-pet] failed to write pid file:', err.message || err);
  }
}//写入PID，记录宠物运行状态

function clearPidFile() {
  try {
    if (fs.existsSync(pidFile())) fs.unlinkSync(pidFile());
  } catch {
  }
}//清除PID

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

  const runFinish = async () => {
    try {
      await flushBeforeQuit();
    } catch (err) {
      console.warn('[bili-pet] quit flush failed:', err.message || err);
    }
    finish();
  };

  if (!mainWindow || mainWindow.isDestroyed()) {
    void runFinish();
    return;
  }

  const fallback = setTimeout(() => {
    void runFinish();
  }, 5000);
  ipcMain.once('pet:closing-finished', () => {
    clearTimeout(fallback);
    void runFinish();
  });
  mainWindow.webContents.send('pet:closing');
}//在播放完音频后终止进程函数

function endStudy() {
  quitAfterClosingSound();
}//调用结束函数，没啥用但是接口在这里，修改的时候不要动

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
}//建立画布

async function goHome(opts = {}) {
  const raw =
    opts && typeof opts === 'object'
      ? opts.bvid || opts.noteBvid || ''
      : opts;
  const bvid = normalizeBvid(raw);

  if (!homeServer) {
    try {
      homeServer = await startHomeServer();
    } catch (err) {
      console.warn('[bili-pet] home server failed:', err.message || err);
      return { ok: false, error: 'home_unavailable' };
    }
  }

  const homeUrl = bvid
    ? `${HOME_URL}?bvid=${encodeURIComponent(bvid)}`
    : HOME_URL;

  if (homeWindow && !homeWindow.isDestroyed()) {
    homeWindow.focus();
    if (bvid) {
      homeWindow.webContents.send('pet:openHomeNote', { bvid });
    }
    return { ok: true, focused: true, bvid: bvid || null };
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

  homeWindow.loadURL(homeUrl);
  homeWindow.on('closed', () => {
    homeWindow = null;
  });

  return { ok: true, opened: true, bvid: bvid || null };
}//返回主页，现在是调用知识库函数，是接口，不要随便修改

function registerStopChord() {
  const okD = globalShortcut.register('CommandOrControl+D', () => {
    lastChordD = Date.now();
    if (lastChordD - lastChordO <= CHORD_MS) endStudy();
  });
  const okO = globalShortcut.register('CommandOrControl+O', () => {
    lastChordO = Date.now();
    if (lastChordO - lastChordD <= CHORD_MS) endStudy();
    else if (lastChordO - lastChordC <= CHORD_MS) openChatWindow();
  });
  if (!okD || !okO) {
    console.warn('[bili-pet] failed to register ⌘D+O stop chord');
  }
}//注册结束快捷键，撂在这里就行

function notifyGameStopped(message) {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.send('pet:gameStopped', {
      message: message || '已退出答题模式。',
    });
    chatWindow.focus();
  }
}

function setMainPetHidden(hidden) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (hidden) {
    if (mainWindow.isVisible()) mainWindow.hide();
  } else if (!mainWindow.isVisible()) {
    if (typeof mainWindow.showInactive === 'function') mainWindow.showInactive();
    else mainWindow.show();
  }
}

function wireGamePetNotifier() {
  setPetNotifier((kind, extra = {}) => {
    const payload = { kind, ts: Date.now(), source: 'game-quiz', ...extra };
    if (kind === 'game_play_start') {
      setMainPetHidden(true);
    } else if (kind === 'game_play_end') {
      setMainPetHidden(false);
    }
    for (const win of [mainWindow, chatWindow]) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('pet:event', payload);
      }
    }
  });
}

function stopGameQuizFromChord() {
  if (!isGameActive()) return;
  const result = stopGame();
  notifyGameStopped(result.message);
}

function registerGameStopChord() {
  const okS = globalShortcut.register('CommandOrControl+S', () => {
    lastChordS = Date.now();
    if (lastChordS - lastChordG <= CHORD_MS) stopGameQuizFromChord();
  });
  const okG = globalShortcut.register('CommandOrControl+G', () => {
    lastChordG = Date.now();
    if (lastChordG - lastChordS <= CHORD_MS) stopGameQuizFromChord();
  });
  if (!okS || !okG) {
    console.warn('[bili-pet] failed to register ⌘S+G game-stop chord');
  }
}

function registerChatShortcut() {
  const ok = globalShortcut.register('CommandOrControl+C', () => {
    lastChordC = Date.now();
    if (lastChordC - lastChordO <= CHORD_MS) openChatWindow();
  });
  if (!ok) {
    console.warn('[bili-pet] failed to register ⌘C+O chat chord');
  }
}//注册打开对话快捷键

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
}//笔记本页面设置，是一个我觉得相对合理的尺寸

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
}//对话框页面设置

function friendsPageBounds() {
  const anchor =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getBounds()
      : { x: 0, y: 0, width: 1, height: 1 };
  const { workArea } = screen.getDisplayMatching(anchor);
  const width = Math.min(480, Math.max(400, Math.round(workArea.width * 0.34)));
  const height = Math.min(720, Math.max(560, Math.round(workArea.height * 0.68)));
  const pet = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  let x = Math.round(workArea.x + (workArea.width - width) / 2);
  let y = Math.round(workArea.y + (workArea.height - height) / 2);
  if (pet) {
    x = Math.max(workArea.x + 16, pet.x - width - 12);
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
  return{
    bvid: bvid || null,
    title: String(title || '').trim(),
  };
}//自取上述各种取数函数

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
}//笔记更新逻辑函数，不是接口

function broadcastPetEvent(payload, opts = {}) {
  const touchLatest = opts.touchLatest !== false;
  const kind = String(payload?.kind || '');
  const isSideChannel =
    kind.startsWith('notes_') || kind === 'llm_reply';
  if (touchLatest && !isSideChannel) {
    latestEvent = payload;
    updateNoteContext(payload);
  }
  for (const win of [mainWindow, notesWindow, chatWindow, homeWindow, friendsWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('pet:event', payload);
    }
  }
}//？谁都不知道啥时候修的函数

function openNotesWindow() {
  const gate = requireBoundAccount();
  if (!gate.ok) {
    notifyGateBlocked(gate.error, 'open_notes');
    return { ok: false, error: gate.error || 'not_bound', message: gateMessage(gate.error) };
  }

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
        status: '已恢复笔记',
      });
    } else {
      notesWindow.webContents.send('pet:event', {
        kind: 'notes_status',
        ts: Date.now(),
        status: '已打开笔记',
      });
    }
  });
  notesWindow.on('closed', () => {
    notesWindow = null;
  });

  return { ok: true, opened: true };
}//打开笔记函数

function openChatWindow() {
  const gate = requireBoundAccount();
  if (!gate.ok) {
    notifyGateBlocked(gate.error, 'open_chat');
    return { ok: false, error: gate.error || 'not_bound', message: gateMessage(gate.error) };
  }

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
    if (isGameActive()) {
      stopGame();
    }
  });

  return { ok: true, opened: true };
}//打开聊天页面，不用管它

function openFriendsWindow() {
  const gate = requireBoundAccount();
  if (!gate.ok) {
    notifyGateBlocked(gate.error, 'open_friends');
    return { ok: false, error: gate.error || 'not_bound', message: gateMessage(gate.error) };
  }
  if (!cloudEnabled()) {
    notifyGateBlocked('cloud_disabled', 'open_friends');
    return {
      ok: false,
      error: 'cloud_disabled',
      message: '未配置云端，无法使用好友功能',
    };
  }

  if (friendsWindow && !friendsWindow.isDestroyed()) {
    friendsWindow.focus();
    return { ok: true, focused: true };
  }

  const bounds = friendsPageBounds();
  friendsWindow = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minWidth: 380,
    minHeight: 480,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  friendsWindow.loadFile(path.join(__dirname, 'friends', 'friends.html'));
  friendsWindow.on('closed', () => {
    friendsWindow = null;
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
    if (friendsWindow && !friendsWindow.isDestroyed()) {
      friendsWindow.close();
    }
  });
}//窗口创建管理函数

function isStudyRelatedPayload(payload = {}) {
  if (typeof payload.studyRelated === 'boolean') return payload.studyRelated;
  const tid = Number(payload.tid);
  const tidV2 = Number(payload.tid_v2 ?? payload.tidV2);
  if (STUDY_ZONE_TIDS.has(tid) || STUDY_ZONE_TIDS.has(tidV2)) return true;
  const labels = [payload.tname, payload.tname_v2 ?? payload.tnameV2]
    .map((s) => String(s || ''))
    .join(' ');
  return STUDY_ZONE_RE.test(labels);
}

function flushStudyClock(at = Date.now()) {
  if (!studyClock || studyClock.paused || !studyClock.studyRelated) return;
  const delta = Math.max(0, at - studyClock.lastAt);
  if (delta > 0) {
    addStudyMs(Math.min(delta, STUDY_CREDIT_CAP_MS), at);
  }
  studyClock.lastAt = at;
}//活跃度函数，简单的设计，不要碰

function applyStudyRelated(payload, now) {
  if (!studyClock) return;
  const hasHint =
    typeof payload.studyRelated === 'boolean' ||
    payload.tid != null ||
    payload.tid_v2 != null ||
    payload.tname ||
    payload.tname_v2;
  if (!hasHint) return;
  const related = isStudyRelatedPayload(payload);
  if (related && !studyClock.studyRelated) {
   
    studyClock.lastAt = now;
  }
  studyClock.studyRelated = related;
}

function recordStudyActivity(payload) {
  if (!payload?.kind) return;
  const bound = requireBoundAccount();
  if (!bound.ok) return;
  const kind = String(payload.kind);
  if (kind.startsWith('notes_') || kind === 'llm_reply') return;

  const now = Number(payload.ts) || Date.now();

  if (kind === 'session_start') {
    studyClock = {
      sessionId: payload.sessionId || null,
      lastAt: now,
      paused: false,
      studyRelated: false,
    };
    return;
  }

  if (kind === 'progress' || kind === 'heartbeat' || kind === 'session_meta') {
    const paused = Boolean(payload.paused);
    if (!studyClock) {
      studyClock = {
        sessionId: payload.sessionId || null,
        lastAt: now,
        paused,
        studyRelated: isStudyRelatedPayload(payload),
      };
      return;
    }
    applyStudyRelated(payload, now);
    if (paused) {
      flushStudyClock(now);
      studyClock.paused = true;
      return;
    }
    if (!studyClock.paused) flushStudyClock(now);
    else studyClock.lastAt = now;
    studyClock.paused = false;
    return;
  }

  if (kind === 'focus_break') {
    const reason = payload.detail?.reason || payload.reason;
    const breakType = payload.type;
    if (breakType === 'ui_scroll' || reason === 'scroll') {
      addDistractCount(1, now);
      return;
    }
    if (breakType === 'exit_video' || STUDY_SWITCH_REASONS.has(reason)) {
      addSwitchCount(1, now);
      flushStudyClock(now);
      if (studyClock) studyClock.paused = true;
    }
    return;
  }

  if (kind === 'focus_resume') {
    if (studyClock) {
      studyClock.paused = false;
      studyClock.lastAt = now;
    }
    return;
  }

  if (kind === 'session_end') {
    flushStudyClock(now);
    studyClock = null;
  }
}//专注力函数，容忍度已经完成修改

function requireBoundAccount() {
  const uid = getActiveUid();
  const acc = loadAccount();
  if (!isExtensionAlive()) {
    return { ok: false, error: 'extension_offline' };
  }
  if (!uid || !acc.sessionLoggedIn) {
    return { ok: false, error: 'not_bound' };
  }
  return { ok: true, uid };
}

function notifyGateBlocked(error, via = 'gate') {
  const err = error || 'not_bound';
  broadcastPetEvent(
    {
      v: 1,
      source: 'bili-pet',
      kind: 'pet_gate_blocked',
      ts: Date.now(),
      ok: false,
      error: err,
      message: gateMessage(err),
      via,
    },
    { touchLatest: false }
  );
}

function closeAccountWindows() {
  for (const win of [notesWindow, chatWindow, homeWindow, friendsWindow]) {
    if (win && !win.isDestroyed()) {
      try {
        win.close();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

function lockLocalSession(reason = 'locked') {
  setAccountOpsReady(false);
  const acc = loadAccount();
  if (acc.sessionLoggedIn) {
    saveAccount({
      sessionLoggedIn: false,
      lastSeenAt: Date.now(),
    });
  }
  if (getActiveUid()) {
    setActiveUid(null);
  } else {
    closeNotesDb();
  }
  closeAccountWindows();
  console.log(`[bili-pet] local session locked (${reason})`);
}

/** Mount DB + mark session live after extension proves a Bilibili uid. */
function unlockLocalSession(uid, payload = {}) {
  const id = String(uid || '').trim();
  if (!id) return { ok: false, error: 'no_uid' };

  const acc = loadAccount();
  const bound = acc.activeUid || acc.boundUid;
  const wasLive =
    Boolean(acc.sessionLoggedIn) &&
    getActiveUid() === id &&
    isAccountOpsReady();

  if (!bound || bound !== id) {
    const gate = handleAccountPayload({
      ...payload,
      kind: 'account_hello',
      account: {
        ...(payload.account || {}),
        uid: id,
        loggedIn: true,
      },
    });
    broadcastPetEvent(
      {
        ...payload,
        kind: 'account_hello',
        bindStatus: gate.status,
        boundUid: gate.account?.activeUid || gate.account?.boundUid || null,
        activeUid: gate.account?.activeUid || null,
        prevUid: gate.prevUid || null,
        ok: gate.ok,
        via: 'unlock',
      },
      { touchLatest: false }
    );
    console.log(`[bili-pet] account ${gate.status} (unlock)`, gate.uid || id);
    if (!gate.ok || !gate.uid) return { ok: false, error: gate.status };

    if (gate.status === 'auto_bound') {
      setActiveUid(gate.uid);
      setAccountOpsReady(true);
      saveAccountSessionLoggedIn(gate.uid);
      void ensureAccountLocalStore(gate, payload);
      return { ok: true, uid: gate.uid, status: gate.status };
    }
    if (gate.status === 'switched') {
      void ensureAccountLocalStore(gate, payload);
      return { ok: true, uid: gate.uid, status: gate.status };
    }
    if (gate.status === 'logged_in') {
      accountOpSeq += 1; // cancel stale logout/purge from earlier false locks
      setActiveUid(gate.uid);
      setAccountOpsReady(true);
      saveAccountSessionLoggedIn(gate.uid);
      void ensureAccountLocalStore(gate, payload);
      return { ok: true, uid: gate.uid, status: gate.status };
    }
    return { ok: false, error: gate.status };
  }

  // Same bound uid: only bump op seq when recovering from a lock (not every heartbeat)
  if (!wasLive) {
    accountOpSeq += 1;
  }
  saveAccountSessionLoggedIn(id);
  if (!getActiveUid()) setActiveUid(id);
  setAccountOpsReady(true);
  if (!wasLive) {
    void ensureAccountLocalStore(
      {
        ok: true,
        status: 'logged_in',
        uid: id,
        prevUid: null,
        account: loadAccount(),
      },
      payload
    );
  } else {
    // Already live locally: still need cloud JWT if missing
    const hasToken = Boolean(loadTokenForUid(id)?.token);
    const cookie =
      payload.cookieHeader ||
      payload.account?.cookieHeader ||
      getBiliCookieHeader() ||
      '';
    if (cloudEnabled() && !hasToken) {
      const { ensureCloudAuth } = require('./cloud-sync');
      void ensureCloudAuth({
        uid: id,
        cookieHeader: cookie || null,
      }).then((result) => {
        if (!result?.ok) {
          console.warn(
            '[bili-pet] cloud auth retry failed:',
            result?.error || 'auth_failed'
          );
        } else if (!result.skipped) {
          console.log('[bili-pet] cloud auth ok uid=', result.uid, result.via || '');
        }
      });
    }
  }
  return { ok: true, uid: id, status: 'logged_in' };
}

function enqueueLogoutPurge(reason) {
  const seq = ++accountOpSeq;
  const uidSnapshot =
    getActiveUid() || loadAccount().activeUid || loadAccount().boundUid || null;
  accountOpChain = accountOpChain
    .then(async () => {
      if (seq !== accountOpSeq) return;
      const result = await flushAndPurgeActiveAccount(reason);
      if (!result?.ok && !result?.skipped && uidSnapshot) {
        // 数据安全优先：失败不删；持续后台重试
        scheduleBackgroundPurge(uidSnapshot, reason);
      }
    }, async () => {
      if (seq !== accountOpSeq) return;
      const result = await flushAndPurgeActiveAccount(reason);
      if (!result?.ok && !result?.skipped && uidSnapshot) {
        scheduleBackgroundPurge(uidSnapshot, reason);
      }
    })
    .catch((err) => {
      console.warn('[bili-pet] logout purge failed:', err?.message || err);
      if (uidSnapshot) scheduleBackgroundPurge(uidSnapshot, reason);
    });
}

async function flushAndPurgeActiveAccount(reason = 'logout_push') {
  const uidToPurge = getActiveUid() || loadAccount().activeUid || loadAccount().boundUid;
  if (!uidToPurge) {
    clearBinding();
    return { ok: true, skipped: true, reason: 'no_uid' };
  }

  // Ensure DB mounted for push if boot skipped mount while session was false
  if (!getActiveUid()) {
    setActiveUid(uidToPurge);
  }

  const result = await flushAndPurgeUid(uidToPurge, reason);
  if (!result.ok) {
    // push/purge 失败也不留挂载：访问门闩靠 sessionLoggedIn，但卸库更稳妥
    if (getActiveUid()) setActiveUid(null);
    else closeNotesDb();
    broadcastPetEvent(
      {
        v: 1,
        source: 'bili-pet',
        kind: 'purge_blocked',
        ts: Date.now(),
        uid: uidToPurge,
        error: result.error || 'purge_blocked',
        reason: result.error || 'purge_blocked',
      },
      { touchLatest: false }
    );
    return result;
  }

  clearBinding();
  noteContext = null;
  latestEvent = null;
  flushStudyClock();
  studyClock = null;
  closeAccountWindows();
  broadcastPetEvent(
    {
      v: 1,
      source: 'bili-pet',
      kind: 'account_purged',
      ts: Date.now(),
      uid: uidToPurge,
      reason,
      ok: true,
    },
    { touchLatest: false }
  );
  return result;
}

async function ensureAccountLocalStore(gate, payload = {}) {
  if (!gate?.ok || !gate.uid) return;
  const switched = gate.status === 'switched';
  const autoBound = gate.status === 'auto_bound';
  const loggedIn =
    gate.status === 'logged_in' || gate.status === 'ok' || gate.status === 'hello';

  // Heartbeat 会频繁 logged_in；仅首次绑定 / 切号 / 未就绪时走同步
  if (!switched && !autoBound) {
    if (!loggedIn) return;
    if (
      isAccountOpsReady() &&
      getActiveUid() === gate.uid &&
      loadAccount().sessionLoggedIn
    ) {
      return;
    }
    if (accountReadyInFlightUid === gate.uid) {
      // 首轮卡在 waiting_auth：若此刻已有 cookie，允许打断重跑鉴权
      const hasToken = Boolean(loadTokenForUid(gate.uid)?.token);
      const hasCookie = Boolean(
        payload.cookieHeader ||
          payload.account?.cookieHeader ||
          getBiliCookieHeader()
      );
      if (hasToken || !hasCookie) return;
    }
  }

  const seq = ++accountOpSeq;
  accountReadyInFlightUid = gate.uid;
  const cookieHeader =
    payload.cookieHeader ||
    payload.account?.cookieHeader ||
    null;
  const uid = gate.uid;
  const prevUid = gate.prevUid || null;

  const run = async () => {
    if (seq !== accountOpSeq) return;

    if (switched) {
      flushStudyClock();
      studyClock = null;
      noteContext = null;
      latestEvent = null;
    }

    // 主进程先广播，保证宠物立刻开跳舞（不依赖 cloud-sync 内部时序）
    broadcastPetEvent(
      {
        v: 1,
        source: 'bili-pet-sync',
        kind: 'sync_state',
        status: switched ? 'switching' : 'syncing_login',
        ts: Date.now(),
        uid,
        prevUid,
        switched,
        cloudEnabled: cloudEnabled(),
      },
      { touchLatest: false }
    );

    // 切号：立刻提交绑定与本地库挂载意图（旧号后台清）
    if (switched || autoBound) {
      commitBinding(uid);
    } else {
      saveAccountSessionLoggedIn(uid);
    }

    const result = await onAccountReady({
      uid,
      prevUid,
      switched,
      autoBound,
      cookieHeader,
      opSeq: seq,
      isStale: () => seq !== accountOpSeq,
    });

    if (seq !== accountOpSeq) return;

    if (!result?.ok) {
      broadcastPetEvent(
        {
          v: 1,
          source: 'bili-pet',
          kind: 'switch_blocked',
          ts: Date.now(),
          uid,
          prevUid,
          error: result?.cause || result?.error || 'ready_failed',
          reason: result?.cause || result?.error || 'ready_failed',
          ok: false,
        },
        { touchLatest: false }
      );
      return;
    }

    commitBinding(uid);

    broadcastPetEvent(
      {
        v: 1,
        source: 'bili-pet',
        kind: 'account_switched',
        ts: Date.now(),
        uid,
        prevUid,
        bindStatus: gate.status,
        boundUid: uid,
        ok: true,
        switched,
        opsReady: Boolean(result.opsReady),
        pullError: result.pullError || null,
      },
      { touchLatest: false }
    );

    if (result.opsReady !== false) {
      broadcastPetEvent(
        {
          v: 1,
          source: 'bili-pet',
          kind: 'kb_account_ready',
          ts: Date.now(),
          uid,
          prevUid,
          switched,
          ok: true,
        },
        { touchLatest: false }
      );
      if (homeWindow && !homeWindow.isDestroyed()) {
        try {
          homeWindow.reload();
        } catch (err) {
          console.warn('[bili-pet] home reload after switch failed:', err?.message || err);
        }
      }
      if (notesWindow && !notesWindow.isDestroyed()) {
        try {
          notesWindow.reload();
        } catch (err) {
          console.warn('[bili-pet] notes reload after switch failed:', err?.message || err);
        }
      }
    }
  };

  accountOpChain = accountOpChain
    .then(run, run)
    .catch((err) => {
      console.warn('[bili-pet] account store op failed:', err?.message || err);
    })
    .finally(() => {
      if (accountReadyInFlightUid === uid && seq === accountOpSeq) {
        accountReadyInFlightUid = null;
      }
    });
  await accountOpChain;
}

function onBridgeEvent(payload) {
  if (!payload || typeof payload !== 'object') return;

  // Any bridge traffic proves the extension is alive
  touchExtensionPresence(Number(payload.ts) || Date.now());
  rememberBiliCookieFromPayload(payload);

  const kind = String(payload.kind || '');

  if (kind === 'extension_heartbeat') {
    const uid = payload.account?.uid || payload.uid || null;
    // 只有「心跳明确没有 UID」才当登出。cookieOk 只影响 B 站写接口，不能拿来锁本地库。
    if (!uid) {
      const hadLiveSession = Boolean(
        loadAccount().sessionLoggedIn || getActiveUid()
      );
      lockLocalSession('heartbeat_no_uid');
      if (hadLiveSession) {
        enqueueLogoutPurge('heartbeat_logged_out_push');
      }
      return;
    }

    unlockLocalSession(String(uid), payload);
    return;
  }

  if (kind === 'account_auth_cookie') {
    void handleAuthCookiePayload(payload).then((result) => {
      broadcastPetEvent(
        {
          v: 1,
          source: 'bili-pet-sync',
          kind: 'account_auth_result',
          ts: Date.now(),
          ok: Boolean(result?.ok),
          uid: result?.uid || null,
          error: result?.error || null,
        },
        { touchLatest: false }
      );
    });
    return;
  }

  // 账号事件才走绑定/登出；progress/heartbeat 等业务事件缺 uid 不能当成登出，
  // 否则一看视频就把库锁死——这也是「插件正常却打不开」的主因。
  if (kind === 'account_login' || kind === 'account_logout' || kind === 'account_hello') {
    const gate = handleAccountPayload(payload);
    if (kind === 'account_logout' || gate.status === 'logged_out') {
      flushStudyClock();
      studyClock = null;
    }
    const event = {
      ...payload,
      bindStatus: gate.status,
      boundUid: gate.account?.activeUid || gate.account?.boundUid || null,
      activeUid: gate.account?.activeUid || null,
      prevUid: gate.prevUid || null,
      ok: gate.ok,
    };
    broadcastPetEvent(event, { touchLatest: false });
    console.log(
      `[bili-pet] account ${gate.status}`,
      gate.uid || gate.account?.activeUid || '(none)'
    );

    if (kind === 'account_logout' || gate.status === 'logged_out') {
      lockLocalSession(
        kind === 'account_logout' ? 'account_logout' : 'logged_out'
      );
      enqueueLogoutPurge(
        kind === 'account_logout' ? 'logout_push' : 'logged_out_push'
      );
      return;
    }

    if (gate.ok && gate.uid && gate.status === 'auto_bound') {
      setActiveUid(gate.uid);
      setAccountOpsReady(true);
      saveAccountSessionLoggedIn(gate.uid);
      void ensureAccountLocalStore(gate, payload);
    } else if (gate.ok && gate.uid && gate.status === 'switched') {
      void ensureAccountLocalStore(gate, payload);
    } else if (gate.ok && gate.status === 'logged_in') {
      const wasLive =
        Boolean(loadAccount().sessionLoggedIn) &&
        getActiveUid() === gate.uid &&
        isAccountOpsReady();
      if (!wasLive) accountOpSeq += 1;
      if (!getActiveUid() && gate.uid) {
        setActiveUid(gate.uid);
      }
      setAccountOpsReady(true);
      saveAccountSessionLoggedIn(gate.uid);
      if (!wasLive) {
        void ensureAccountLocalStore(gate, payload);
      } else if (payload.cookieHeader) {
        void handleAuthCookiePayload(payload);
      }
    }
    return;
  }

  broadcastPetEvent(payload);
  try {
    recordStudyActivity(payload);
  } catch (err) {
    console.warn('[bili-pet] study activity record failed', err);
  }
  void notesOrganizer?.maybeHandle(payload);
}//账号切换 + 本地分库 + 云同步编排（切号串行，避免 B/A 互相踩库）

function saveAccountSessionLoggedIn(uid) {
  const id = String(uid || '').trim();
  if (!id) return;
  saveAccount({
    activeUid: id,
    boundUid: id,
    lastSeenUid: id,
    lastSeenAt: Date.now(),
    sessionLoggedIn: true,
  });
}

ipcMain.handle('pet:getLatest', () => latestEvent);

ipcMain.handle('pet:openNotesPage', () => openNotesWindow());

ipcMain.handle('pet:openChatPage', () => openChatWindow());

ipcMain.handle('pet:openFriendsPage', () => openFriendsWindow());

ipcMain.handle('pet:friendsList', () => listFriends());
ipcMain.handle('pet:friendsGetInvite', () => getInvite());
ipcMain.handle('pet:friendsCreateInvite', (_event, payload = {}) =>
  createInvite(payload.pin, payload.ttlMs)
);
ipcMain.handle('pet:friendsCancelInvite', () => cancelInvite());
ipcMain.handle('pet:friendsJoin', (_event, payload = {}) => joinInvite(payload.pin));
ipcMain.handle('pet:friendsRemove', (_event, payload = {}) => removeFriend(payload.uid));
ipcMain.handle('pet:friendsPet', (_event, payload = {}) => petFriend(payload.uid));

ipcMain.handle('pet:friendsNoteShare', async (_event, payload = {}) => {
  const bound = requireBoundAccount();
  if (!bound.ok) {
    return { ok: false, error: bound.error || 'not_bound', message: gateMessage(bound.error) };
  }
  if (!cloudEnabled()) {
    return { ok: false, error: 'cloud_disabled', message: gateMessage('cloud_disabled') };
  }
  const toUid = String(payload?.toUid || payload?.uid || '').trim();
  const bvid = String(payload?.bvid || '').trim();
  if (!toUid || !bvid) return { ok: false, error: 'missing_params' };
  const doc = loadNoteDoc(bvid);
  if (!doc) return { ok: false, error: 'note_not_found' };
  const bodyMd = String(doc.bodyMd || '').trim();
  if (!bodyMd) return { ok: false, error: 'empty_note' };
  return shareNote({
    toUid,
    bvid: doc.bvid,
    title: doc.title || bvid,
    bodyMd: doc.bodyMd,
    notes: doc.notes,
    mode: doc.mode || 'user',
  });
});

ipcMain.handle('pet:friendsNoteInbox', () => listNoteInbox());

ipcMain.handle('pet:friendsNoteAccept', async (_event, payload = {}) => {
  const bound = requireBoundAccount();
  if (!bound.ok) {
    return { ok: false, error: bound.error || 'not_bound', message: gateMessage(bound.error) };
  }
  const id = Number(payload?.id);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'missing_id' };
  const res = await acceptNoteShare(id);
  if (!res?.ok || !res.note) return res || { ok: false, error: 'accept_failed' };

  const note = res.note;
  let targetBvid = String(note.bvid || '').trim();
  if (!targetBvid) return { ok: false, error: 'missing_bvid' };

  if (loadNoteDoc(targetBvid)) {
    const from = String(note.fromUid || 'x').replace(/[^\w.-]/g, '').slice(0, 16) || 'x';
    const base = targetBvid.replace(/[^\w.-]/g, '').slice(0, 40) || 'note';
    targetBvid = `share_${from}_${base}`.slice(0, 64);
    let n = 1;
    while (loadNoteDoc(targetBvid) && n < 20) {
      targetBvid = `share_${from}_${base}_${n}`.slice(0, 64);
      n += 1;
    }
  }

  const saved = saveNoteDoc(targetBvid, {
    title: note.title || targetBvid,
    bodyMd: note.bodyMd || '',
    notes: note.notes || null,
    mode: 'user',
    sessionId: null,
  });
  if (!saved) return { ok: false, error: 'save_failed' };
  return {
    ok: true,
    bvid: saved.bvid,
    title: saved.title,
    renamed: saved.bvid !== note.bvid,
    fromUname: note.fromUname || null,
  };
});

ipcMain.handle('pet:friendsNoteReject', async (_event, payload = {}) => {
  const bound = requireBoundAccount();
  if (!bound.ok) {
    return { ok: false, error: bound.error || 'not_bound', message: gateMessage(bound.error) };
  }
  const id = Number(payload?.id);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'missing_id' };
  return rejectNoteShare(id);
});

ipcMain.handle('pet:gameAnswer', (_event, payload = {}) => {
  const bound = requireBoundAccount();
  if (!bound.ok) {
    notifyGateBlocked(bound.error, 'game_answer');
    return { ok: false, error: bound.error || 'not_bound', message: gateMessage(bound.error) };
  }
  const choice = payload?.choice ?? payload?.index;
  const result = answerGame(choice);
  return {
    ok: Boolean(result?.ok),
    correct: Boolean(result?.correct),
    feedback: result?.feedback || '',
    error: result?.error || null,
    gameUi: result?.gameUi || null,
    autoClose: Boolean(result?.autoClose),
    endMessage: result?.endMessage || '',
    won: Boolean(result?.won),
  };
});

ipcMain.handle('pet:gameStop', () => {
  const result = stopGame();
  return result;
});

ipcMain.handle('pet:goHome', (_event, opts) => {
  const bound = requireBoundAccount();
  if (!bound.ok) {
    notifyGateBlocked(bound.error, 'go_home');
    return { ok: false, error: bound.error || 'not_bound', message: gateMessage(bound.error) };
  }
  return goHome(opts || {});
});

function isNotesMetaQuestion(question) {
  const q = String(question || '');
  return /几篇|多少.*笔记|有没有.*笔记|笔记.*(列表|目录|有哪些|一共)|最近.*(一篇)?笔记|我的笔记|笔记.*(内容|讲了|讲什么)|这个视频.*(讲|关于|内容)|当前.*(视频|笔记)/.test(
    q
  );
}//检索笔记

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
}//以上全都是笔记检索逻辑，按照关键词切块，比较脆弱但是目前还用不上向量，有时间再微调

function formatNotesContext(hits) {
  if (!hits.length) return '';
  return hits
    .map((h, i) => {
      const title = h.heading ? ` · ${h.heading}` : '';
      return `${i + 1}. [${h.bvid}${title}]\n${h.text}`;
    })
    .join('\n\n');
}//拼笔记函数

ipcMain.handle('pet:chat', async (_event, payload = {}) => {
  const bound = requireBoundAccount();
  if (!bound.ok) {
    notifyGateBlocked(bound.error, 'chat');
    return { ok: false, error: bound.error || 'not_bound', message: gateMessage(bound.error) };
  }

  const raw = Array.isArray(payload.messages) ? payload.messages : [];
  const messages = raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .map((m) => ({ role: m.role, content: String(m.content).trim() }))
    .slice(-20);
  if (!messages.length) return { ok: false, error: 'empty' };

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const question = lastUser?.content || '';

  try {
    const gameResult = await tryHandleGameChat(question, currentVideoMeta());
    if (gameResult?.handled) {
      if (/^\/game\b/i.test(question)) {
        try {
          learningPlanSkill.reset();
        } catch {
          /* ignore */
        }
      }
      return {
        ok: true,
        text: gameResult.message || '',
        sources: [],
        game: true,
        gameUi: gameResult.gameUi || null,
      };
    }
  } catch (err) {
    console.warn('[bili-pet] game chat failed:', err.message || err);
  }

  try {
    const planResult = await tryHandlePlanChat(question, currentVideoMeta(), {
      history: messages,
    });
    if (planResult?.handled) {
      return {
        ok: true,
        text: planResult.message || (planResult.ok ? '已完成' : '操作失败'),
        sources: [],
        plan: true,
        needsConfirm: Boolean(planResult.needsConfirm),
      };
    }
  } catch (err) {
    console.warn('[bili-pet] learning plan chat failed:', err.message || err);
  }

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
  //一些限定prompt，挪动会很麻烦
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
});//课程组内容切块

ipcMain.handle('pet:notesLoad', (_event, payload = {}) => {
  const bound = requireBoundAccount();
  if (!bound.ok) return { ok: false, error: bound.error || 'not_bound', doc: null };
  const bvid = String(payload.bvid || currentBvidFromEvent() || '').trim();
  if (!bvid) return { ok: false, error: 'no_bvid', doc: null };
  const doc = loadNoteDoc(bvid);
  return { ok: true, bvid, doc };
});

ipcMain.handle('pet:notesSave', (_event, payload = {}) => {
  const bound = requireBoundAccount();
  if (!bound.ok) return { ok: false, error: bound.error || 'not_bound' };
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

ipcMain.on('pet:notesSaveSync', (event, payload = {}) => {
  try {
    const bound = requireBoundAccount();
    if (!bound.ok) {
      event.returnValue = { ok: false, error: bound.error || 'not_bound' };
      return;
    }
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
});//不知道啥时候写的复杂逻辑函数，但是不敢动

ipcMain.handle('pet:notesOrganize', async (_event, payload = {}) => {
  const bound = requireBoundAccount();
  if (!bound.ok) return { ok: false, error: bound.error || 'not_bound' };
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
});//笔记整理函数

ipcMain.handle('pet:notesSaveAsset', async (_event, payload = {}) => {
  const bound = requireBoundAccount();
  if (!bound.ok) return { ok: false, error: bound.error || 'not_bound' };
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
  const bound = requireBoundAccount();
  if (!bound.ok) return { ok: false, error: bound.error || 'not_bound' };
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
    {
      const acc = loadAccount();
      const uid = acc.activeUid || acc.boundUid;
      setAccountOpsReady(false);
      if (acc.sessionLoggedIn) {
        saveAccount({ sessionLoggedIn: false, lastSeenAt: Date.now() });
      }
      if (getActiveUid()) setActiveUid(null);
      else closeNotesDb();
      if (uid) {
        console.log(
          `[bili-pet] remembered uid=${uid} — locked until extension proves live Bilibili login`
        );
      } else {
        console.log('[bili-pet] no active account yet — will bind on first Bilibili login');
      }
    }

    startCloudSync({
      onBroadcast: (event) => {
        broadcastPetEvent(event, { touchLatest: false });
        // First-pull eventually succeeded via retry → refresh open KB windows
        if (
          event?.kind === 'sync_state' &&
          event.status === 'account_switched' &&
          event.opsReady &&
          event.retried
        ) {
          broadcastPetEvent(
            {
              v: 1,
              source: 'bili-pet',
              kind: 'kb_account_ready',
              ts: Date.now(),
              uid: event.uid,
              ok: true,
              retried: true,
            },
            { touchLatest: false }
          );
        }
      },
    });
    startFriendsCloud({
      onBroadcast: (event) => broadcastPetEvent(event, { touchLatest: false }),
    });
    try {
      sweepOrphanLocalStores();
    } catch (err) {
      console.warn('[bili-pet] orphan sweep failed:', err?.message || err);
    }

    setPresenceChangeHandler(({ alive }) => {
      if (alive) {
        broadcastPetEvent(
          {
            v: 1,
            source: 'bili-pet',
            kind: 'extension_online',
            ts: Date.now(),
            ok: true,
          },
          { touchLatest: false }
        );
        return;
      }
      // 扩展掉线 = 软登出：推云 + 清库；恢复后须重新证明登录
      const hadLiveSession = Boolean(
        loadAccount().sessionLoggedIn || getActiveUid()
      );
      lockLocalSession('extension_offline');
      if (hadLiveSession) {
        enqueueLogoutPurge('extension_offline_push');
      }
      broadcastPetEvent(
        {
          v: 1,
          source: 'bili-pet',
          kind: 'extension_offline',
          ts: Date.now(),
          ok: false,
          error: 'extension_offline',
          message: gateMessage('extension_offline'),
        },
        { touchLatest: false }
      );
      console.log('[bili-pet] extension offline — soft logout (push+purge)');
    });
    const presenceTimer = setInterval(() => {
      pollExtensionPresence();
    }, 5000);
    if (typeof presenceTimer.unref === 'function') presenceTimer.unref();

    createWindow();
    wireGamePetNotifier();
    registerStopChord();
    registerChatShortcut();
    registerGameStopChord();

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

    try {
      homeServer = await startHomeServer();
    } catch (err) {
      console.error('[bili-pet] home failed to start:', err.message || err);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopFriendsCloud();
    stopCloudSync();
    closeNotesDb();
    clearPidFile();
  });

  app.on('window-all-closed', () => {
    if (bridgeServer) {
      bridgeServer.close();
      bridgeServer = null;
    }
    void stopHomeServer().then(() => {
      homeServer = null;
    });
    clearPidFile();
    if (process.platform !== 'darwin') app.quit();
  });
}
//以上几个全是笔记函数，建议AI维护，我已经不知道动什么了