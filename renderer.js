const petSprite = document.getElementById('pet-sprite');
const petBubble = document.getElementById('pet-bubble');

const EXIT_VIDEO_REASONS = new Set([
  'pagehide',
  'tab_hidden',
  'window_blur',
  'route_change',
  'switch_bvid',
]);

/** 仅切换浏览器页面/标签时播 annoyed；切应用、关会话等不再 annoyed */
const ANNOYED_REASONS = new Set([
  'tab_hidden',
  'pagehide',
  'route_change',
]);

const PET_DISPLAY_SCALE = 96 / 101;

const ANIM = {
  wait: ['assets/waiting/waiting1.png', 'assets/waiting/waiting2.png'],
  watch: ['assets/close-eyes/close-eyes1.png', 'assets/close-eyes/close-eyes2.png'],
  point: [
    'assets/look-away/look-away1.png',
    'assets/look-away/look.png',
    'assets/look-away/look-away2.png',
  ],
  annoyed: [
    'assets/getting-annoyed/getting-annoyed1.png',
    'assets/getting-annoyed/getting-annoyed3.png',
    'assets/getting-annoyed/getting-annoyed2.png',
    'assets/getting-annoyed/getting-annoyed2.png',
  ],
  question: [
    'assets/question/question1.png',
    'assets/question/question2.png',
  ],
};

const DANCE_BUFFER = [
  { src: 'assets/dancing-buffer/1-4.png', x: -8 },
  { src: 'assets/dancing-buffer/2.png', x: -16 },
  { src: 'assets/dancing-buffer/3.png', x: -22 },
  { src: 'assets/dancing-buffer/1-4.png', x: 8 },
  { src: 'assets/dancing-buffer/5.png', x: 16 },
  { src: 'assets/dancing-buffer/6.png', x: 22 },
];

const FRAME_MS = 500;
const DANCE_FRAME_MS = 200;
const DOUBLE_CLICK_MS = 280;
const BUBBLE_MS = 4200;
const DANCE_MAX_MS = 5000;

const SYNC_BUFFER_START = new Set([
]);
const SYNC_BUFFER_PULL_REASONS = new Set([]);

let baseAnim = 'wait';
let pointing = false;
let sequencePlaying = false;
let syncBuffering = false;
let gameDance = false;
let frameIndex = 0;
let frameTimer = null;
let currentSrc = '';
let clickTimer = null;
let bubbleTimer = null;
let danceCapTimer = null;

const GATE_MESSAGES = {
  extension_offline: '浏览器插件未在线，请打开扩展并保持 B 站登录',
  not_bound: '请先登录 B 站账号',
  syncing: '数据拉取中',
  pulling: '数据拉取中',
  waiting_auth: '正在用 B 站登录态连接云端…',
  waiting_auth_uid_match: '正在用 B 站登录态连接云端…',
  waiting_cookie: '请打开已登录的 bilibili.com，以便同步知识库',
  auth_failed: '云端鉴权失败，请刷新 B 站登录后重试',
  not_logged_in: '云端鉴权失败，请刷新 B 站登录后重试',
  pull_timeout: '数据拉取中',
  pull_error: '数据拉取中',
  first_pull_blocked: '数据拉取中',
  cloud_disabled: '未配置云端，无法使用好友功能',
};

let dataPullWinPlayedForUid = null;
/** 当前 uid 的云端首拉已完成（之后后台定时 pull 不再提示「数据拉取中」） */
let cloudPullReadyUid = null;

function hidePetBubble() {
  if (!petBubble) return;
  petBubble.hidden = true;
  if (bubbleTimer) {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
  }
}

function isAwaitingCloudPull(uid = '') {
  const id = String(uid || '');
  if (!id) return cloudPullReadyUid == null;
  return cloudPullReadyUid !== id;
}

function showPetBubble(text, ms = BUBBLE_MS) {
  if (!petBubble) return;
  const msg = String(text || '').trim();
  if (!msg) return;
  petBubble.textContent = msg;
  petBubble.hidden = false;
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    petBubble.hidden = true;
    bubbleTimer = null;
  }, ms);
}

