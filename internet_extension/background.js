const cfg = {
  SCHEMA_VERSION: 1,
  SOURCE: 'bili-pet-bridge',
  BRIDGE_URL: 'http://127.0.0.1:39261/event',
  MAX_ACTIONS: 100,
  MAX_SUB_LOG: 300,
  MAX_SESSIONS: 40,
  MAX_QUEUE: 50,
};

const DEFAULT_SETTINGS = {
  recordingEnabled: true,
  realtimePush: true,
};

const DEFAULT_STATE = {
  current: null,
  recentFocusBreaks: [],
  subtitleLog: [],
  sessions: [],
  bridgeOnline: false,
  lastError: null,
  pushQueue: [],
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function setSettings(patch) {
  const prev = await getSettings();
  const next = { ...prev, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function readState() {
  const { petState } = await chrome.storage.local.get('petState');
  return { ...DEFAULT_STATE, ...(petState || {}) };
}

async function writeState(patch) {
  const prev = await readState();
  const next = { ...prev, ...patch };
  await chrome.storage.local.set({ petState: next });
  return next;
}

function isHighPriority(payload) {
  return (
    payload?.priority === 'high' ||
    payload?.kind === 'focus_break' ||
    payload?.kind === 'session_start' ||
    payload?.kind === 'session_end' ||
    payload?.kind === 'focus_resume' ||
    payload?.kind === 'account_login' ||
    payload?.kind === 'account_logout' ||
    payload?.kind === 'account_hello'
  );
}

/** @type {string | null | undefined} undefined=未初始化 */
let lastKnownUid = undefined;

function normalizeCookieUid(value) {
  const uid = String(value ?? '').trim();
  if (!uid || uid === '0') return null;
  return uid;
}

async function getBiliAccountFromCookies() {
  try {
    const fromList = await chrome.cookies.getAll({ name: 'DedeUserID' });
    for (const c of fromList || []) {
      if (!String(c.domain || '').includes('bilibili.com')) continue;
      const uid = normalizeCookieUid(c.value);
      if (uid) return { uid, loggedIn: true, source: 'cookie-getAll' };
    }

    const urls = [
      'https://www.bilibili.com',
      'https://bilibili.com',
      'https://m.bilibili.com',
      'https://passport.bilibili.com',
      'https://account.bilibili.com',
      'https://space.bilibili.com',
    ];
    for (const url of urls) {
      try {
        const c = await chrome.cookies.get({ url, name: 'DedeUserID' });
        const uid = normalizeCookieUid(c?.value);
        if (uid) return { uid, loggedIn: true, source: `cookie-get:${url}` };
      } catch (_) {
      }
    }

    return { uid: null, loggedIn: false, source: 'none' };
  } catch (err) {
    console.warn('[bili-pet] getBiliAccountFromCookies failed', err);
    return { uid: null, loggedIn: false, source: 'error' };
  }
}

async function probeUidFromBiliTabs() {
  if (!chrome.scripting?.executeScript) return null;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({
      url: ['*://*.bilibili.com/*', '*://bilibili.com/*'],
    });
  } catch (err) {
    console.warn('[bili-pet] tabs.query failed', err);
    return null;
  }

  tabs.sort((a, b) => Number(b.active) - Number(a.active));

  for (const tab of tabs) {
    if (!tab?.id || tab.discarded) continue;
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          const pick = (v) => {
            const s = String(v ?? '').trim();
            return s && s !== '0' ? s : null;
          };
          try {
            const m = document.cookie.match(/(?:^|;\s*)DedeUserID=([^;]+)/);
            const fromCookie = pick(m?.[1]);
            if (fromCookie) return { uid: fromCookie, via: 'document.cookie' };
          } catch (_) {}
          try {
            const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
              credentials: 'include',
              cache: 'no-store',
            });
            const data = await res.json();
            const mid = pick(data?.data?.mid);
            if (mid) return { uid: mid, via: 'nav-api' };
            return { uid: null, via: 'nav-api', code: data?.code ?? null };
          } catch (err) {
            return { uid: null, via: 'nav-error', error: String(err?.message || err) };
          }
        },
      });
      const result = injected?.[0]?.result;
      const uid = normalizeCookieUid(result?.uid);
      if (uid) {
        return { uid, loggedIn: true, source: `tab-${result?.via || 'probe'}` };
      }
    } catch (err) {
      console.warn('[bili-pet] tab probe failed', tab.id, err?.message || err);
    }
  }
  return null;
}

