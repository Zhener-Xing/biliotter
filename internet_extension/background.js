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

/** @type {string | null | undefined} */
let lastKnownUid = undefined;
/** @type {ReturnType<typeof setTimeout> | null} */
let biliTabsReloadTimer = null;
/** Avoid re-entrant force-hello while recovering bridge */
let bridgeRecovering = false;

function normalizeCookieUid(value) {
  const uid = String(value ?? '').trim();
  if (!uid || uid === '0') return null;
  return uid;
}

/**
 * 账号 UID 变化后刷新已打开的 B 站页，让页面态跟上新登录态。
 * 跳过 passport，避免打断正在进行的登录流程。
 */
async function reloadBilibiliTabs(reason = 'uid_changed') {
  try {
    const tabs = await chrome.tabs.query({
      url: ['*://*.bilibili.com/*', '*://bilibili.com/*'],
    });
    let n = 0;
    for (const tab of tabs) {
      if (!tab?.id) continue;
      const url = String(tab.url || '');
      if (/passport\.bilibili\.com/i.test(url)) continue;
      try {
        await chrome.tabs.reload(tab.id);
        n += 1;
      } catch (_) {
        /* tab may be gone */
      }
    }
    if (n > 0) {
      console.log(`[bili-pet-bridge] reloaded ${n} bilibili tab(s) (${reason})`);
    }
  } catch (err) {
    console.warn('[bili-pet-bridge] reload bilibili tabs failed:', err?.message || err);
  }
}