function gateBubbleText(error, message) {
  if (message) return String(message);
  return GATE_MESSAGES[error] || GATE_MESSAGES.not_bound;
}

for (const step of DANCE_BUFFER) {
  const img = new Image();
  img.src = step.src;
}

function applySpriteDisplaySize() {
  if (!petSprite?.naturalWidth) return;
  petSprite.style.width = `${Math.round(petSprite.naturalWidth * PET_DISPLAY_SCALE)}px`;
  petSprite.style.height = `${Math.round(petSprite.naturalHeight * PET_DISPLAY_SCALE)}px`;
}

function setSpriteSrc(path) {
  if (!petSprite) return;
  if (currentSrc === path) return;
  currentSrc = path;
  const onLoad = () => {
    applySpriteDisplaySize();
    petSprite.removeEventListener('load', onLoad);
  };
  petSprite.addEventListener('load', onLoad);
  petSprite.src = path;
  if (petSprite.complete && petSprite.naturalWidth) applySpriteDisplaySize();
}

function stopFrameLoop() {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
}

function startFrameLoop(frames) {
  stopFrameLoop();
  frameIndex = 0;
  if (!frames?.length) return;
  setSpriteSrc(frames[0]);
  if (frames.length === 1) return;
  frameTimer = setInterval(() => {
    frameIndex = (frameIndex + 1) % frames.length;
    setSpriteSrc(frames[frameIndex]);
  }, FRAME_MS);
}

function clearDanceOffset() {
  if (!petSprite) return;
  petSprite.classList.remove('pet-dancing');
  petSprite.style.transform = '';
}

function applyDanceFrame(step) {
  if (!petSprite || !step) return;
  petSprite.classList.add('pet-dancing');
  petSprite.style.transform = `translateX(${step.x}px)`;
  setSpriteSrc(step.src);
}

function startDanceBuffer() {
  if (!petSprite || syncBuffering) return;
  if (gameDance) stopGameDance();
  syncBuffering = true;
  pointing = false;
  sequencePlaying = false;
  stopFrameLoop();
  frameIndex = 0;
  applyDanceFrame(DANCE_BUFFER[0]);
  frameTimer = setInterval(() => {
    frameIndex = (frameIndex + 1) % DANCE_BUFFER.length;
    applyDanceFrame(DANCE_BUFFER[frameIndex]);
  }, DANCE_FRAME_MS);
  if (danceCapTimer) clearTimeout(danceCapTimer);
  danceCapTimer = setTimeout(() => {
    danceCapTimer = null;
    if (syncBuffering) {
      stopDanceBuffer();
      showPetBubble(GATE_MESSAGES.pull_timeout);
    }
  }, DANCE_MAX_MS);
}

function stopDanceBuffer() {
  if (danceCapTimer) {
    clearTimeout(danceCapTimer);
    danceCapTimer = null;
  }
  if (!syncBuffering) return;
  syncBuffering = false;
  stopFrameLoop();
  clearDanceOffset();
  if (!gameDance) applyBaseAnim();
}

function startGameDance() {
  if (!petSprite || gameDance) return;
  gameDance = true;
  pointing = false;
  sequencePlaying = false;
  stopFrameLoop();
  frameIndex = 0;
  applyDanceFrame(DANCE_BUFFER[0]);
  frameTimer = setInterval(() => {
    frameIndex = (frameIndex + 1) % DANCE_BUFFER.length;
    applyDanceFrame(DANCE_BUFFER[frameIndex]);
  }, DANCE_FRAME_MS);
}

function stopGameDance() {
  if (!gameDance) return;
  gameDance = false;
  stopFrameLoop();
  clearDanceOffset();
  if (!syncBuffering) applyBaseAnim();
}

function applyBaseAnim() {
  if (syncBuffering || gameDance) return;
  pointing = false;
  sequencePlaying = false;
  clearDanceOffset();
  startFrameLoop(ANIM[baseAnim]);
}

