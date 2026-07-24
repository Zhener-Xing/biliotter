const petSprite = document.getElementById('pet-sprite');

const EXIT_VIDEO_REASONS = new Set([
  'pagehide',
  'tab_hidden',
  'window_blur',
  'route_change',
  'switch_bvid',
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

const FRAME_MS = 500;
const DOUBLE_CLICK_MS = 280;

let baseAnim = 'wait';
let pointing = false;
let sequencePlaying = false;
let frameIndex = 0;
let frameTimer = null;
let currentSrc = '';
let clickTimer = null;

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

function applyBaseAnim() {
  pointing = false;
  sequencePlaying = false;
  startFrameLoop(ANIM[baseAnim]);
}

function setWatching(watching) {
  const next = watching ? 'watch' : 'wait';
  if (baseAnim === next) return;
  baseAnim = next;
  if (!pointing && !sequencePlaying) applyBaseAnim();
}

function playSequence(frames, loops = 1) {
  if (!petSprite || !frames?.length || sequencePlaying) return;
  pointing = false;
  sequencePlaying = true;
  stopFrameLoop();
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

function playPointOnce() {
  if (!petSprite || pointing || sequencePlaying) return;
  pointing = true;
  stopFrameLoop();
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
  if (sequencePlaying || now - lastQuestionAt < QUESTION_COOLDOWN_MS) return;
  lastQuestionAt = now;
  playSfx('assets/noise/distrcted.mp3');
  playSequence(ANIM.question, 2);
}

function playAnnoyedOnce() {
  playSfx('assets/noise/go-off.mp3');
  playSequence(ANIM.annoyed, 1);
}

async function openNotesPage() {
  await window.biliPet?.openNotesPage?.();
}

async function goHome() {
  await window.biliPet?.goHome?.();
}

function handlePetClick() {
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
    goHome();
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = null;
    openNotesPage();
  }, DOUBLE_CLICK_MS);
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
        playAnnoyedOnce();
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
      playAnnoyedOnce();
      break;

    case 'account_hello':
    case 'account_login': {
      if (payload.ok === false || payload.bindStatus === 'mismatch') {
        setWatching(false);
        if (payload.bindStatus === 'mismatch') playQuestionOnce();
        break;
      }
      playPointOnce();
      break;
    }

    case 'account_logout':
      setWatching(false);
      break;

    case 'account_mismatch':
      setWatching(false);
      if (payload.status === 'mismatch') playQuestionOnce();
      break;

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
