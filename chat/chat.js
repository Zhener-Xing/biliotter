const chatRoot = document.getElementById('chat-root');
const chatTitle = document.getElementById('chat-title');
const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatClose = document.getElementById('chat-close');

const gamePanel = document.getElementById('game-panel');
const gameQuestion = document.getElementById('game-question');
const gameOptions = document.getElementById('game-options');
const gameFeedback = document.getElementById('game-feedback');
const gameRunCanvas = document.getElementById('game-run-canvas');
const gameOptionButtons = gameOptions
  ? Array.from(gameOptions.querySelectorAll('.game-option'))
  : [];

/** @type {{role:'user'|'assistant', content:string}[]} */
let chatMessages = [];
let chatBusy = false;
let gameBusy = false;
let inGameUi = false;
let gameConcluding = false;
/** @type {null | { mode?: string, q?: string, choices?: string[], disabled?: boolean }} */
let lastGameUi = null;

/* —— 答题界面奔跑动画 —— */
const GameRun = (() => {
  const SCALE = 1;
  const OTTER_W = 73;
  const OTTER_H = 76;
  const BODY_BELOW = 17; // dirt+grass under green plane (shared)
  const TILE_META = {
    'normal-ground1.png': { w: 44, h: 25, surfaceY: 8 },
    'normal-ground2.png': { w: 40, h: 25, surfaceY: 10 },
    'normal-ground3.png': { w: 43, h: 25, surfaceY: 8 },
    'normal-ground4.png': { w: 44, h: 25, surfaceY: 8 },
    'ground-obs1.png': { w: 44, h: 32, surfaceY: 15 },
    'ground-obs2.png': { w: 44, h: 32, surfaceY: 15 },
    'ground-obs3.png': { w: 44, h: 32, surfaceY: 15 },
  };
  const GROUND_FILES = [
    'normal-ground1.png',
    'normal-ground2.png',
    'normal-ground3.png',
    'normal-ground4.png',
  ];
  const OBS_FILES = ['ground-obs1.png', 'ground-obs2.png', 'ground-obs3.png'];
  const ASSET_BASE = '../assets/game-skills';
  const RUN_FRAME_MS = 140;
  const JUMP_UP_MS = 240;
  const JUMP_HANG_MS = 200;
  const JUMP_DOWN_MS = 280;
  // Obs top is 15px above green — clear with comfortable margin
  const JUMP_HEIGHT = 34;
  const SCROLL_SPEED = 55;
  const TILE_COUNT = 3;
  // Fixed stand point so tile width changes never shift the whole runway
  const STAND_LOCAL_X = 22;
  const HURT_BLINK_MS = 90;
  const HURT_BLINK_TOGGLES = 8; // 4 visible flashes

  const images = {};
  /** @type {{ file: string, x: number, isObs?: boolean }[]} */
  let tiles = [];
  let otterFrame = 0;
  let runAcc = 0;
  let jumping = false;
  let jumpPhase = 0;
  let jumpAcc = 0;
  let jumpLift = 0;
  let hurting = false;
  let hurtAcc = 0;
  let hurtToggles = 0;
  let hurtVisible = true;
  let scrollPaused = false;
  let running = false;
  let raf = 0;
  let lastTs = 0;
  /** @type {CanvasRenderingContext2D | null} */
  let ctx = null;
  let loadPromise = null;

  /** @type {null | {
   *   mode: 'clear' | 'hit',
   *   file: string,
   *   triggered: boolean,
   *   done: boolean,
   *   resolve: () => void,
   *   onImpact?: () => void
   * }} */
  let obstacleEvent = null;

  function meta(file) {
    return TILE_META[file] || TILE_META['normal-ground1.png'];
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function ensureAssets() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const otterFiles = ['1.png', '2.png', '3.png', 'up.png', 'down.png'];
      const groundFiles = [...GROUND_FILES, ...OBS_FILES];
      await Promise.all([
        ...otterFiles.map(async (f) => {
          images[f] = await loadImage(`${ASSET_BASE}/running-otter/${f}`);
        }),
        ...groundFiles.map(async (f) => {
          images[f] = await loadImage(`${ASSET_BASE}/running-ground/${f}`);
        }),
      ]);
    })();
    return loadPromise;
  }

  function pickGround(exclude) {
    const pool = GROUND_FILES.filter((f) => f !== exclude);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function pickObs() {
    return OBS_FILES[Math.floor(Math.random() * OBS_FILES.length)];
  }

  function resetTiles() {
    const right = pickGround();
    const mid = pickGround(right);
    const left = pickGround(mid);
    const midW = meta(mid).w;
    const leftW = meta(left).w;
    tiles = [
      { file: left, x: -midW - leftW },
      { file: mid, x: -midW },
      { file: right, x: 0 },
    ];
  }

  function rightTile() {
    return tiles[tiles.length - 1];
  }

  function ensureThreeTiles() {
    while (tiles.length < TILE_COUNT) {
      const first = tiles[0];
      const file = pickGround(first?.file);
      tiles.unshift({ file, x: (first?.x ?? 0) - meta(file).w });
    }
  }

  function advanceScroll(dt) {
    if (scrollPaused) return;
    const dx = (SCROLL_SPEED * dt) / 1000;
    for (const t of tiles) t.x += dx;
    const left = tiles[0];
    const mid = tiles[1];
    if (!left || !mid || mid.x < 0) return;

    // Shift so mid lands on 0 without teleporting the strip
    const excess = mid.x;
    for (const t of tiles) t.x -= excess;

    const newRight = { file: mid.file, x: 0, isObs: mid.isObs };
    const newMid = {
      file: left.file,
      x: left.x,
      isObs: left.isObs,
    };
    const newLeftFile = pickGround(newMid.file);
    tiles = [
      { file: newLeftFile, x: newMid.x - meta(newLeftFile).w },
      newMid,
      newRight,
    ];
  }

  function updateRunAnim(dt) {
    if (jumping || hurting) return;
    runAcc += dt;
    while (runAcc >= RUN_FRAME_MS) {
      runAcc -= RUN_FRAME_MS;
      otterFrame = (otterFrame + 1) % 3;
    }
  }

  function finishJump() {
    jumping = false;
    jumpPhase = 0;
    jumpLift = 0;
    otterFrame = 0;
    runAcc = 0;
    if (
      obstacleEvent &&
      obstacleEvent.mode === 'clear' &&
      obstacleEvent.triggered &&
      !obstacleEvent.done
    ) {
      obstacleEvent.done = true;
      const { resolve } = obstacleEvent;
      obstacleEvent = null;
      resolve();
    }
  }

  function finishHit() {
    hurting = false;
    hurtAcc = 0;
    hurtToggles = 0;
    hurtVisible = true;
    scrollPaused = false;
    otterFrame = 0;
    runAcc = 0;
    if (
      obstacleEvent &&
      obstacleEvent.mode === 'hit' &&
      obstacleEvent.triggered &&
      !obstacleEvent.done
    ) {
      obstacleEvent.done = true;
      const { resolve } = obstacleEvent;
      obstacleEvent = null;
      resolve();
    }
  }

  function jumpPhaseDuration(phase) {
    if (phase === 0) return JUMP_UP_MS;
    if (phase === 1) return JUMP_HANG_MS;
    if (phase === 2) return JUMP_DOWN_MS;
    return 80;
  }

  function updateJump(dt) {
    if (!jumping) return;
    jumpAcc += dt;
    const dur = jumpPhaseDuration(jumpPhase);
    const t = Math.min(1, jumpAcc / dur);
    if (jumpPhase === 0) {
      jumpLift = JUMP_HEIGHT * (1 - (1 - t) * (1 - t));
    } else if (jumpPhase === 1) {
      jumpLift = JUMP_HEIGHT;
    } else if (jumpPhase === 2) {
      jumpLift = JUMP_HEIGHT * (1 - t * t);
    } else {
      jumpLift = 0;
    }
    if (jumpAcc >= dur) {
      jumpAcc = 0;
      jumpPhase += 1;
      if (jumpPhase > 3) finishJump();
    }
  }

  function updateHurt(dt) {
    if (!hurting) return;
    hurtAcc += dt;
    if (hurtAcc < HURT_BLINK_MS) return;
    hurtAcc = 0;
    hurtVisible = !hurtVisible;
    hurtToggles += 1;
    if (hurtToggles >= HURT_BLINK_TOGGLES) finishHit();
  }

  function startJump(playSfx) {
    if (jumping || hurting) return;
    jumping = true;
    jumpPhase = 0;
    jumpAcc = 0;
    jumpLift = 0;
    if (typeof playSfx === 'function') playSfx();
  }

  function startHurt(playSfx) {
    if (hurting || jumping) return;
    hurting = true;
    hurtAcc = 0;
    hurtToggles = 0;
    hurtVisible = false; // first flash: vanish
    scrollPaused = true; // brief impact freeze
    if (typeof playSfx === 'function') playSfx();
  }

  function maybeTriggerObstacle(otterLocalX) {
    if (!obstacleEvent || obstacleEvent.triggered || jumping || hurting) return;
    const obs = tiles.find((t) => t.isObs && t.file === obstacleEvent.file);
    if (!obs) return;
    const ow = meta(obs.file).w;
    const dist = obs.x + ow * 0.5 - otterLocalX;
    if (obstacleEvent.mode === 'clear') {
      if (dist >= -20 && dist <= 18) {
        obstacleEvent.triggered = true;
        startJump(obstacleEvent.onImpact);
      }
      return;
    }
    // Hit: collide when obstacle center reaches the otter
    if (dist >= -10 && dist <= 12) {
      obstacleEvent.triggered = true;
      startHurt(obstacleEvent.onImpact);
    }
  }

  function otterSpriteName() {
    if (hurting) return ['1.png', '2.png', '3.png'][otterFrame] || '1.png';
    if (!jumping) return ['1.png', '2.png', '3.png'][otterFrame];
    if (jumpPhase === 0 || jumpPhase === 1) return 'up.png';
    if (jumpPhase === 2) return 'down.png';
    return '1.png';
  }

  function draw() {
    if (!gameRunCanvas || !ctx) return;
    const W = gameRunCanvas.width;
    const H = gameRunCanvas.height;
    ctx.clearRect(0, 0, W, H);
    ensureThreeTiles();
    const groundAnchorX = W / 2 - STAND_LOCAL_X * SCALE;
    const surfaceLineY = H - BODY_BELOW * SCALE;

    maybeTriggerObstacle(STAND_LOCAL_X);

    for (const t of tiles) {
      const img = images[t.file];
      if (!img) continue;
      const m = meta(t.file);
      ctx.drawImage(
        img,
        groundAnchorX + t.x * SCALE,
        surfaceLineY - m.surfaceY * SCALE,
        m.w * SCALE,
        m.h * SCALE
      );
    }

    if (!hurtVisible) return;
    const otterImg = images[otterSpriteName()];
    if (otterImg) {
      ctx.drawImage(
        otterImg,
        W / 2 - (OTTER_W * SCALE) / 2,
        surfaceLineY - OTTER_H * SCALE - jumpLift * SCALE,
        OTTER_W * SCALE,
        OTTER_H * SCALE
      );
    }
  }

  function loop(now) {
    if (!running) return;
    const dt = Math.min(50, now - lastTs);
    lastTs = now;
    advanceScroll(dt);
    updateRunAnim(dt);
    updateJump(dt);
    updateHurt(dt);
    draw();
    raf = requestAnimationFrame(loop);
  }

  async function start() {
    if (!gameRunCanvas) return;
    ctx = gameRunCanvas.getContext('2d');
    if (ctx) ctx.imageSmoothingEnabled = false;
    try {
      await ensureAssets();
    } catch (err) {
      console.warn('[bili-pet] game run assets failed:', err?.message || err);
      return;
    }
    resetTiles();
    otterFrame = 0;
    runAcc = 0;
    jumping = false;
    jumpPhase = 0;
    jumpAcc = 0;
    jumpLift = 0;
    hurting = false;
    hurtAcc = 0;
    hurtToggles = 0;
    hurtVisible = true;
    scrollPaused = false;
    obstacleEvent = null;
    if (running) return;
    running = true;
    lastTs = performance.now();
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (obstacleEvent && !obstacleEvent.done) {
      obstacleEvent.done = true;
      obstacleEvent.resolve();
      obstacleEvent = null;
    }
    if (gameRunCanvas && ctx) {
      ctx.clearRect(0, 0, gameRunCanvas.width, gameRunCanvas.height);
    }
  }

  function spliceObstacle() {
    const file = pickObs();
    const ow = meta(file).w;
    const mid = tiles[1] || { file: pickGround(), x: -meta(GROUND_FILES[0]).w };
    const right = tiles[2] || { file: pickGround(mid.file), x: 0 };
    tiles = [
      { file, x: mid.x - ow, isObs: true },
      { file: mid.file, x: mid.x, isObs: mid.isObs },
      { file: right.file, x: right.x, isObs: right.isObs },
    ];
    if (tiles[0].x + ow * 0.35 > STAND_LOCAL_X - 10) {
      const shift = tiles[0].x + ow * 0.35 - (STAND_LOCAL_X - 28);
      tiles[0].x -= Math.max(0, shift);
    }
    return file;
  }

  function awaitObstacleEvent(mode, onImpact) {
    if (!running) return Promise.resolve();
    if (obstacleEvent && !obstacleEvent.done) {
      return new Promise((resolve) => {
        const prev = obstacleEvent.resolve;
        obstacleEvent.resolve = () => {
          prev();
          resolve();
        };
      });
    }
    const file = spliceObstacle();
    return new Promise((resolve) => {
      obstacleEvent = {
        mode,
        file,
        triggered: false,
        done: false,
        resolve,
        onImpact,
      };
      const token = file;
      setTimeout(() => {
        if (!obstacleEvent || obstacleEvent.file !== token || obstacleEvent.done) {
          return;
        }
        if (obstacleEvent.triggered) return;
        obstacleEvent.triggered = true;
        if (mode === 'clear') startJump(obstacleEvent.onImpact);
        else startHurt(obstacleEvent.onImpact);
      }, 2500);
    });
  }

  /** Jump over a random ground-obs. */
  function playClearObstacle(onJump) {
    return awaitObstacleEvent('clear', onJump);
  }

  /** Collide with a random ground-obs, then 8-bit hurt blink. */
  function playHitObstacle(onHit) {
    return awaitObstacleEvent('hit', onHit);
  }

  return { start, stop, playClearObstacle, playHitObstacle };
})();

