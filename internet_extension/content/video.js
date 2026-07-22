/**
 * 视频页：只锁定当前 BV，字幕按观看进度拼成一条长字符串。
 */
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
    /** 防止换片后旧请求回写 */
    loadToken: 0,
  };

  function parseBvid(url = location.href) {
    const m = url.match(/\/video\/(BV[\w]+)/i);
    return m ? m[1] : null;
  }

  function parsePage() {
    const m = location.search.match(/[?&]p=(\d+)/);
    return m ? Number(m[1]) : 1;
  }

  function findVideoElement() {
    return (
      document.querySelector('video') ||
      document.querySelector('.bpx-player-video-wrap video') ||
      null
    );
  }

  function send(payload) {
    if (!state.enabled && payload.kind !== 'settings_ack') return;
    try {
      chrome.runtime.sendMessage({ type: 'BILI_PET_EVENT', payload });
    } catch (_) {}
  }

  function getContext() {
    return {
      sessionId: state.sessionId,
      bvid: state.bvid,
      cid: state.cid,
      title: state.title,
      currentTime: state.videoEl?.currentTime ?? state.lastTime,
      paused: Boolean(state.videoEl?.paused),
    };
  }

  function resetTranscript() {
    state.transcript = '';
    state.seenLineKeys = new Set();
  }

  function appendTranscriptLine(line) {
    if (!line?.content) return false;
    const key = `${line.from ?? ''}|${line.to ?? ''}|${line.content}`;
    if (state.seenLineKeys.has(key)) return false;
    state.seenLineKeys.add(key);
    const text = String(line.content).trim();
    if (!text) return false;
    state.transcript = state.transcript ? `${state.transcript}\n${text}` : text;
    return true;
  }

  function packIsForCurrent(pack) {
    if (!pack?.lock) return false;
    if (pack.lock.bvid !== state.bvid) return false;
    if (state.cid != null && pack.lock.cid != null && String(pack.lock.cid) !== String(state.cid)) {
      return false;
    }
    return true;
  }

  async function refreshSettings() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'BILI_PET_GET_SETTINGS' });
      state.enabled = res?.settings?.recordingEnabled !== false;
    } catch (_) {
      state.enabled = true;
    }
  }

  function stopSubtitleRetries() {
    if (state.subtitleRetryTimer) {
      clearInterval(state.subtitleRetryTimer);
      state.subtitleRetryTimer = null;
    }
  }

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
  }

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
  }

  function buildSubtitleSlice(t) {
    const pack = state.subtitlePack;
    if (!packIsForCurrent(pack)) {
      return { currentSubtitle: null, contextText: '', transcriptText: state.transcript };
    }
    const body = pack.body || [];
    const current = BiliSubtitle.atTime(body, t);
    return {
      currentSubtitle: current
        ? { from: current.from, to: current.to, content: current.content }
        : null,
      contextText: current?.content || '',
      transcriptText: state.transcript,
    };
  }

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
        })
      );
    }
  }

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
  }

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
        state.videoEl.addEventListener('timeupdate', () => syncProgress(false));
        state.videoEl.addEventListener('seeked', () => syncProgress(true));
        syncProgress(true);
      }
    }, 250);
  }

  BiliActions.watchFocusBreaks(getContext);

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