function scheduleReloadBilibiliTabs(reason = 'uid_changed') {
  if (biliTabsReloadTimer) clearTimeout(biliTabsReloadTimer);
  biliTabsReloadTimer = setTimeout(() => {
    biliTabsReloadTimer = null;
    void reloadBilibiliTabs(reason);
  }, 450);
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
    // #region agent log
    fetch('http://127.0.0.1:7383/ingest/5054654b-aba0-404a-ac16-c602aa116055',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d429e3'},body:JSON.stringify({sessionId:'d429e3',hypothesisId:'K',location:'background.js:bridgeToPet',message:'realtimePush disabled',data:{kind:String(payload?.kind||'')},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return false;
  }

  try {
    const prevState = await readState();
    const wasOnline = Boolean(prevState.bridgeOnline);
    const body = await attachAccount(payload);
    const res = await fetch(cfg.BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const online = res.ok;
    // 单次失败不立刻标离线，避免并发请求把状态打成「宠物明明在却离线」
    if (online) {
      await writeState({ bridgeOnline: true, bridgeFailStreak: 0 });
    } else {
      const streak = (Number(prevState.bridgeFailStreak) || 0) + 1;
      await writeState({
        bridgeFailStreak: streak,
        bridgeOnline: streak >= 3 ? false : wasOnline,
      });
    }
    // #region agent log
    fetch('http://127.0.0.1:7383/ingest/5054654b-aba0-404a-ac16-c602aa116055',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d429e3'},body:JSON.stringify({sessionId:'d429e3',hypothesisId:'K',location:'background.js:bridgeToPet',message:'bridge push result',data:{kind:String(payload?.kind||''),priority:payload?.priority||null,httpStatus:res.status,online,wasOnline,failStreak:online?0:((Number(prevState.bridgeFailStreak)||0)+1)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  
    if (online && !wasOnline) {
      void recoverBridgeAccount();
    }
    if (online) {
      void pollAndRunPetCommands();
    }
    return online;
  } catch (err) {
    const prevState = await readState().catch(() => ({ bridgeOnline: false }));
    const wasOnline = Boolean(prevState?.bridgeOnline);
    const streak = (Number(prevState?.bridgeFailStreak) || 0) + 1;
    await writeState({
      bridgeFailStreak: streak,
      bridgeOnline: streak >= 3 ? false : wasOnline,
    });
    // #region agent log
    fetch('http://127.0.0.1:7383/ingest/5054654b-aba0-404a-ac16-c602aa116055',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d429e3'},body:JSON.stringify({sessionId:'d429e3',hypothesisId:'K',location:'background.js:bridgeToPet',message:'bridge push threw',data:{kind:String(payload?.kind||''),err:String(err?.message||err).slice(0,120),wasOnline,failStreak:streak},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return false;
  }
}

async function recoverBridgeAccount() {
  if (bridgeRecovering) return;
  bridgeRecovering = true;
  try {
    await syncAccountFromCookies({ force: true });
    await pushExtensionHeartbeat();
  } catch (err) {
    console.warn('[bili-pet] bridge recover failed:', err?.message || err);
  } finally {
    bridgeRecovering = false;
  }
}

async function pushAccountEvent(kind, account) {
  const settings = await getSettings();
  const cookieHeader = await getBiliCookieHeader();
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
    cookieHeader: cookieHeader || undefined,
  };
  await writeState({
    biliAccount: {
      uid: account?.uid ?? null,
      loggedIn: Boolean(account?.loggedIn),
      updatedAt: payload.ts,
    },
  });
  await pushRealtime(payload, settings);

  if (cookieHeader && account?.uid) {
    await pushRealtime(
      {
        v: cfg.SCHEMA_VERSION,
        source: cfg.SOURCE,
        kind: 'account_auth_cookie',
        ts: Date.now(),
        priority: 'high',
        account: {
          uid: account.uid,
          loggedIn: true,
        },
        cookieHeader,
      },
      settings
    );
  }
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

  const uidChanged =
    prev !== undefined && String(prev || '') !== String(uid || '');

  if (uid) {
    const kind = prev === undefined || force ? 'account_hello' : 'account_login';
    await pushAccountEvent(kind, account);
    if (uidChanged) scheduleReloadBilibiliTabs('account_switch');
    return { ok: true, account };
  }

  if (force) {
    return { ok: false, account: { uid: null, loggedIn: false, source: account.source || 'none' } };
  }

  if (prev === undefined || prev) {
    await pushAccountEvent('account_logout', { uid: null, loggedIn: false });
    if (uidChanged) scheduleReloadBilibiliTabs('account_logout');
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
    const byName = new Map();
    const merge = (list) => {
      for (const c of list || []) {
        if (!c?.name) continue;
        // Prefer non-empty values; later sources overwrite
        if (c.value != null && String(c.value) !== '') {
          byName.set(c.name, String(c.value));
        }
      }
    };

    merge(await chrome.cookies.getAll({ domain: 'bilibili.com' }));
    merge(await chrome.cookies.getAll({ domain: '.bilibili.com' }));

    const urls = [
      'https://www.bilibili.com/',
      'https://bilibili.com/',
      'https://api.bilibili.com/',
      'https://passport.bilibili.com/',
      'https://account.bilibili.com/',
    ];
    for (const url of urls) {
      try {
        merge(await chrome.cookies.getAll({ url }));
      } catch {
        /* ignore per-url failures */
      }
    }

    if (!byName.size) return '';
    return [...byName.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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
      async ([state, settings, account]) => {
        // Live probe so popup isn't stuck on stale bridgeOnline=false
        let liveOnline = null;
        let probeErr = null;
        if (settings.realtimePush) {
          try {
            const res = await fetch(cfg.BRIDGE_URL.replace(/\/event$/, '/health'), {
              method: 'GET',
            });
            // health may 404; treat any TCP success as online — fallback POST
            if (res.ok) {
              liveOnline = true;
            } else {
              const ping = await fetch(cfg.BRIDGE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  v: cfg.SCHEMA_VERSION,
                  source: cfg.SOURCE,
                  kind: 'extension_heartbeat',
                  ts: Date.now(),
                  priority: 'low',
                  probe: true,
                }),
              });
              liveOnline = ping.ok;
            }
          } catch (err) {
            liveOnline = false;
            probeErr = String(err?.message || err).slice(0, 80);
          }
          if (liveOnline != null && liveOnline !== Boolean(state.bridgeOnline)) {
            await writeState({ bridgeOnline: liveOnline });
            state = { ...state, bridgeOnline: liveOnline };
          }
        }
        // #region agent log
        fetch('http://127.0.0.1:7383/ingest/5054654b-aba0-404a-ac16-c602aa116055',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d429e3'},body:JSON.stringify({sessionId:'d429e3',hypothesisId:'L',location:'background.js:GET_STATE',message:'popup state probe',data:{storedOnline:Boolean(state.bridgeOnline),liveOnline,probeErr,realtimePush:Boolean(settings.realtimePush)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
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

async function pushExtensionHeartbeat() {
  const settings = await getSettings();
  if (!settings.realtimePush) return false;
  const account = await getBiliAccount();
  const cookieHeader = account?.uid ? await getBiliCookieHeader() : null;
  const cookieOk = Boolean(
    cookieHeader &&
      /(?:^|;\s*)bili_jct=/.test(cookieHeader) &&
      /(?:^|;\s*)SESSDATA=/.test(cookieHeader)
  );
  return pushRealtime(
    {
      v: cfg.SCHEMA_VERSION,
      source: cfg.SOURCE,
      kind: 'extension_heartbeat',
      ts: Date.now(),
      priority: 'low',
      account: {
        uid: account?.uid ?? null,
        loggedIn: Boolean(account?.uid),
      },
      cookieHeader: cookieHeader || undefined,
      cookieOk,
    },
    settings
  );
}

function cookieFieldFromHeader(header, name) {
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`);
  const m = String(header || '').match(re);
  return m ? decodeURIComponent(m[1].trim()) : '';
}

function mapBiliApiFailure(data, fallback) {
  const code = data?.code;
  const raw = String(data?.message || data?.msg || '').trim();
  if (code === -400 || raw === '请求错误') {
    return {
      ok: false,
      error: 'api',
      code,
      message:
        'B 站拒绝了请求（参数/登录态异常）。请打开任意已登录的 bilibili.com 页面后再试一次。',
      data,
    };
  }
  if (code === -101 || code === -111) {
    return {
      ok: false,
      error: 'api',
      code,
      message: 'B 站登录已失效，请在浏览器重新登录后再试。',
      data,
    };
  }
  if (code === -352 || code === -412) {
    return {
      ok: false,
      error: 'api',
      code,
      message: 'B 站风控拦截了这次请求，稍后再试或先在网页里手动收藏一次。',
      data,
    };
  }
  return {
    ok: false,
    error: 'api',
    code,
    message: raw || fallback || `B站返回 ${code}`,
    data,
  };
}

async function pickBiliTabId() {
  try {
    const tabs = await chrome.tabs.query({
      url: ['*://*.bilibili.com/*', '*://bilibili.com/*'],
    });
    const usable = (tabs || []).filter(
      (t) => t?.id && t.url && !/passport\.bilibili\.com/i.test(t.url)
    );
    const httpsPreferred =
      usable.find((t) => /www\.bilibili\.com/i.test(t.url || '')) || usable[0];
    return httpsPreferred?.id || null;
  } catch {
    return null;
  }
}

/**
 * 在已打开的 B 站页面主世界发请求（自动带 SESSDATA），比 SW 里手塞 Cookie 稳得多。
 */
async function biliFetchJsonViaTab(url, { method = 'GET', form = null } = {}) {
  const tabId = await pickBiliTabId();
  if (!tabId) {
    return {
      ok: false,
      error: 'no_tab',
      message: '请先打开一个已登录的 B 站页面（www.bilibili.com），再试一次。',
    };
  }

  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [url, method, form],
      func: async (reqUrl, reqMethod, reqForm) => {
        const headers = {
          Accept: 'application/json, text/plain, */*',
        };
        let body;
        if (reqMethod !== 'GET' && reqForm && typeof reqForm === 'object') {
          const csrfMatch = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]*)/);
          const csrf = csrfMatch ? decodeURIComponent(csrfMatch[1]) : '';
          if (!csrf) {
            return {
              ok: false,
              error: 'no_csrf',
              message: '页面里没有 bili_jct，请确认已登录 B 站。',
            };
          }
          headers['Content-Type'] =
            'application/x-www-form-urlencoded;charset=UTF-8';
          const params = new URLSearchParams({ ...reqForm, csrf });
          body = params.toString();
        }
        const res = await fetch(reqUrl, {
          method: reqMethod,
          credentials: 'include',
          headers,
          body,
        });
        let data = null;
        try {
          data = await res.json();
        } catch {
          return {
            ok: false,
            error: 'bad_json',
            message: `HTTP ${res.status}`,
          };
        }
        return { ok: true, httpStatus: res.status, data };
      },
    });

    if (!result) {
      return {
        ok: false,
        error: 'inject_failed',
        message: '无法在 B 站页面执行请求，请刷新该页面后再试。',
      };
    }
    if (!result.ok) {
      return {
        ok: false,
        error: result.error || 'page_fetch',
        message: result.message || '页面请求失败',
      };
    }
    const data = result.data;
    if (data?.code !== 0 && data?.code !== '0') {
      return mapBiliApiFailure(data, 'B站请求失败');
    }
    return { ok: true, data: data?.data ?? data, raw: data };
  } catch (err) {
    return {
      ok: false,
      error: 'scripting',
      message: `页面请求失败：${err?.message || err}`,
    };
  }
}

async function biliFormPost(url, form) {
  const viaTab = await biliFetchJsonViaTab(url, { method: 'POST', form });
  if (viaTab.ok || viaTab.error === 'no_tab') {
    if (viaTab.ok) return viaTab;
  } else if (viaTab.error !== 'scripting' && viaTab.error !== 'inject_failed') {
    if (viaTab.code != null || viaTab.error === 'api' || viaTab.error === 'no_csrf') {
      return viaTab;
    }
  }

  const cookie = await getBiliCookieHeader();
  const csrf = cookieFieldFromHeader(cookie, 'bili_jct');
  if (!cookie || !csrf) {
    return (
      viaTab || {
        ok: false,
        error: 'no_csrf',
        message: '浏览器里没有完整的 B 站登录 Cookie（需要 SESSDATA 与 bili_jct）。',
      }
    );
  }
  const body = new URLSearchParams({ ...form, csrf }).toString();
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
        Accept: 'application/json, text/plain, */*',
      },
      body,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      return { ok: false, error: 'bad_json', message: `HTTP ${res.status}` };
    }
    if (data?.code !== 0 && data?.code !== '0') {
      return mapBiliApiFailure(data, '加入失败');
    }
    return { ok: true, data: data?.data ?? data, raw: data };
  } catch (err) {
    return viaTab.ok === false
      ? viaTab
      : { ok: false, error: 'network', message: err?.message || String(err) };
  }
}

async function biliGetJson(url) {
  const viaTab = await biliFetchJsonViaTab(url, { method: 'GET' });
  if (viaTab.ok) return viaTab;
  if (viaTab.error === 'api' || viaTab.error === 'no_csrf') return viaTab;

  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
      },
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      return viaTab.error
        ? viaTab
        : { ok: false, error: 'bad_json', message: `HTTP ${res.status}` };
    }
    if (data?.code !== 0 && data?.code !== '0') {
      return mapBiliApiFailure(data, 'B站请求失败');
    }
    return { ok: true, data: data?.data ?? data };
  } catch {
    return viaTab;
  }
}

async function resolveBvidMeta(bvid) {
  const key = String(bvid || '').trim();
  const result = await biliGetJson(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(key)}`
  );
  if (!result.ok) return result;
  const d = result.data || {};
  return {
    ok: true,
    aid: Number(d.aid) || 0,
    bvid: String(d.bvid || key).trim(),
    title: String(d.title || '').trim(),
  };
}

async function getDedeUserIdReliable() {
  const urls = [
    'https://www.bilibili.com',
    'https://bilibili.com',
    'https://api.bilibili.com',
  ];
  for (const url of urls) {
    try {
      const c = await chrome.cookies.get({ url, name: 'DedeUserID' });
      const uid = String(c?.value || '').trim();
      if (uid && uid !== '0') return uid;
    } catch {
      /* ignore */
    }
  }
  const header = await getBiliCookieHeader();
  const fromHeader = cookieFieldFromHeader(header, 'DedeUserID');
  return fromHeader && fromHeader !== '0' ? fromHeader : '';
}

/**
 * 收藏整段放在 B 站页面主世界执行，避免 SW 侧 Cookie/mid 为空导致 -400。
 */
async function favoriteViaBiliTab(bvid) {
  const tabId = await pickBiliTabId();
  if (!tabId) {
    return {
      ok: false,
      error: 'no_tab',
      message: '请先打开一个已登录的 B 站页面（www.bilibili.com），再试一次。',
    };
  }

  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [String(bvid || '').trim()],
      func: async (targetBvid) => {
        const readCookie = (name) => {
          const m = document.cookie.match(
            new RegExp(`(?:^|;\\s*)${name}=([^;]*)`)
          );
          return m ? decodeURIComponent(m[1]) : '';
        };

        const csrf = readCookie('bili_jct');
        if (!csrf) {
          return {
            ok: false,
            error: 'no_csrf',
            message: '当前 B 站页面未登录（缺少 bili_jct）。请登录后刷新页面再试。',
          };
        }

        let mid = readCookie('DedeUserID');
        if (!mid || mid === '0') {
          try {
            const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', {
              credentials: 'include',
            }).then((r) => r.json());
            mid = String(nav?.data?.mid || '');
          } catch {
            mid = '';
          }
        }
        if (!mid || mid === '0') {
          return {
            ok: false,
            error: 'no_mid',
            message: '无法识别 B 站账号 UID，请确认已登录。',
          };
        }

        const view = await fetch(
          `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(targetBvid)}`,
          { credentials: 'include' }
        ).then((r) => r.json());
        if (view?.code !== 0) {
          return {
            ok: false,
            error: 'api',
            code: view?.code,
            message: String(view?.message || '找不到该视频'),
          };
        }
        const aid = Number(view?.data?.aid) || 0;
        const title = String(view?.data?.title || '').trim();
        const bvidOut = String(view?.data?.bvid || targetBvid).trim();
        if (!aid) {
          return { ok: false, error: 'no_aid', message: '无法解析视频 avid' };
        }

        const foldersRes = await fetch(
          `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(mid)}`,
          { credentials: 'include' }
        ).then((r) => r.json());
        if (foldersRes?.code !== 0) {
          return {
            ok: false,
            error: 'api',
            code: foldersRes?.code,
            message: String(foldersRes?.message || '获取收藏夹失败'),
          };
        }
        const list = Array.isArray(foldersRes?.data?.list)
          ? foldersRes.data.list
          : [];
        const folder =
          list.find((f) => /默认收藏夹/.test(String(f?.title || ''))) ||
          list[0];
        const mediaId = Number(folder?.id);
        if (!mediaId) {
          return {
            ok: false,
            error: 'no_folder',
            message: '没有找到可用的收藏夹，请先在 B 站创建收藏夹。',
          };
        }

        const body = new URLSearchParams({
          rid: String(aid),
          type: '2',
          add_media_ids: String(mediaId),
          csrf,
        });
        const deal = await fetch(
          'https://api.bilibili.com/x/v3/fav/resource/deal',
          {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type':
                'application/x-www-form-urlencoded;charset=UTF-8',
            },
            body: body.toString(),
          }
        ).then((r) => r.json());

        const folderTitle = String(folder.title || '默认收藏夹');
        if (deal?.code === 11201 || /已经收藏/.test(String(deal?.message || ''))) {
          return {
            ok: true,
            already: true,
            message: `「${title || bvidOut}」已在「${folderTitle}」里。`,
            data: { bvid: bvidOut, title, folderTitle, mediaId },
          };
        }
        if (deal?.code !== 0) {
          return {
            ok: false,
            error: 'api',
            code: deal?.code,
            message: String(deal?.message || `收藏失败(${deal?.code})`),
          };
        }
        return {
          ok: true,
          message: `已把「${title || bvidOut}」加入 B 站「${folderTitle}」。`,
          data: { bvid: bvidOut, title, folderTitle, mediaId },
        };
      },
    });

    if (!result) {
      return {
        ok: false,
        error: 'inject_failed',
        message: '无法在 B 站页面执行收藏，请刷新该页面后再试。',
      };
    }
    return result;
  } catch (err) {
    return {
      ok: false,
      error: 'scripting',
      message: `页面收藏失败：${err?.message || err}`,
    };
  }
}