const BV_RE = /BV[\w]+/gi;

const GAME_SFX = {
  correct: '../assets/noise/correct.mp3',
  wrong: '../assets/noise/wrong.mp3',
  win: '../assets/noise/win.mp3',
  dead: '../assets/noise/dead.mp3',
};

function playGameSfx(key) {
  const src = GAME_SFX[key];
  if (!src) return Promise.resolve();
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

function openHomeNote(bvid) {
  const id = String(bvid || '').trim();
  if (!id || !window.biliPet?.goHome) return;
  void window.biliPet.goHome({ bvid: id });
}

/** 把回复里的 BV 号做成可点链接，跳转知识库对应笔记 */
function fillTextWithBvLinks(el, text) {
  const raw = String(text || '');
  BV_RE.lastIndex = 0;
  let last = 0;
  let match;
  let linked = false;
  while ((match = BV_RE.exec(raw))) {
    if (match.index > last) {
      el.appendChild(document.createTextNode(raw.slice(last, match.index)));
    }
    const bvid = match[0];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-bv-link';
    btn.textContent = bvid;
    btn.title = '在知识库中打开这篇笔记';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openHomeNote(bvid);
    });
    el.appendChild(btn);
    linked = true;
    last = match.index + bvid.length;
  }
  if (last < raw.length) {
    el.appendChild(document.createTextNode(raw.slice(last)));
  }
  if (!linked && last === 0) {
    el.textContent = raw;
  }
}

