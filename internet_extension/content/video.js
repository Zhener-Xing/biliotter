(() => {
  const cfg = BILI_PET_CONFIG;
  const schema = BiliSchema;

  const state = {
    enabled: true,
    sessionId: null,
    bvid: null,
    cid: null,
    title: '',
    owner: '',
    /** resolveCid 精简字段，供 buildModelInput */
    videoMeta: null,
    subtitlePack: null,
    /** 本片已看过的字幕，拼成一条长串 */
    transcript: '',
    seenLineKeys: new Set(),
    lastTime: -1,
    lastLineKey: '',
    lastBridgeAt: 0,
    videoEl: null,
    startedAt: 0,
    subtitleRetryTimer: null,
    subtitleRetries: 0,
    loadToken: 0,
  };

  function parseBvid(url = location.href) {
    const m = url.match(/\/video\/(BV[\w]+)/i);
    return m ? m[1] : null;
  }//解析BVID

  function parsePage() {
    const m = location.search.match(/[?&]p=(\d+)/);
    return m ? Number(m[1]) : 1;
  }//解析页码

  function findVideoElement() {
    return (
      document.querySelector('video') ||
      document.querySelector('.bpx-player-video-wrap video') ||
      null
    );
  }//查找视频元素

  function send(payload) {
    if (!state.enabled && payload.kind !== 'settings_ack') return;
    try {
      chrome.runtime.sendMessage({ type: 'BILI_PET_EVENT', payload });
    } catch (_) {}
  }//发送事件

  /** 从页面 Cookie / 初始态解析 UID，供 Cookie API 漏读时兜底 */
  function readPageUid() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)DedeUserID=([^;]+)/);
      const fromCookie = m ? String(m[1] || '').trim() : '';
      if (fromCookie && fromCookie !== '0') return fromCookie;
    } catch (_) {}
    try {
      const mid =
        window.__INITIAL_STATE__?.loginInfo?.mid ||
        window.__INITIAL_STATE__?.userInfo?.mid ||
        window.__BILI_CONFIG__?.uid ||
        null;
      const s = mid != null ? String(mid).trim() : '';
      if (s && s !== '0') return s;
    } catch (_) {}
    return null;
  }

  function reportAccountHint() {
    const uid = readPageUid();
    if (!uid) return;
    try {
      chrome.runtime.sendMessage({ type: 'BILI_PET_ACCOUNT_HINT', uid });
    } catch (_) {}
  }

  function getContext() {
    const el = state.videoEl;
    return {
      sessionId: state.sessionId,
      bvid: state.bvid,
      cid: state.cid,
      title: state.title,
      currentTime: el?.currentTime ?? state.lastTime,
      // 尚无 video 时视为暂停，避免误报「播放中滑动」
      paused: el ? Boolean(el.paused) : true,
      hasVideo: Boolean(el),
    };
  }//获取上下文

  function resetTranscript() {
    state.transcript = '';
    state.seenLineKeys = new Set();
  }//重置转录

  function appendTranscriptLine(line) {
    if (!line?.content) return false;
    const key = `${line.from ?? ''}|${line.to ?? ''}|${line.content}`;
    if (state.seenLineKeys.has(key)) return false;
    state.seenLineKeys.add(key);
    const text = String(line.content).trim();
    if (!text) return false;
    state.transcript = state.transcript ? `${state.transcript}\n${text}` : text;
    return true;
  }//添加转录行

  function seedTranscriptUpTo(t) {
    const body = state.subtitlePack?.body;
    if (!Array.isArray(body) || !body.length) return;
    const at = Number(t);
    if (!Number.isFinite(at) || at < 0) return;
    const lines = body
      .slice()
      .sort((a, b) => (a.from || 0) - (b.from || 0))
      .filter((line) => Number(line?.from ?? 0) <= at + 0.35);
    for (const line of lines) appendTranscriptLine(line);
  }

  function packIsForCurrent(pack) {
    if (!pack?.lock) return false;
    if (pack.lock.bvid !== state.bvid) return false;
    if (state.cid != null && pack.lock.cid != null && String(pack.lock.cid) !== String(state.cid)) {
      return false;
    }
    return true;
  }//包是否当前视频

  async function refreshSettings() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'BILI_PET_GET_SETTINGS' });
      state.enabled = res?.settings?.recordingEnabled !== false;
    } catch (_) {
      state.enabled = true;
    }
  }//刷新设置

  function stopSubtitleRetries() {
    if (state.subtitleRetryTimer) {
      clearInterval(state.subtitleRetryTimer);
      state.subtitleRetryTimer = null;
    }
  }//停止字幕重试

  function scheduleSubtitleRetries() {
    stopSubtitleRetries();
    state.subtitleRetries = 0;
    state.subtitleRetryTimer = setInterval(() => {
      state.subtitleRetries += 1;
      if (state.subtitleRetries > 12) {
        stopSubtitleRetries();
        return;
      }
      if (state.subtitlePack?.status === 'ok' && state.subtitlePack.body?.length) {
        stopSubtitleRetries();
        return;
      }
      ensureSubtitles({ force: true });
    }, 4000);
  }//计划字幕重试 

  async function ensureSubtitles({ force = false } = {}) {
    if (!state.bvid) return null;
    const token = ++state.loadToken;
    const lockedBvid = state.bvid;
    const page = parsePage();

    try {
      const meta = await BiliSubtitle.resolveCid(lockedBvid, page);
      if (token !== state.loadToken || state.bvid !== lockedBvid) return null;

      state.cid = meta.cid;
      state.title = meta.title;
      state.owner = meta.owner || '';
      state.videoMeta = {
        bvid: meta.bvid,
        aid: meta.aid,
        title: meta.title,
        owner: meta.owner || '',
        cid: meta.cid,
        page: meta.page,
        part: meta.part,
        duration: meta.duration,
      };

      const pack = await BiliSubtitle.load(lockedBvid, meta.cid, { force });
      if (token !== state.loadToken || state.bvid !== lockedBvid) return null;
      if (!packIsForCurrent(pack)) return null;

      // 换轨/重载时必须清空旧长串，否则会把串台内容拼进去
      resetTranscript();
      state.subtitlePack = pack;

      send(
        schema.envelope('session_meta', {
          ...getContext(),
          owner: state.owner,
          subtitleStatus: pack.status,
          lan: pack.meta?.lan || null,
          lineCount: pack.body?.length || 0,
          needLogin: Boolean(pack.meta?.needLogin),
          transcriptText: state.transcript,
          fullSubtitleText: pack.fullText || '',
        })
      );

      if (pack.status === 'ok' && pack.body?.length) {
        stopSubtitleRetries();
        const t =
          state.videoEl?.currentTime ??
          (state.lastTime >= 0 ? state.lastTime : 0);
        seedTranscriptUpTo(t);
        syncProgress(true);
      } else {
        scheduleSubtitleRetries();
      }
      return pack;
    } catch (err) {
      if (token !== state.loadToken || state.bvid !== lockedBvid) return null;
      send(
        schema.envelope('error', {
          scope: 'subtitle',
          message: String(err.message || err),
          sessionId: state.sessionId,
          bvid: state.bvid,
        })
      );
      scheduleSubtitleRetries();
      return null;
    }
  }//构建字幕切片

  function buildSubtitleSlice(t) {
    const pack = state.subtitlePack;
    if (!packIsForCurrent(pack)) {
      return {
        currentSubtitle: null,
        contextText: '',
        transcriptText: state.transcript,
        modelInput: null,
      };
    }
    const body = pack.body || [];
    const before = cfg.SUBTITLE_CONTEXT_BEFORE_SEC ?? 20;
    const after = cfg.SUBTITLE_CONTEXT_AFTER_SEC ?? 8;
    const lines = BiliSubtitle.windowAround(body, t, before, after);
    const current = BiliSubtitle.atTime(body, t);
    const currentSubtitle = current
      ? { from: current.from, to: current.to, content: current.content }
      : null;
    const text = schema.contextText(lines);
    const modelInput = schema.buildModelInput({
      meta: state.videoMeta || {
        bvid: state.bvid,
        cid: state.cid,
        title: state.title,
        owner: state.owner,
      },
      lines,
      t,
      currentSubtitle,
      sessionId: state.sessionId,
      paused: state.videoEl?.paused,
    });
    return {
      currentSubtitle,
      contextText: text,
      transcriptText: state.transcript,
      modelInput,
    };
  }//同步进度

  function syncProgress(force = false) {
    if (!state.enabled) return;
    const video = state.videoEl || findVideoElement();
    state.videoEl = video;
    if (!video || !state.bvid || !state.sessionId) return;
    if (!packIsForCurrent(state.subtitlePack)) return;

    const t = video.currentTime || 0;
    if (!force && Math.abs(t - state.lastTime) < 0.2) return;
    state.lastTime = t;

    const slice = buildSubtitleSlice(t);
    let transcriptChanged = false;
    if (slice.currentSubtitle) {
      transcriptChanged = appendTranscriptLine(slice.currentSubtitle);
      slice.transcriptText = state.transcript;
    }

    const lineKey = slice.currentSubtitle
      ? `${slice.currentSubtitle.from}-${slice.currentSubtitle.to}`
      : `t:${t.toFixed(0)}`;

    const progressed =
      force ||
      transcriptChanged ||
      lineKey !== state.lastLineKey ||
      Math.abs(t - (state._lastRecordedTime || 0)) >= cfg.SUBTITLE_SYNC_STEP_SEC;

    if (progressed) {
      state.lastLineKey = lineKey;
      state._lastRecordedTime = t;
      send(
        schema.envelope('progress', {
          ...getContext(),
          priority: 'normal',
          subtitleStatus: state.subtitlePack?.status || null,
          currentSubtitle: slice.currentSubtitle,
          contextText: slice.contextText,
          transcriptText: state.transcript,
          modelInput: slice.modelInput,
        })
      );
    }

    const now = Date.now();
    if (now - state.lastBridgeAt >= cfg.BRIDGE_THROTTLE_MS) {
      state.lastBridgeAt = now;
      send(
        schema.envelope('heartbeat', {
          ...getContext(),
          priority: 'low',
          subtitleStatus: state.subtitlePack?.status || null,
          currentSubtitle: slice.currentSubtitle,
          contextText: slice.contextText,
          transcriptText: state.transcript,
          modelInput: slice.modelInput,
        })
      );
    }
  }//发送心跳

  function endSession(reason) {
    if (!state.sessionId) return;
    stopSubtitleRetries();
    send(
      schema.envelope('session_end', {
        priority: 'high',
        sessionId: state.sessionId,
        bvid: state.bvid,
        cid: state.cid,
        title: state.title,
        currentTime: state.videoEl?.currentTime ?? state.lastTime,
        reason,
        startedAt: state.startedAt,
        durationMs: Date.now() - (state.startedAt || Date.now()),
        transcriptText: state.transcript,
      })
    );
  }//结束会话

  async function bootForCurrentVideo() {
    await refreshSettings();
    if (!state.enabled) return;

    const bvid = parseBvid();
    if (!bvid) return;

    if (state.sessionId && state.bvid && state.bvid !== bvid) {
      BiliActions.emit('exit_video', {
        reason: 'switch_bvid',
        nextBvid: bvid,
        ...getContext(),
        force: true,
      });
      endSession('switch_bvid');
      BiliSubtitle.clearCache(state.bvid);
    }

    stopSubtitleRetries();
    state.loadToken += 1;
    state.bvid = bvid;
    state.cid = null;
    state.videoMeta = null;
    state.sessionId = schema.newSessionId(bvid);
    state.subtitlePack = null;
    state.lastLineKey = '';
    state.lastTime = -1;
    state.startedAt = Date.now();
    resetTranscript();
    BiliSubtitle.clearCache();

    send(
      schema.envelope('session_start', {
        priority: 'high',
        sessionId: state.sessionId,
        bvid,
        url: location.pathname + location.search,
        page: parsePage(),
        transcriptText: '',
      })
    );

    await ensureSubtitles({ force: true });

    let tries = 0;
    const waitVideo = setInterval(() => {
      state.videoEl = findVideoElement();
      tries += 1;
      if (state.videoEl || tries > 40) {
        clearInterval(waitVideo);
        if (!state.videoEl) return;
        seedTranscriptUpTo(state.videoEl.currentTime || 0);
        state.videoEl.addEventListener('timeupdate', () => syncProgress(false));
        state.videoEl.addEventListener('seeked', () => syncProgress(true));
        syncProgress(true);
      }
    }, 250);
  }//启动当前视频

  BiliActions.watchFocusBreaks(getContext);
  reportAccountHint();
  setTimeout(reportAccountHint, 1500);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    state.enabled = changes.settings.newValue?.recordingEnabled !== false;
    if (!state.enabled) endSession('recording_disabled');
  });

  bootForCurrentVideo();

  let href = location.href;
  setInterval(() => {
    if (location.href === href) return;
    href = location.href;
    if (parseBvid()) bootForCurrentVideo();
  }, 800);

  setInterval(() => syncProgress(false), cfg.PROGRESS_INTERVAL_MS);
})();