async function recentWatchedViaBiliTab() {
  const tabId = await pickBiliTabId();
  if (!tabId) {
    return {
      ok: false,
      error: 'no_tab',
      message: '请先打开一个已登录的 B 站页面（www.bilibili.com），再试一次。',
    };
  }
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const urls = [
          'https://api.bilibili.com/x/web-interface/history/cursor?max=0&view_at=0&business=archive&ps=10',
          'https://api.bilibili.com/x/web-interface/history/cursor?max=0&view_at=0&ps=10',
        ];
        let hist = null;
        for (const url of urls) {
          try {
            hist = await fetch(url, { credentials: 'include' }).then((r) =>
              r.json()
            );
            if (hist?.code === 0) break;
          } catch {
            /* try next */
          }
        }
        if (!hist || hist.code !== 0) {
          return {
            ok: false,
            error: 'api',
            code: hist?.code,
            message: String(hist?.message || '获取观看记录失败'),
          };
        }
        const list = Array.isArray(hist?.data?.list) ? hist.data.list : [];
        for (const item of list) {
          const h = item?.history || item || {};
          const biz = String(h.business || item?.business || '');
          const bvid = String(h.bvid || item?.bvid || '').trim();
          const aid = Number(h.oid || h.aid || item?.aid) || 0;
          if (biz && !/^(archive|pgc)$/i.test(biz) && !bvid) continue;
          if (bvid) {
            return {
              ok: true,
              data: {
                bvid,
                aid: aid || undefined,
                title: String(item?.title || '').trim(),
              },
            };
          }
          if (aid && (!biz || biz === 'archive' || biz === 'pgc')) {
            try {
              const view = await fetch(
                `https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(aid)}`,
                { credentials: 'include' }
              ).then((r) => r.json());
              if (view?.code === 0 && view?.data?.bvid) {
                return {
                  ok: true,
                  data: {
                    bvid: view.data.bvid,
                    aid,
                    title: String(view.data.title || item?.title || '').trim(),
                  },
                };
              }
            } catch {
              /* continue */
            }
          }
        }
        return {
          ok: false,
          error: 'empty_history',
          message: '观看记录里没有找到视频稿件。',
        };
      },
    });
    if (!result) {
      return {
        ok: false,
        error: 'inject_failed',
        message: '无法在 B 站页面读取观看记录，请刷新页面后再试。',
      };
    }
    return result;
  } catch (err) {
    return {
      ok: false,
      error: 'scripting',
      message: `读取观看记录失败：${err?.message || err}`,
    };
  }
}