function appendChatMsg(role, text) {
  if (!chatLog || !text) return;
  const el = document.createElement('div');
  el.className = `chat-msg ${role === 'user' ? 'user' : role === 'system' ? 'system' : 'bot'}`;
  if (role === 'assistant' || role === 'bot') {
    fillTextWithBvLinks(el, text);
  } else {
    el.textContent = text;
  }
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function removeThinking() {
  const thinking = chatLog?.querySelector('.chat-msg.system:last-child');
  if (thinking && thinking.textContent === '思考中…') thinking.remove();
}

function setGameFeedback(text, kind) {
  if (!gameFeedback) return;
  const t = String(text || '').trim();
  if (!t) {
    gameFeedback.hidden = true;
    gameFeedback.textContent = '';
    gameFeedback.classList.remove('is-correct', 'is-wrong');
    return;
  }
  gameFeedback.hidden = false;
  gameFeedback.textContent = t;
  gameFeedback.classList.toggle('is-correct', kind === 'correct');
  gameFeedback.classList.toggle('is-wrong', kind === 'wrong');
}

function renderGameUi(ui) {
  if (!ui || !gameQuestion) return;
  lastGameUi = ui;
  gameQuestion.textContent = String(ui.q || '');
  const choices = Array.isArray(ui.choices) ? ui.choices : [];
  const disabled =
    Boolean(ui.disabled) ||
    ui.mode !== 'asking' ||
    Boolean(ui.waitingMore) ||
    gameBusy;
  gameOptionButtons.forEach((btn, i) => {
    const label = btn.querySelector('.game-option-label');
    const text = String(choices[i] || '');
    if (label) label.textContent = text;
    btn.title = text;
    btn.disabled = disabled;
  });
}

function enterGameUi(ui) {
  inGameUi = true;
  chatRoot?.classList.add('is-game');
  if (gamePanel) gamePanel.hidden = false;
  if (chatTitle) chatTitle.textContent = '答题';
  setGameFeedback('');
  renderGameUi(ui);
  void GameRun.start();
  if (ui?.mode === 'ended') {
    void concludeGameUi({ gameUi: ui, won: ui.won, endMessage: ui.q });
  }
}

function exitGameUi() {
  inGameUi = false;
  gameBusy = false;
  lastGameUi = null;
  chatRoot?.classList.remove('is-game');
  if (gamePanel) gamePanel.hidden = true;
  if (chatTitle) chatTitle.textContent = 'AI 对话';
  setGameFeedback('');
  GameRun.stop();
  chatInput?.focus();
}

/** 结算后先展示结果，再自动关掉答题页，最后才露出宠物 */
async function concludeGameUi(res = {}) {
  if (gameConcluding) return;
  gameConcluding = true;
  gameBusy = true;

  const ui = res.gameUi || lastGameUi;
  if (ui) renderGameUi(ui);
  setGameFeedback(
    res.feedback || res.endMessage || '',
    res.won || res.correct ? 'correct' : 'wrong'
  );

  try {
    await Promise.race([
      playGameSfx(res.won ? 'win' : 'dead'),
      new Promise((r) => setTimeout(r, 1400)),
    ]);
  } catch (_) {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 400));

  const summary = String(res.endMessage || '').trim();
  // 先关答题页，再 stop（露出宠物）
  exitGameUi();
  try {
    await window.biliPet?.gameStop?.();
  } catch (_) {
    /* ignore */
  }
  if (summary) appendChatMsg('system', summary);
  gameConcluding = false;
}