function setWatching(watching) {
  const next = watching ? 'watch' : 'wait';
  if (baseAnim === next) return;
  baseAnim = next;
  if (!syncBuffering && !gameDance && !pointing && !sequencePlaying) applyBaseAnim();
}

function playSequence(frames, loops = 1) {
  if (!petSprite || !frames?.length || sequencePlaying || syncBuffering || gameDance) return;
  pointing = false;
  sequencePlaying = true;
  stopFrameLoop();
  clearDanceOffset();
  frameIndex = 0;
  let loopCount = 0;
  setSpriteSrc(frames[0]);
  frameTimer = setInterval(() => {
    frameIndex += 1;
    if (frameIndex >= frames.length) {
      loopCount += 1;
      frameIndex = 0;
      if (loopCount >= loops) {
        sequencePlaying = false;
        startFrameLoop(ANIM[baseAnim]);
        return;
      }
    }
    setSpriteSrc(frames[frameIndex]);
  }, FRAME_MS);
}

/**
 * 摸头反应：dancing-buffer 循环 2 次 → look-away 循环 1 次 → 回到待机/专注。
 * 可打断普通序列，但不打断账号同步舞 / 游戏出题舞。
 */
function playPetHeadAnim() {
  if (!petSprite || syncBuffering || gameDance) return;
  pointing = false;
  sequencePlaying = true;
  stopFrameLoop();
  frameIndex = 0;
  let danceLoops = 0;
  applyDanceFrame(DANCE_BUFFER[0]);

  frameTimer = setInterval(() => {
    frameIndex += 1;
    if (frameIndex >= DANCE_BUFFER.length) {
      danceLoops += 1;
      frameIndex = 0;
      if (danceLoops >= 2) {
        stopFrameLoop();
        clearDanceOffset();
        // look-away 播一轮
        const look = ANIM.point;
        let lookIndex = 0;
        setSpriteSrc(look[0]);
        frameTimer = setInterval(() => {
          lookIndex += 1;
          if (lookIndex >= look.length) {
            sequencePlaying = false;
            stopFrameLoop();
            applyBaseAnim();
            return;
          }
          setSpriteSrc(look[lookIndex]);
        }, FRAME_MS);
        return;
      }
    }
    applyDanceFrame(DANCE_BUFFER[frameIndex]);
  }, DANCE_FRAME_MS);
}

function playPointOnce() {
  if (!petSprite || pointing || sequencePlaying || syncBuffering || gameDance) return;
  pointing = true;
  stopFrameLoop();
  clearDanceOffset();
  const frames = ANIM.point;
  frameIndex = 0;
  setSpriteSrc(frames[0]);
  frameTimer = setInterval(() => {
    frameIndex += 1;
    if (frameIndex >= frames.length) {
      pointing = false;
      startFrameLoop(ANIM[baseAnim]);
      return;
    }
    setSpriteSrc(frames[frameIndex]);
  }, FRAME_MS);
}

let lastQuestionAt = 0;
const QUESTION_COOLDOWN_MS = 4500;
function playQuestionOnce() {
  const now = Date.now();
  if (syncBuffering || gameDance || sequencePlaying || now - lastQuestionAt < QUESTION_COOLDOWN_MS) {
    return;
  }
  lastQuestionAt = now;
  playSfx('assets/noise/distrcted.mp3');
  playSequence(ANIM.question, 2);
}

function playAnnoyedOnce() {
  if (syncBuffering || gameDance) return;
  playSfx('assets/noise/go-off.mp3');
  playSequence(ANIM.annoyed, 1);
}

async function openNotesPage() {
  const result = await window.biliPet?.openNotesPage?.();
  if (result && result.ok === false) {
    showPetBubble(gateBubbleText(result.error, result.message));
  }
}

async function goHome() {
  const result = await window.biliPet?.goHome?.();
  if (result && result.ok === false) {
    showPetBubble(gateBubbleText(result.error, result.message));
  }
}

async function openFriendsPage() {
  const result = await window.biliPet?.openFriendsPage?.();
  if (result && result.ok === false) {
    showPetBubble(gateBubbleText(result.error, result.message));
  }
}