async function executePetCommand(cmd) {
  const action = String(cmd?.action || '').trim();
  const bvid = String(cmd?.bvid || '').trim();

  if (action === 'watch_later') {
    if (!bvid) {
      return { id: cmd.id, ok: false, error: 'no_bvid', message: '缺少 BV 号' };
    }
    const posted = await biliFormPost(
      'https://api.bilibili.com/x/v2/history/toview/add',
      { bvid }
    );
    if (!posted.ok) {
      if (posted.code === 90001 || /已经/.test(String(posted.message || ''))) {
        const meta = await resolveBvidMeta(bvid);
        return {
          id: cmd.id,
          ok: true,
          already: true,
          message: `「${meta.title || bvid}」已在 B 站稍后再看里。`,
          data: { bvid, title: meta.title || '' },
        };
      }
      return { id: cmd.id, ok: false, error: posted.error, message: posted.message, code: posted.code };
    }
    const meta = await resolveBvidMeta(bvid);
    return {
      id: cmd.id,
      ok: true,
      message: `已把「${meta.title || bvid}」加入 B 站稍后再看。`,
      data: { bvid, title: meta.title || '' },
    };
  }

  if (action === 'favorite') {
    if (!bvid) {
      return { id: cmd.id, ok: false, error: 'no_bvid', message: '缺少 BV 号' };
    }

    const viaPage = await favoriteViaBiliTab(bvid);
    if (viaPage?.ok) {
      return {
        id: cmd.id,
        ok: true,
        already: Boolean(viaPage.already),
        message: viaPage.message,
        data: viaPage.data,
      };
    }

    // 页面路径失败时，再用可靠 UID 兜底一次（避免空 up_mid）
    const mid = await getDedeUserIdReliable();
    if (!mid) {
      return {
        id: cmd.id,
        ok: false,
        error: viaPage?.error || 'no_mid',
        message:
          viaPage?.message ||
          '无法识别 B 站账号。请打开已登录的 www.bilibili.com 后再试。',
        code: viaPage?.code,
      };
    }

    const meta = await resolveBvidMeta(bvid);
    if (!meta.ok || !meta.aid) {
      return {
        id: cmd.id,
        ok: false,
        error: meta.error || 'not_found',
        message: meta.message || viaPage?.message || '找不到该视频',
        code: meta.code,
      };
    }
    const folders = await biliGetJson(
      `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(mid)}`
    );
    if (!folders.ok) {
      return {
        id: cmd.id,
        ok: false,
        error: folders.error,
        message: folders.message || viaPage?.message || '获取收藏夹失败',
        code: folders.code,
      };
    }
    const list = Array.isArray(folders.data?.list) ? folders.data.list : [];
    const folder =
      list.find((f) => /默认收藏夹/.test(String(f?.title || ''))) || list[0];
    const mediaId = Number(folder?.id);
    if (!mediaId) {
      return {
        id: cmd.id,
        ok: false,
        error: 'no_folder',
        message: '没有找到可用的收藏夹',
      };
    }
    const posted = await biliFormPost(
      'https://api.bilibili.com/x/v3/fav/resource/deal',
      {
        rid: String(meta.aid),
        type: '2',
        add_media_ids: String(mediaId),
      }
    );
    if (!posted.ok) {
      if (posted.code === 11201 || /已经收藏/.test(String(posted.message || ''))) {
        return {
          id: cmd.id,
          ok: true,
          already: true,
          message: `「${meta.title || bvid}」已在「${folder.title || '默认收藏夹'}」里。`,
          data: { bvid, title: meta.title, folderTitle: folder.title },
        };
      }
      return {
        id: cmd.id,
        ok: false,
        error: posted.error,
        message: posted.message || viaPage?.message,
        code: posted.code,
      };
    }
    return {
      id: cmd.id,
      ok: true,
      message: `已把「${meta.title || bvid}」加入 B 站「${folder.title || '默认收藏夹'}」。`,
      data: { bvid, title: meta.title, folderTitle: folder.title },
    };
  }

  if (action === 'recent_watched') {
    const viaPage = await recentWatchedViaBiliTab();
    if (viaPage?.ok && viaPage.data?.bvid) {
      return {
        id: cmd.id,
        ok: true,
        message: 'ok',
        data: viaPage.data,
      };
    }
    return {
      id: cmd.id,
      ok: false,
      error: viaPage?.error || 'empty_history',
      message: viaPage?.message || '观看记录里没有找到视频稿件。',
      code: viaPage?.code,
    };
  }

  return {
    id: cmd.id,
    ok: false,
    error: 'unknown_action',
    message: `未知操作：${action}`,
  };
}