async function submitGameAnswer(choice) {
  if (
    !inGameUi ||
    gameBusy ||
    gameConcluding ||
    lastGameUi?.mode !== 'asking' ||
    lastGameUi?.waitingMore
  ) {
    return;
  }
  gameBusy = true;
  renderGameUi(lastGameUi);
  try {
    const res = await window.biliPet?.gameAnswer?.(choice);
    if (!res?.ok) {
      setGameFeedback(res?.error || '作答失败', 'wrong');
      if (res?.gameUi) renderGameUi(res.gameUi);
      return;
    }
    if (res.correct) {
      await GameRun.playClearObstacle(() => {
        void playGameSfx('correct');
      });
      setGameFeedback(res.feedback || '正确！', 'correct');
    } else {
      await GameRun.playHitObstacle(() => {
        void playGameSfx('wrong');
      });
      setGameFeedback(res.feedback || '不对', 'wrong');
    }

    if (res.gameUi?.mode === 'ended') {
      await concludeGameUi(res);
      return;
    }

    if (res.gameUi) {
      renderGameUi(res.gameUi);
      if (!res.waitingMore) setGameFeedback('');
    }
  } catch (err) {
    setGameFeedback(err?.message || String(err), 'wrong');
  } finally {
    gameBusy = false;
    if (inGameUi && lastGameUi && !gameConcluding) renderGameUi(lastGameUi);
  }
}

