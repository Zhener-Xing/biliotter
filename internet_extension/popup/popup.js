function fmtTime(sec) {
  if (sec == null || Number.isNaN(sec)) return '--:--';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function fmtTs(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return '';
  }
}

function reasonLabel(reason) {
  const map = {
    pagehide: '关闭/离开页面',
    tab_hidden: '切换标签页',
    window_blur: '切到其他应用',
    route_change: '站内跳转离开',
    switch_bvid: '换了另一个视频',
    scroll: '滑动页面走神',
    tab_visible: '回到视频标签',
    recording_disabled: '关闭了采集',
  };
  return map[reason] || reason || '';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function render(state, settings) {
  const bridge = document.getElementById('bridge-status');
  if (!settings.realtimePush) {
    bridge.textContent = '实时推送：已关闭（仍可本地记录）';
    bridge.className = 'muted offline';
  } else {
    bridge.textContent = state.bridgeOnline
      ? '桌面宠物桥接：在线 · 实时推送中'
      : '桌面宠物桥接：离线（高优事件会排队重试）';
    bridge.className = `muted ${state.bridgeOnline ? 'online' : 'offline'}`;
  }

  const accountEl = document.getElementById('account-status');
  if (accountEl) {
    const acc = state.biliAccount || {};
    if (acc.loggedIn && acc.uid) {
      if (acc.cookieOk === false) {
        accountEl.textContent = `B 站账号：已识别 UID ${acc.uid}，但登录 Cookie 不完整（云端未连通）。请打开 bilibili.com 后点「重新同步账号」`;
        accountEl.className = 'muted offline';
      } else if (acc.cookieOk === true) {
        accountEl.textContent = `B 站账号：已登录 · UID ${acc.uid}（Cookie 齐全，可连云端）`;
        accountEl.className = 'muted online';
      } else {
        accountEl.textContent = `B 站账号：已登录 · UID ${acc.uid}（自动同步桌面宠）`;
        accountEl.className = 'muted online';
      }
    } else {
      accountEl.textContent =
        'B 站账号：未检测到登录 Cookie。请确认本 Chrome 已登录 B 站，或点下方「重新同步账号」';
      accountEl.className = 'muted offline';
    }
  }

  document.getElementById('recordingEnabled').checked = settings.recordingEnabled !== false;
  document.getElementById('realtimePush').checked = settings.realtimePush !== false;

  const current = document.getElementById('current');
  if (!settings.recordingEnabled) {
    current.className = 'card empty';
    current.textContent = '数据采集已关闭';
  } else if (!state.current?.bvid) {
    current.className = 'card empty';
    current.textContent = '打开 B 站视频页后这里会显示进度与字幕';
  } else {
    current.className = 'card';
    const status = state.current.subtitleStatus;
    const statusLabel =
      status === 'ok'
        ? '字幕：已加载'
        : status === 'need_login'
          ? '字幕：需要登录 B 站'
          : status === 'empty'
            ? '字幕：接口返回空（可尝试打开播放器 CC）'
            : status
              ? `字幕状态：${status}`
              : '字幕：未知';
    const sub =
      state.current.currentSubtitle?.content ||
      (state.current.transcriptText
        ? state.current.transcriptText.split('\n').filter(Boolean).slice(-1)[0]
        : '') ||
      `（当前无字幕句 · ${statusLabel}）`;
    const transcriptPreview = state.current.transcriptText
      ? state.current.transcriptText.length > 280
        ? `${state.current.transcriptText.slice(0, 280)}…`
        : state.current.transcriptText
      : '';
    current.innerHTML = `
      <div class="title">${escapeHtml(state.current.title || state.current.bvid)}</div>
      <div class="sub">${escapeHtml(state.current.bvid)} · ${fmtTime(state.current.currentTime)} ${
        state.current.paused ? '已暂停' : '播放中'
      }</div>
      <div class="sub">${escapeHtml(statusLabel)}</div>
      <div class="line">${escapeHtml(sub)}</div>
      ${
        transcriptPreview
          ? `<div class="line" style="margin-top:8px;opacity:.85;white-space:pre-wrap">${escapeHtml(
              transcriptPreview
            )}</div>`
          : ''
      }
    `;
  }

  const focusLog = document.getElementById('focus-log');
  focusLog.innerHTML = (state.recentFocusBreaks || [])
    .slice(0, 10)
    .map((item) => {
      const isResume = item.type === 'focus_resume';
      return `<li class="${isResume ? '' : 'break'}">
        <div>${isResume ? '恢复专注' : '专注中断'} · ${escapeHtml(reasonLabel(item.reason))}</div>
        <div class="meta">${fmtTs(item.ts)} · ${escapeHtml(item.bvid || '')} · ${fmtTime(
          item.currentTime
        )}</div>
      </li>`;
    })
    .join('') || '<li class="meta">暂无中断记录</li>';

  const subLog = document.getElementById('subtitle-log');
  subLog.innerHTML = (state.subtitleLog || [])
    .slice(0, 6)
    .map((item) => {
      const text = item.transcriptText || item.contextText || item.currentSubtitle?.content || '';
      const preview = text.length > 220 ? `${text.slice(0, 220)}…` : text;
      return `<li>
        <div style="white-space:pre-wrap">${escapeHtml(preview)}</div>
        <div class="meta">${escapeHtml(item.bvid || '')} · ${fmtTime(item.currentTime)} · ${fmtTs(
          item.ts
        )} · ${text.length}字</div>
      </li>`;
    })
    .join('') || '<li class="meta">暂无字幕记录</li>';
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: 'BILI_PET_GET_STATE' });
  if (res?.ok) render(res.state, res.settings || {});
}

async function patchSettings(patch) {
  await chrome.runtime.sendMessage({ type: 'BILI_PET_SET_SETTINGS', patch });
  refresh();
}

document.getElementById('recordingEnabled').addEventListener('change', (e) => {
  patchSettings({ recordingEnabled: e.target.checked });
});

document.getElementById('realtimePush').addEventListener('change', (e) => {
  patchSettings({ realtimePush: e.target.checked });
});

document.getElementById('refresh').addEventListener('click', refresh);

document.getElementById('sync-account')?.addEventListener('click', async () => {
  const accountEl = document.getElementById('account-status');
  if (accountEl) {
    accountEl.textContent = 'B 站账号：正在同步…';
    accountEl.className = 'muted';
  }
  const res = await chrome.runtime.sendMessage({ type: 'BILI_PET_SYNC_ACCOUNT' });
  if (res?.ok && res.account?.uid) {
    if (accountEl) {
      accountEl.textContent = `B 站账号：已登录 · UID ${res.account.uid}（已推送桌面宠）`;
      accountEl.className = 'muted online';
    }
  } else {
    if (accountEl) {
      accountEl.textContent =
        '仍未识别登录。请先打开任意 bilibili.com 标签页并保持登录，再点「重新同步账号」（需允许扩展新权限）';
      accountEl.className = 'muted offline';
    }
  }
});

document.getElementById('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'BILI_PET_CLEAR' });
  refresh();
});

document.getElementById('export').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'BILI_PET_EXPORT' });
  if (!res?.ok) return;
  const blob = new Blob([JSON.stringify(res.export, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bili-pet-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

refresh();