async function postCommandResult(result) {
  try {
    await fetch(`http://${'127.0.0.1'}:39261/commands/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    });
  } catch {
    /* pet may be offline */
  }
}

async function pollAndRunPetCommands() {
  let data;
  try {
    const res = await fetch('http://127.0.0.1:39261/commands', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  const commands = Array.isArray(data?.commands) ? data.commands : [];
  for (const cmd of commands) {
    try {
      const result = await executePetCommand(cmd);
      await postCommandResult(result);
    } catch (err) {
      await postCommandResult({
        id: cmd?.id,
        ok: false,
        error: 'exception',
        message: String(err?.message || err),
      });
    }
  }
}

chrome.cookies.onChanged.addListener((changeInfo) => {
  const c = changeInfo?.cookie;
  if (!c || c.name !== 'DedeUserID') return;
  if (!String(c.domain || '').includes('bilibili.com')) return;
  void syncAccountFromCookies();
});

// 心跳要够密：宠物启动后靠它解锁；太稀会表现为「登录了却要等一会儿」
chrome.alarms.create('bili-pet-heartbeat', { periodInMinutes: 0.15 });
chrome.alarms.create('bili-pet-flush', { periodInMinutes: 0.5 });
chrome.alarms.create('bili-pet-commands', { periodInMinutes: 0.05 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'bili-pet-commands') {
    await pollAndRunPetCommands();
    return;
  }
  if (alarm.name === 'bili-pet-heartbeat') {
    await syncAccountFromCookies();
    await pushExtensionHeartbeat();
    return;
  }
  if (alarm.name !== 'bili-pet-flush') return;
  const settings = await getSettings();
  await flushQueue(settings);
  await syncAccountFromCookies();
  await pushExtensionHeartbeat();
  await pollAndRunPetCommands();
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await setSettings(DEFAULT_SETTINGS);
  // 强制下一趟推送走「离线→在线」恢复逻辑
  await writeState({ bridgeOnline: false });
  await syncAccountFromCookies({ force: true });
  await pushExtensionHeartbeat();
});

chrome.runtime.onStartup?.addListener?.(async () => {
  await writeState({ bridgeOnline: false });
  await syncAccountFromCookies({ force: true });
  await pushExtensionHeartbeat();
});

void (async () => {
  await writeState({ bridgeOnline: false });
  await syncAccountFromCookies();
  await pushExtensionHeartbeat();
})();
//明天更改的账号绑定逻辑，数据这块儿做的跟屎一样