async function sendChat() {
  if (chatBusy || !chatInput || inGameUi) return;
  const text = String(chatInput.value || '').trim();
  if (!text) return;

  chatInput.value = '';
  appendChatMsg('user', text);
  chatMessages.push({ role: 'user', content: text });
  chatBusy = true;
  if (chatSend) chatSend.disabled = true;
  appendChatMsg('system', '思考中…');

  try {
    const res = await window.biliPet?.chat?.(chatMessages);
    removeThinking();
    if (!res?.ok) {
      appendChatMsg('system', res?.error || '对话失败，请检查 LLM 配置');
      return;
    }
    const reply = String(res.text || '').trim();
    if (reply) {
      chatMessages.push({ role: 'assistant', content: reply });
      appendChatMsg('assistant', reply);
    } else if (!res.gameUi) {
      appendChatMsg('system', '没有收到回复');
    }

    if (
      res.gameUi &&
      (res.gameUi.mode === 'asking' ||
        res.gameUi.mode === 'generating' ||
        res.gameUi.mode === 'ended')
    ) {
      enterGameUi(res.gameUi);
    }
  } catch (err) {
    removeThinking();
    appendChatMsg('system', err?.message || String(err));
  } finally {
    chatBusy = false;
    if (chatSend) chatSend.disabled = false;
    if (!inGameUi) chatInput?.focus();
  }
}

