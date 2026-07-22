/**
 * 专注向行为监控：只关心「离开视频 / 失去专注」
 * 不采集评论内容、不报滑动噪音。
 */
const BiliActions = (() => {
  const lastSent = new Map();

  function emit(type, detail = {}) {
    const cfg = globalThis.BILI_PET_CONFIG || {};
    const debounce = cfg.ACTION_DEBOUNCE_MS ?? 400;
    // 同一视频短时间多种失焦（blur + tab_hidden）合并为一次
    const key =
      type === 'exit_video'
        ? `exit_video:${detail.bvid || ''}`
        : `${type}:${detail.reason || ''}:${detail.bvid || ''}`;
    const now = Date.now();
    const windowMs = type === 'exit_video' ? Math.max(debounce, 1200) : debounce;
    if (now - (lastSent.get(key) || 0) < windowMs) return;
    lastSent.set(key, now);

    const schema = globalThis.BiliSchema;
    const payload = schema
      ? schema.envelope('focus_break', {
          type,
          detail: sanitizeDetail(detail),
          url: location.pathname + location.search,
          sessionId: detail.sessionId,
          bvid: detail.bvid,
          cid: detail.cid,
          title: detail.title,
          currentTime: detail.currentTime,
          ts: now,
        })
      : {
          kind: 'focus_break',
          type,
          detail: sanitizeDetail(detail),
          ts: now,
        };

    try {
      chrome.runtime.sendMessage({ type: 'BILI_PET_EVENT', payload });
    } catch (_) {
      /* extension context invalidated */
    }
  }

  /** 隐私：只保留专注判断需要的字段 */
  function sanitizeDetail(detail) {
    return {
      reason: detail.reason || null,
      target: detail.target || 'video',
      nextBvid: detail.nextBvid || null,
      paused: detail.paused,
      force: undefined,
    };
  }

  /**
   * 退出 / 失焦监控
   * reasons: pagehide | tab_hidden | window_blur | route_change | switch_bvid
   */
  function watchFocusBreaks(getContext) {
    let leftForHidden = false;

    const leave = (reason) => {
      const ctx = typeof getContext === 'function' ? getContext() : {};
      emit('exit_video', {
        target: 'video',
        reason,
        ...ctx,
      });
    };

    const onPageHide = () => leave('pagehide');

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        leftForHidden = true;
        leave('tab_hidden');
      } else if (leftForHidden) {
        leftForHidden = false;
        // 回到标签：记一条恢复，供专注统计
        const ctx = typeof getContext === 'function' ? getContext() : {};
        try {
          chrome.runtime.sendMessage({
            type: 'BILI_PET_EVENT',
            payload: (globalThis.BiliSchema || { envelope: (_, d) => d }).envelope(
              'focus_resume',
              {
                reason: 'tab_visible',
                sessionId: ctx.sessionId,
                bvid: ctx.bvid,
                currentTime: ctx.currentTime,
                url: location.pathname + location.search,
              }
            ),
          });
        } catch (_) {}
      }
    };

    const onBlur = () => {
      // 切到别的应用；避免与 tab_hidden 重复：仅在仍可见时记
      if (document.visibilityState === 'visible') leave('window_blur');
    };

    let lastUrl = location.href;
    const urlTimer = setInterval(() => {
      if (location.href === lastUrl) return;
      const prev = lastUrl;
      lastUrl = location.href;
      if (/\/video\/BV/i.test(prev)) leave('route_change');
    }, 500);

    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);

    return () => {
      clearInterval(urlTimer);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
    };
  }

  return { emit, watchFocusBreaks };
})();

globalThis.BiliActions = BiliActions;