async function getBiliAccount() {
  const fromCookie = await getBiliAccountFromCookies();
  if (fromCookie.uid) return fromCookie;

  const fromTab = await probeUidFromBiliTabs();
  if (fromTab?.uid) {
    try {
      await chrome.storage.local.set({
        biliAccountCache: { uid: fromTab.uid, at: Date.now(), source: fromTab.source },
      });
    } catch (_) {}
    return fromTab;
  }

  try {
    const { biliAccountCache } = await chrome.storage.local.get('biliAccountCache');
    const cachedUid = normalizeCookieUid(biliAccountCache?.uid);
    if (
      cachedUid &&
      Number(biliAccountCache?.at) &&
      Date.now() - Number(biliAccountCache.at) < 10 * 60 * 1000
    ) {
      return { uid: cachedUid, loggedIn: true, source: 'cache' };
    }
  } catch (_) {}

  return { uid: null, loggedIn: false, source: fromCookie.source || 'none' };
}

async function attachAccount(payload) {
  const existingUid = normalizeCookieUid(payload?.account?.uid);
    if (existingUid) {
    return {
      ...payload,
      account: {
        uid: existingUid,
        loggedIn: true,
      },
    };
  }
  const account = await getBiliAccount();
  return {
    ...payload,
    account: {
      uid: account.uid,
      loggedIn: account.loggedIn,
    },
  };
}