chatClose?.addEventListener('click', () => {
  window.biliPet?.closeWindow?.();
});

chatForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  void sendChat();
});

gameOptionButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const choice = Number(btn.dataset.choice);
    if (!Number.isInteger(choice)) return;
    void submitGameAnswer(choice);
  });
});

window.addEventListener('keydown', (e) => {
  if (!inGameUi || gameBusy) return;
  const key = String(e.key || '').toUpperCase();
  const map = { A: 0, B: 1, C: 2, D: 3, '1': 0, '2': 1, '3': 2, '4': 3 };
  if (map[key] === undefined) return;
  e.preventDefault();
  void submitGameAnswer(map[key]);
});

window.biliPet?.onEvent?.((payload) => {
  if (!payload?.kind) return;
  if (payload.kind === 'game_ui_refresh') {
    if (!inGameUi || !payload.gameUi || gameConcluding) return;
    renderGameUi(payload.gameUi);
    if (payload.gameUi.mode === 'asking' && !payload.gameUi.waitingMore) {
      setGameFeedback('');
    }
    if (payload.gameUi.mode === 'ended') {
      void concludeGameUi({
        gameUi: payload.gameUi,
        won: payload.gameUi.won,
        endMessage: payload.gameUi.q,
      });
    }
    return;
  }
  // 出题阶段主宠物在跳舞；若此时已进游戏窗也不要误关
  if (payload.kind === 'game_generating' && payload.gameUi) {
    enterGameUi(payload.gameUi);
  }
});

window.biliPet?.onGameStopped?.((payload) => {
  // ⌘S+G 中途退出；结算自动关闭时已 exit，这里只补消息
  const wasInGame = inGameUi;
  exitGameUi();
  gameConcluding = false;
  if (!wasInGame) return;
  const msg = String(payload?.message || '已退出答题模式。').trim();
  if (msg) appendChatMsg('system', msg);
});

appendChatMsg('system', '嗨，我是 BiliOtter，有什么想聊的？输入 /game 开始答题。');
setTimeout(() => chatInput?.focus(), 80);