function handlePetClick() {
  // 切号/登录同步中：跳舞占住交互，避免打开旧账号知识库
  if (syncBuffering || gameDance) return;
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    goHome();
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = null;
    if (syncBuffering || gameDance) return;
    openNotesPage();
  }, DOUBLE_CLICK_MS);
}

function shouldStartAccountBuffer(payload) {
  // 立即打开：登录/同步不再开跳舞缓冲
  return false;
}

function shouldStopAccountBuffer(payload) {
  const kind = String(payload?.kind || '');
  if (kind === 'kb_account_ready' || kind === 'account_switched' || kind === 'local_ready') {
    return true;
  }
  const status = String(payload?.status || '');
  if (
    status === 'account_switched' ||
    status === 'local_ready' ||
    status === 'ready' ||
    status === 'pull_error' ||
    status === 'pull_timeout' ||
    status === 'auth_error' ||
    status === 'first_pull_blocked'
  ) {
    return true;
  }
  return false;
}

function handleEvent(payload) {
  if (!payload?.kind) return;

  switch (payload.kind) {
    case 'session_start':
      setWatching(true);
      break;

    case 'session_meta': {
      if (typeof payload.paused === 'boolean') {
        setWatching(!payload.paused);
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
      break;
    }

    case 'focus_break': {
      const reason = payload.detail?.reason || payload.reason;
      const breakType = payload.type;

      if (breakType === 'ui_scroll' || reason === 'scroll') {
        playQuestionOnce();
      } else if (EXIT_VIDEO_REASONS.has(reason) || breakType === 'exit_video') {
        setWatching(false);
        if (ANNOYED_REASONS.has(reason)) {
          playAnnoyedOnce();
        }
      }

      petSprite?.classList.add('pet-alert');
      setTimeout(() => petSprite?.classList.remove('pet-alert'), 1200);
      break;
    }

    case 'focus_resume':
      setWatching(true);
      break;

    case 'session_end':
      setWatching(false);
      break;

    case 'account_hello':
    case 'account_login': {
      if (payload.ok === false) {
        setWatching(false);
        stopDanceBuffer();
        break;
      }
      // 切号/首次绑定：立刻开跳舞缓冲（不等后续 sync_state）
      if (shouldStartAccountBuffer(payload)) {
        startDanceBuffer();
      } else {
        playPointOnce();
      }
      break;
    }

    case 'account_switched':
      stopDanceBuffer();
      break;

    case 'sync_state': {
      const status = String(payload.status || '');
      const uid = String(payload.uid || '');
      const awaiting = isAwaitingCloudPull(uid);
      // 仅云端首拉（本地无该 uid 库、知识库尚不可进）时提示；已有本地库或后台 pull 不再挡
      if (
        awaiting &&
        payload.opsReady === false &&
        (status === 'syncing_login' ||
          status === 'switching' ||
          status === 'pulling' ||
          status === 'first_pull_blocked' ||
          status === 'local_ready')
      ) {
        if (uid) dataPullWinPlayedForUid = null;
        showPetBubble('数据拉取中', 12000);
      } else if (
        status === 'ready' &&
        payload.dataPullDone &&
        payload.opsReady
      ) {
        if (uid) cloudPullReadyUid = uid;
        // 命中本地库：直接可用，不弹「数据拉取中/完成」
        if (payload.fromLocal || payload.reason === 'local_sqlite_hit') {
          hidePetBubble();
          stopDanceBuffer();
        } else if (!payload.background || payload.pulled) {
          hidePetBubble();
          showPetBubble('数据拉取完成', 3500);
          if (uid && dataPullWinPlayedForUid !== uid) {
            dataPullWinPlayedForUid = uid;
            playSfx('assets/noise/win.mp3');
          }
          stopDanceBuffer();
        }
      } else if (status === 'local_ready' || status === 'account_switched') {
        stopDanceBuffer();
      } else if (shouldStopAccountBuffer(payload)) {
        stopDanceBuffer();
      }
      break;
    }

    case 'kb_account_ready': {
      stopDanceBuffer();
      const uid = String(payload.uid || '');
      if (payload.dataPullDone && uid) {
        cloudPullReadyUid = uid;
        if (dataPullWinPlayedForUid !== uid) {
          dataPullWinPlayedForUid = uid;
          hidePetBubble();
          showPetBubble('数据拉取完成', 3500);
          playSfx('assets/noise/win.mp3');
        }
      }
      break;
    }

    case 'pet_gate_blocked':
      showPetBubble(gateBubbleText(payload.error, payload.message));
      petSprite?.classList.add('pet-alert');
      setTimeout(() => petSprite?.classList.remove('pet-alert'), 1200);
      break;

    case 'extension_offline':
      setWatching(false);
      stopDanceBuffer();
      showPetBubble(gateBubbleText('extension_offline', payload.message));
      petSprite?.classList.add('pet-alert');
      setTimeout(() => petSprite?.classList.remove('pet-alert'), 1200);
      break;

    case 'extension_online':
      break;

    case 'account_logout':
    case 'account_logged_out':
      setWatching(false);
      dataPullWinPlayedForUid = null;
      cloudPullReadyUid = null;
      showPetBubble('已退出登录');
      break;

    case 'account_purged':
      setWatching(false);
      stopDanceBuffer();
      break;

    case 'purge_blocked':
    case 'switch_blocked': {
      // 后台清旧号失败：不打扰当前体验
      const purgeReason = String(payload.purgeReason || payload.reason || '');
      if (
        purgeReason === 'switch_push_old' ||
        purgeReason === 'orphan_sweep' ||
        purgeReason === 'orphan_flush' ||
        purgeReason === 'background_purge' ||
        purgeReason.includes('switch_push')
      ) {
        break;
      }
      stopDanceBuffer();
      if (payload.kind === 'switch_blocked') {
        showPetBubble('切号未完成，仍保留当前账号');
      }
      console.warn(
        '[bili-pet]',
        payload.kind,
        payload.error || payload.reason || 'blocked'
      );
      break;
    }

    case 'account_mismatch':
      setWatching(false);
      if (payload.status === 'mismatch') playQuestionOnce();
      break;

    case 'game_generating':
      startGameDance();
      break;

    case 'game_generating_end':
    case 'game_play_start':
      stopGameDance();
      break;

    case 'game_play_end':
      stopGameDance();
      break;

    case 'friend_pet': {
      const msg = String(payload.message || '').trim();
      if (msg) showPetBubble(msg, 6500);
      playPetHeadAnim();
      petSprite?.classList.add('pet-alert');
      setTimeout(() => petSprite?.classList.remove('pet-alert'), 1200);
      break;
    }

    case 'friend_note_offer': {
      const msg = String(payload.message || '').trim();
      if (msg) showPetBubble(msg, 7000);
      playPointOnce();
      break;
    }

    default:
      break;
  }
}

const DRAG_THRESHOLD = 4;
let dragState = null;

petSprite?.addEventListener('mouseenter', () => {
  playPointOnce();
});

petSprite?.addEventListener('mouseleave', () => {
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
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
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
  if (wasClick) handlePetClick();
});

petSprite?.addEventListener('pointercancel', () => {
  dragState = null;
});

petSprite?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  openFriendsPage();
});

function playSfx(src) {
  return new Promise((resolve) => {
    const audio = new Audio(src);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    audio.addEventListener('ended', done);
    audio.addEventListener('error', done);
    audio.play().catch(done);
    setTimeout(done, 5000);
  });
}

playSfx('assets/noise/getting-in.mp3');

window.biliPet?.onClosing?.(() => {
  playSfx('assets/noise/closing.mp3').finally(() => {
    window.biliPet?.closingFinished?.();
  });
});

applyBaseAnim();

if (window.biliPet?.onEvent) {
  window.biliPet.onEvent(handleEvent);
  window.biliPet.getLatest?.().then((latest) => {
    if (latest) handleEvent(latest);
  });
}