async function bridgeToPet(payload, settings) {
  if (!settings.realtimePush) {
    await writeState({ bridgeOnline: false });
    return false;
  }

  try {
    const body = await attachAccount(payload);
    const res = await fetch(cfg.BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const online = res.ok;
    await writeState({ bridgeOnline: online });
    return online;
  } catch {
    await writeState({ bridgeOnline: false });
    return false;
  }
}

async function pushAccountEvent(kind, account) {
  const settings = await getSettings();
  const payload = {
    v: cfg.SCHEMA_VERSION,
    source: cfg.SOURCE,
    kind,
    ts: Date.now(),
    priority: 'high',
    account: {
      uid: account?.uid ?? null,
      loggedIn: Boolean(account?.loggedIn),
    },
  };
  await writeState({
    biliAccount: {
      uid: account?.uid ?? null,
      loggedIn: Boolean(account?.loggedIn),
      updatedAt: payload.ts,
    },
  });
  await pushRealtime(payload, settings);
}

/**
 * @param {{ force?: boolean, hintUid?: string | null }} [opts]
 */
async function syncAccountFromCookies(opts = {}) {
  const force = Boolean(opts.force);
  let account = await getBiliAccount();
  const hintUid = normalizeCookieUid(opts.hintUid);
  if (!account.uid && hintUid) {
    account = { uid: hintUid, loggedIn: true, source: 'page-hint' };
  }
  const uid = account.uid;
  if (!force && lastKnownUid !== undefined && uid === lastKnownUid) {
    return { ok: Boolean(uid), account };
  }

  const prev = lastKnownUid;
  lastKnownUid = uid;

  if (uid) {
    const kind = prev === undefined || force ? 'account_hello' : 'account_login';
    await pushAccountEvent(kind, account);
    return { ok: true, account };
  }

    if (force) {
    return { ok: false, account: { uid: null, loggedIn: false, source: account.source || 'none' } };
  }

  if (prev === undefined || prev) {
    await pushAccountEvent('account_logout', { uid: null, loggedIn: false });
  }
  return { ok: false, account: { uid: null, loggedIn: false, source: account.source || 'none' } };
}

async function ingestPageAccountHint(hintUid) {
  const uid = normalizeCookieUid(hintUid);
  if (!uid) return;
  await syncAccountFromCookies({ hintUid: uid });
}

async function enqueue(payload) {
  const state = await readState();
  const pushQueue = [...state.pushQueue, payload].slice(-cfg.MAX_QUEUE);
  await writeState({ pushQueue });
}

async function flushQueue(settings) {
  if (!settings.realtimePush) return;
  const state = await readState();
  if (!state.pushQueue.length) return;

  const remain = [];
  for (const item of state.pushQueue) {
    const ok = await bridgeToPet(item, settings);
    if (!ok) {
      remain.push(item);
      remain.push(...state.pushQueue.slice(state.pushQueue.indexOf(item) + 1));
      break;
    }
  }
  await writeState({ pushQueue: remain.slice(-cfg.MAX_QUEUE) });
}

async function pushRealtime(payload, settings) {
  const ok = await bridgeToPet(payload, settings);
  if (!ok && isHighPriority(payload)) {
    await enqueue(payload);
  }
}

async function recordFocusBreak(payload) {
  const state = await readState();
  const item = {
    type: payload.type || 'exit_video',
    reason: payload.detail?.reason || payload.reason || null,
    bvid: payload.bvid,
    sessionId: payload.sessionId,
    currentTime: payload.currentTime,
    ts: payload.ts || Date.now(),
  };
  const recentFocusBreaks = [item, ...state.recentFocusBreaks].slice(0, cfg.MAX_ACTIONS);
  return writeState({ recentFocusBreaks, lastError: null });
}

async function pushSubtitleRecord(record) {
  const state = await readState();
  const subtitleLog = [...state.subtitleLog];
  const idx = subtitleLog.findIndex((item) => item.sessionId === record.sessionId);
  const entry = {
    sessionId: record.sessionId,
    bvid: record.bvid,
    title: record.title,
    currentTime: record.currentTime,
    transcriptText: record.transcriptText || '',
    ts: record.ts || Date.now(),
  };
  if (idx >= 0) {
    subtitleLog[idx] = { ...subtitleLog[idx], ...entry };
  } else {
    subtitleLog.unshift(entry);
  }
  return writeState({ subtitleLog: subtitleLog.slice(0, cfg.MAX_SUB_LOG) });
}

async function upsertSession(patch) {
  const state = await readState();
  const sessions = [...state.sessions];
  const idx = sessions.findIndex((s) => s.sessionId === patch.sessionId);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], ...patch };
  } else if (patch.sessionId) {
    sessions.unshift(patch);
  }
  return writeState({ sessions: sessions.slice(0, cfg.MAX_SESSIONS) });
}

