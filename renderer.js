const speechBubble = document.getElementById('speech-bubble');
const petSprite = document.getElementById('pet-sprite');

const FOCUS_REASON = {
  pagehide: '你去哪儿啦？',
  tab_hidden: '真的还在听课吗......?',
  window_blur: '已发现走神',
  route_change: '这就不学啦？',
  switch_bvid: '为啥换视频啊？',
};

const ANIM = {
  wait: 'assets/wait.gif',
  watch: 'assets/watch.gif',
  point: 'assets/point.gif',
};

/** point.gif 单次播放时长（与资源帧延迟一致） */
const POINT_DURATION_MS = 2000;

let hideTimer = null;
let pinned = false; // 用户点击固定显示
let lastSubtitleText = '';

/** 基态：未播放 wait，正在播放 watch */
let baseAnim = 'wait';
/** 是否正在播 point（一次性） */
let pointing = false;
let pointTimer = null;
let currentSrc = '';

function showBubble(text, { holdMs = 4500, important = false } = {}) {
  if (!speechBubble || !text) return;
  speechBubble.textContent = text;
  speechBubble.hidden = false;

  if (hideTimer) clearTimeout(hideTimer);
  if (pinned) return;

  const ms = important ? Math.max(holdMs, 6000) : holdMs;
  hideTimer = setTimeout(() => {
    if (!pinned) speechBubble.hidden = true;
  }, ms);
}

function fmtTime(sec) {
  if (sec == null || Number.isNaN(Number(sec))) return '';
  const s = Math.max(0, Math.floor(Number(sec)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function setSpriteSrc(path, { restart = false } = {}) {
  if (!petSprite) return;
  if (!restart && currentSrc === path) return;
  currentSrc = path;
  // 加时间戳强制重播 GIF（尤其是 point 每次 hover）
  petSprite.src = restart ? `${path}?t=${Date.now()}` : path;
}

function applyBaseAnim() {
  pointing = false;
  if (pointTimer) {
    clearTimeout(pointTimer);
    pointTimer = null;
  }
  setSpriteSrc(ANIM[baseAnim]);
}

function setWatching(watching) {
  const next = watching ? 'watch' : 'wait';
  if (baseAnim === next) return;
  baseAnim = next;
  if (!pointing) applyBaseAnim();
}

function playPointOnce() {
  if (!petSprite || pointing) return;
  pointing = true;
  if (pointTimer) clearTimeout(pointTimer);
  setSpriteSrc(ANIM.point, { restart: true });
  pointTimer = setTimeout(() => {
    pointing = false;
    pointTimer = null;
    setSpriteSrc(ANIM[baseAnim]);
  }, POINT_DURATION_MS);
}

function handleEvent(payload) {
  if (!payload?.kind) return;

  switch (payload.kind) {
    case 'session_start':
      setWatching(true);
      showBubble('开始跟播啦，好好学习！', { holdMs: 3500 });
      break;

    case 'session_meta': {
      if (typeof payload.paused === 'boolean') {
        setWatching(!payload.paused);
      }
      const status = payload.subtitleStatus;
      if (status === 'empty') {
        showBubble('这个视频没有字幕，我先记进度', { holdMs: 4000 });
      } else if (status === 'need_login') {
        showBubble('登录 B 站后我才能拿到字幕哦', { holdMs: 5000, important: true });
      } else if (payload.title) {
        const title = String(payload.title).slice(0, 28);
        showBubble(`在看：${title}`, { holdMs: 4000 });
      }
      break;
    }

    case 'progress':
    case 'heartbeat': {
      if (typeof payload.paused === 'boolean') {
        setWatching(!payload.paused);
      } else {
        setWatching(true);
      }
      const line =
        payload.currentSubtitle?.content ||
        (payload.contextText || '').split('\n').filter(Boolean).pop() ||
        '';
      if (!line) break;
      if (line === lastSubtitleText && payload.kind === 'heartbeat') break;
      lastSubtitleText = line;
      const t = fmtTime(payload.currentTime);
      showBubble(t ? `${t}  ${line}` : line, { holdMs: 5000 });
      break;
    }

    case 'focus_break': {
      const reason = payload.detail?.reason || payload.reason;
      if (['pagehide', 'route_change', 'switch_bvid'].includes(reason)) {
        setWatching(false);
      }
      const text = FOCUS_REASON[reason] || '专注被打断了，快回来！';
      showBubble(text, { holdMs: 7000, important: true });
      petSprite?.classList.add('pet-alert');
      setTimeout(() => petSprite?.classList.remove('pet-alert'), 1200);
      break;
    }

    case 'focus_resume':
      setWatching(true);
      showBubble('欢迎回来，我们接着看～', { holdMs: 3500 });
      break;

    case 'session_end':
      setWatching(false);
      showBubble('本次跟播结束', { holdMs: 3000 });
      lastSubtitleText = '';
      break;

    case 'error':
      if (payload.scope === 'subtitle') {
        showBubble('字幕拉取失败，稍后重试', { holdMs: 4000 });
      }
      break;

    default:
      break;
  }
}

function togglePinBubble() {
  if (!speechBubble) return;
  pinned = !pinned;
  if (pinned) {
    if (speechBubble.hidden) {
      speechBubble.textContent = lastSubtitleText || '已固定气泡，再点一下取消';
      speechBubble.hidden = false;
    }
  } else {
    speechBubble.hidden = true;
  }
}

/** 在 no-drag 上自实现拖窗，这样 hover / 点击 / 拖动都能用 */
const DRAG_THRESHOLD = 4;
let dragState = null;

petSprite?.addEventListener('mouseenter', () => {
  playPointOnce();
});

petSprite?.addEventListener('mouseleave', () => {
  // 提前移开则立刻回到 wait/watch
  if (pointing) applyBaseAnim();
});

petSprite?.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragState = {
    pointerId: e.pointerId,
    startX: e.screenX,
    startY: e.screenY,
    lastX: e.screenX,
    lastY: e.screenY,
    moved: false,
  };
  petSprite.setPointerCapture?.(e.pointerId);
});

petSprite?.addEventListener('pointermove', (e) => {
  if (!dragState || dragState.pointerId !== e.pointerId) return;
  const dx = e.screenX - dragState.lastX;
  const dy = e.screenY - dragState.lastY;
  if (!dragState.moved) {
    const total =
      Math.abs(e.screenX - dragState.startX) + Math.abs(e.screenY - dragState.startY);
    if (total < DRAG_THRESHOLD) return;
    dragState.moved = true;
  }
  dragState.lastX = e.screenX;
  dragState.lastY = e.screenY;
  window.biliPet?.moveBy?.(dx, dy);
});

petSprite?.addEventListener('pointerup', (e) => {
  if (!dragState || dragState.pointerId !== e.pointerId) return;
  const wasClick = !dragState.moved;
  dragState = null;
  petSprite.releasePointerCapture?.(e.pointerId);
  if (wasClick) togglePinBubble();
});

petSprite?.addEventListener('pointercancel', () => {
  dragState = null;
});

// 初始：宠物打开且未播放 → wait
applyBaseAnim();

if (window.biliPet?.onEvent) {
  window.biliPet.onEvent(handleEvent);
  window.biliPet.getLatest?.().then((latest) => {
    if (latest) handleEvent(latest);
  });
} else {
  showBubble('桥接未就绪', { holdMs: 3000 });
}