async function handlePayload(payload, senderTab = null) {
  if (!payload || !payload.kind) return;

  const settings = await getSettings();
  if (!settings.recordingEnabled && payload.kind !== 'error') {
    return;
  }

  const liveKinds = new Set(['progress', 'heartbeat', 'session_meta', 'session_start']);
  if (liveKinds.has(payload.kind) && senderTab?.id != null) {
    try {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active?.id != null && active.id !== senderTab.id) {
        return;
      }
    } catch (_) {
    }
  }

  const existing = await readState();
  const cur = existing.current;
  if (
    (payload.kind === 'progress' || payload.kind === 'heartbeat' || payload.kind === 'session_meta') &&
    payload.sessionId &&
    cur?.sessionId &&
    payload.sessionId !== cur.sessionId
  ) {
    return;
  }

  switch (payload.kind) {
    case 'session_start':
      await upsertSession({
        sessionId: payload.sessionId,
        bvid: payload.bvid,
        startedAt: payload.ts,
        status: 'active',
      });
      await writeState({
        current: {
          sessionId: payload.sessionId,
          bvid: payload.bvid,
          updatedAt: payload.ts,
        },
      });
      break;

    case 'heartbeat': {
      const prev = (await readState()).current || {};
      await writeState({
        current: {
          sessionId: payload.sessionId,
          bvid: payload.bvid,
          cid: payload.cid,
          title: payload.title,
          currentTime: payload.currentTime,
          paused: payload.paused,
          currentSubtitle: payload.currentSubtitle || null,
          contextText: payload.contextText || null,
          transcriptText: payload.transcriptText ?? prev.transcriptText ?? '',
          fullSubtitleText: payload.fullSubtitleText ?? prev.fullSubtitleText ?? null,
          subtitleStatus: payload.subtitleStatus ?? prev.subtitleStatus ?? null,
          modelInput: payload.modelInput ?? prev.modelInput ?? null,
          updatedAt: payload.ts || Date.now(),
        },
      });
      break;
    }

    case 'session_meta':
      await writeState({
        current: {
          sessionId: payload.sessionId,
          bvid: payload.bvid,
          cid: payload.cid,
          title: payload.title,
          currentTime: payload.currentTime,
          paused: payload.paused,
          currentSubtitle: payload.currentSubtitle || null,
          contextText: payload.contextText || null,
          transcriptText: payload.transcriptText || '',
          fullSubtitleText: payload.fullSubtitleText || null,
          subtitleStatus: payload.subtitleStatus,
          updatedAt: payload.ts || Date.now(),
        },
      });
      await upsertSession({
        sessionId: payload.sessionId,
        bvid: payload.bvid,
        title: payload.title,
        cid: payload.cid,
        lan: payload.lan,
        subtitleStatus: payload.subtitleStatus,
        lineCount: payload.lineCount,
      });
      break;

    case 'progress': {
      const prev = (await readState()).current || {};
      await writeState({
        current: {
          sessionId: payload.sessionId,
          bvid: payload.bvid,
          cid: payload.cid,
          title: payload.title,
          currentTime: payload.currentTime,
          paused: payload.paused,
          currentSubtitle: payload.currentSubtitle || null,
          contextText: payload.contextText || null,
          transcriptText: payload.transcriptText ?? prev.transcriptText ?? '',
          subtitleStatus: payload.subtitleStatus ?? prev.subtitleStatus ?? null,
          modelInput: payload.modelInput ?? prev.modelInput ?? null,
          updatedAt: payload.ts || Date.now(),
        },
      });
      if (payload.transcriptText) {
        await pushSubtitleRecord({
          sessionId: payload.sessionId,
          bvid: payload.bvid,
          title: payload.title,
          currentTime: payload.currentTime,
          transcriptText: payload.transcriptText,
          ts: payload.ts || Date.now(),
        });
      }
      break;
    }

    case 'focus_break':
      await recordFocusBreak(payload);
      {
        const reason = payload.detail?.reason;
        if (['pagehide', 'route_change', 'switch_bvid'].includes(reason) && payload.sessionId) {
          await upsertSession({
            sessionId: payload.sessionId,
            bvid: payload.bvid,
            endedAt: payload.ts,
            endReason: reason,
            lastTime: payload.currentTime,
            status: 'ended',
          });
          const cur = (await readState()).current;
          if (cur?.sessionId === payload.sessionId) {
            await writeState({ current: null });
          }
        }
      }
      break;

    case 'focus_resume':
      await recordFocusBreak({
        ...payload,
        type: 'focus_resume',
        detail: { reason: payload.reason },
      });
      break;

    case 'session_end':
      await upsertSession({
        sessionId: payload.sessionId,
        bvid: payload.bvid,
        title: payload.title,
        endedAt: payload.ts,
        endReason: payload.reason,
        durationMs: payload.durationMs,
        lastTime: payload.currentTime,
        status: 'ended',
        transcriptText: payload.transcriptText || '',
      });
      if (payload.transcriptText) {
        await pushSubtitleRecord({
          sessionId: payload.sessionId,
          bvid: payload.bvid,
          title: payload.title,
          currentTime: payload.currentTime,
          transcriptText: payload.transcriptText,
          ts: payload.ts || Date.now(),
        });
      }
      {
        const cur = (await readState()).current;
        if (cur?.sessionId === payload.sessionId) {
          await writeState({ current: null });
        }
      }
      break;

    case 'error':
      await writeState({ lastError: payload });
      break;

    default:
      break;
  }

  await pushRealtime(payload, settings);
}

async function getBiliCookieHeader() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'bilibili.com' });
    if (!cookies?.length) return '';
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

async function fetchJsonWithBrowserSession(url) {
  const cookie = await getBiliCookieHeader();
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.bilibili.com',
    Origin: 'https://www.bilibili.com',
  };
    if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  return res.json();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'BILI_PET_FETCH_JSON') {
    fetchJsonWithBrowserSession(message.url)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message?.type === 'BILI_PET_EVENT') {
    handlePayload(message.payload, _sender?.tab || null)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === 'BILI_PET_GET_STATE') {
    Promise.all([readState(), getSettings(), getBiliAccount()]).then(
      ([state, settings, account]) => {
        sendResponse({
          ok: true,
          state: {
            ...state,
            biliAccount: {
              uid: account.uid,
              loggedIn: account.loggedIn,
              source: account.source || null,
              updatedAt: Date.now(),
            },
          },
          settings,
        });
      }
    );
    return true;
  }

  if (message?.type === 'BILI_PET_SYNC_ACCOUNT') {
    (async () => {
      const syncResult = await syncAccountFromCookies({
        force: true,
        hintUid: message.hintUid || null,
      });
      const account = syncResult?.account?.uid
        ? syncResult.account
        : await getBiliAccount();
      return {
        ok: Boolean(account?.uid),
        account: {
          uid: account?.uid || null,
          loggedIn: Boolean(account?.uid),
          source: account?.source || null,
        },
      };
    })()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message?.type === 'BILI_PET_ACCOUNT_HINT') {
    ingestPageAccountHint(message.uid)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message?.type === 'BILI_PET_GET_SETTINGS') {
    getSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (message?.type === 'BILI_PET_SET_SETTINGS') {
    setSettings(message.patch || {})
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === 'BILI_PET_CLEAR') {
    chrome.storage.local
      .set({ petState: { ...DEFAULT_STATE } })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === 'BILI_PET_EXPORT') {
    Promise.all([readState(), getSettings()]).then(([state, settings]) => {
      sendResponse({
        ok: true,
        export: {
          v: cfg.SCHEMA_VERSION,
          source: cfg.SOURCE,
          exportedAt: Date.now(),
          settings: {
            recordingEnabled: settings.recordingEnabled,
            realtimePush: settings.realtimePush,
          },
          current: state.current,
          sessions: state.sessions,
          subtitleLog: state.subtitleLog,
          recentFocusBreaks: state.recentFocusBreaks,
        },
      });
    });
    return true;
  }
});

chrome.cookies.onChanged.addListener((changeInfo) => {
  const c = changeInfo?.cookie;
  if (!c || c.name !== 'DedeUserID') return;
  if (!String(c.domain || '').includes('bilibili.com')) return;
  void syncAccountFromCookies();
});

chrome.alarms.create('bili-pet-flush', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'bili-pet-flush') return;
  const settings = await getSettings();
  await flushQueue(settings);
  await syncAccountFromCookies();
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await setSettings(DEFAULT_SETTINGS);
  await syncAccountFromCookies();
});

chrome.runtime.onStartup?.addListener?.(() => {
  void syncAccountFromCookies();
});

void syncAccountFromCookies();
//明天更改的账号绑定逻辑，数据这块儿做的跟屎一样