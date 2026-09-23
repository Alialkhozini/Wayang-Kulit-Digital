// Main entry point: initializes the renderer, puppets, tracking, audio,
// and runs the animation loop. Wires up all UI event handlers.

import { Renderer, STAGE_W, STAGE_H } from './renderer.js';
import { Puppet, PARTS } from './rig.js';
import { HandTracker } from './tracking.js';
import { Controller } from './controller.js';
import { BackgroundMusic, BeatClock } from './audio.js';
import { clamp, noise1 } from './math.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const video = $('video');
const preview = $('preview');
const previewBox = $('preview-box');
const pctx = preview.getContext('2d');

const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

function fail(message) {
  const el = $('error');
  el.textContent = message;
  el.hidden = false;
}

let renderer;
try {
  renderer = new Renderer(canvas);
  await Promise.all([
    renderer.loadTexture('background', 'assets/background.png'),
    ...Object.entries(PARTS).map(([key, part]) => renderer.loadTexture(key, part.src)),
  ]);
} catch (err) {
  console.error(err);
  fail(`Could not start the renderer: ${err.message}`);
  throw err;
}

const puppets = [new Puppet({ x: 640, facing: -1 }), new Puppet({ x: 1280, facing: 1 })];
const tracker = new HandTracker(video);
const controller = new Controller(tracker);
let facingMode = 'target';
window.wayang = { puppets, controller, tracker, renderer };

function applyFacing() {
  const two = controller.puppetCount === 2;
  for (const p of puppets) p.facingMode = facingMode === 'target' && !two ? 'manual' : facingMode;
}
applyFacing();

let view = { x: 0, y: 0, w: STAGE_W, h: STAGE_H };
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(innerWidth * dpr));
  const h = Math.max(1, Math.round(innerHeight * dpr));
  renderer.resize(w, h);
  const aspect = w / h;
  if (aspect > STAGE_W / STAGE_H) {
    const vh = STAGE_W / aspect;
    view = { x: 0, y: (STAGE_H - vh) * 0.5, w: STAGE_W, h: vh };
  } else {
    const vw = STAGE_H * aspect;
    view = { x: (STAGE_W - vw) * 0.5, y: 0, w: vw, h: STAGE_H };
  }
}
addEventListener('resize', resize);
resize();

// ---------- UI ----------
const intro = $('intro');
const introStatus = $('intro-status');
const startBtn = $('start-camera');
const mouseBtn = $('use-mouse');
const modeCameraBtn = $('mode-camera-btn');
const modeMouseBtn = $('mode-mouse-btn');
const howtoCamera = $('howto-camera');
const howtoMouse = $('howto-mouse');
const statusPill = $('status');
const statusText = $('status-text');
let showPreview = true;

function switchMode(mode) {
  const isCam = mode === 'camera';
  modeCameraBtn?.classList.toggle('active', isCam);
  modeCameraBtn?.setAttribute('aria-selected', String(isCam));
  modeMouseBtn?.classList.toggle('active', !isCam);
  modeMouseBtn?.setAttribute('aria-selected', String(!isCam));

  if (howtoCamera) howtoCamera.hidden = !isCam;
  if (howtoMouse) howtoMouse.hidden = isCam;

  if (startBtn) startBtn.hidden = !isCam;
  if (mouseBtn) mouseBtn.hidden = isCam;

  introStatus.textContent = '';
  introStatus.classList.remove('err');
}

modeCameraBtn?.addEventListener('click', () => switchMode('camera'));
modeMouseBtn?.addEventListener('click', () => switchMode('mouse'));

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  introStatus.classList.remove('err');
  try {
    await tracker.start((msg) => (introStatus.textContent = msg));
    controller.source = 'camera';
    controller.recalibrate();
    introStatus.textContent = '';
    intro.classList.add('gone');
    preview.height = Math.round(preview.width / tracker.aspect);
    preview.style.aspectRatio = `${preview.width} / ${preview.height}`;
    syncPreview();
  } catch (err) {
    console.error(err);
    introStatus.classList.add('err');
    introStatus.textContent =
      err?.name === 'NotAllowedError'
        ? 'Camera permission was blocked. Allow it in the address bar, or switch to Mouse Mode.'
        : `Camera unavailable (${err?.message || err}). You can switch to Mouse Mode.`;
    startBtn.disabled = false;
  }
});

mouseBtn.addEventListener('click', () => {
  controller.source = 'mouse';
  intro.classList.add('gone');
});

canvas.addEventListener('pointermove', (e) => {
  controller.mouse.x = view.x + (e.clientX / innerWidth) * view.w;
  controller.mouse.y = view.y + (e.clientY / innerHeight) * view.h;
  controller.mouse.seen = true;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    controller.mouse.depth = clamp(controller.mouse.depth - e.deltaY * 0.0015, -0.3, 1);
    e.preventDefault();
  },
  { passive: false },
);

const settings = $('settings');
const settingsToggle = $('settings-toggle');
const settingsClose = $('settings-close');

function toggleSettings(show) {
  const isHidden = show === undefined ? !settings.hidden : !show;
  settings.hidden = isHidden;
  settingsToggle.setAttribute('aria-expanded', String(!isHidden));
}

settingsToggle.addEventListener('click', () => toggleSettings());
if (settingsClose) settingsClose.addEventListener('click', () => toggleSettings(false));
$('opt-fingers').addEventListener('change', (e) => (controller.settings.fingers = e.target.value));
$('opt-bodyhand').addEventListener('change', (e) => (controller.settings.bodyHand = e.target.value));
$('opt-characters').addEventListener('change', (e) => {
  controller.settings.characters = e.target.value;
  $('bodyhand-row').hidden = e.target.value === 'two';
  applyFacing();
});
$('opt-facing').addEventListener('change', (e) => {
  facingMode = e.target.value;
  applyFacing();
});
$('opt-camera').addEventListener('change', (e) => {
  showPreview = e.target.checked;
  syncPreview();
});

// ---------- pop-out camera window ----------
let cameraWin = null;
const popoutBtn = $('opt-popout');
const cameraPoppedOut = () => !!cameraWin && !cameraWin.closed;

function syncPreview() {
  const out = cameraPoppedOut();
  previewBox.hidden = !showPreview || controller.source !== 'camera' || out;
  popoutBtn.textContent = out ? 'Bring camera back' : 'Open camera in new window';
}

function toggleCameraWindow() {
  if (cameraPoppedOut()) {
    cameraWin.close();
  } else {
    const w = Math.round(Math.min(960, screen.availWidth * 0.6));
    cameraWin = window.open('camera.html', 'wayang-camera', `popup,width=${w},height=${Math.round(w / tracker.aspect)}`);
    if (!cameraWin) showToast('Pop-up blocked. Allow pop-ups for this site to open the camera window.');
  }
  syncPreview();
}
popoutBtn.addEventListener('click', toggleCameraWindow);
$('preview-popout').addEventListener('click', toggleCameraWindow);
$('opt-size').addEventListener('input', (e) => {
  for (const p of puppets) p.baseScale = parseFloat(e.target.value);
});

// ---------- backsound ----------
const music = new BackgroundMusic('assets/backsound.mp3');
const beatClock = new BeatClock(music.el);
beatClock.load('assets/backsound-beats.json');
window.wayang.music = music;
window.wayang.beatClock = beatClock;
const soundBtn = $('sound-toggle');
const volumeInput = $('opt-volume');
volumeInput.value = String(music.volume);
function syncSoundUi() {
  soundBtn.setAttribute('aria-pressed', String(music.muted));
  soundBtn.setAttribute('aria-label', music.muted ? 'Unmute music' : 'Mute music');
}
syncSoundUi();
if (!music.muted) {
  music.start();
}

const tryAutoplayOnInteraction = (e) => {
  if (music.started || music.muted) {
    removeEventListener('pointerdown', tryAutoplayOnInteraction, true);
    removeEventListener('keydown', tryAutoplayOnInteraction, true);
    removeEventListener('touchstart', tryAutoplayOnInteraction, true);
    return;
  }
  if (e.target?.closest?.('#sound-toggle') || e.key?.toLowerCase() === 'm') return;
  music.start().then(() => {
    if (music.started) {
      removeEventListener('pointerdown', tryAutoplayOnInteraction, true);
      removeEventListener('keydown', tryAutoplayOnInteraction, true);
      removeEventListener('touchstart', tryAutoplayOnInteraction, true);
    }
  });
};
addEventListener('pointerdown', tryAutoplayOnInteraction, true);
addEventListener('keydown', tryAutoplayOnInteraction, true);
addEventListener('touchstart', tryAutoplayOnInteraction, true);
function toggleMusic() {
  music.setMuted(!music.muted);
  if (!music.muted) music.start();
  syncSoundUi();
}
soundBtn.addEventListener('click', toggleMusic);
volumeInput.addEventListener('input', (e) => {
  music.setVolume(parseFloat(e.target.value));
  if (music.muted && music.volume > 0) toggleMusic();
});

function turnPuppet(i) {
  if (i >= controller.puppetCount) return;
  if (facingMode !== 'manual') {
    facingMode = 'manual';
    $('opt-facing').value = 'manual';
    applyFacing();
  }
  puppets[i].turn();
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const k = e.key.toLowerCase();
  if (k === 'f') turnPuppet(0);
  else if (k === 'g') turnPuppet(1);
  else if (k === 'h') document.body.classList.toggle('ui-hidden');
  else if (k === 'm') toggleMusic();
  else if (k === 'd') controller.requestDance();
  else if (k === 'c') controller.recalibrate();
  else if (k === 'p') toggleCameraWindow();
  else if (k === 'v') {
    $('opt-camera').checked = !$('opt-camera').checked;
    $('opt-camera').dispatchEvent(new Event('change'));
  }
});

const toast = $('toast');
let toastTimer = 0;
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function updateHud() {
  const { source, status } = controller;
  let text, cls = '';
  if (source === 'camera') {
    if (status.hands === 0) {
      text = controller.puppetCount === 2 ? 'Camera on Â· raise both hands' : 'Camera on Â· show your hand';
      cls = 'warn';
    } else {
      text = {
        'two puppets': status.hands === 2 ? 'Two puppets Â· one per hand' : 'Two puppets Â· 1 hand seen',
        'two hands': 'One puppet Â· gapit + tuding',
        'one hand': 'One puppet Â· palm + fingers',
      }[status.mode] ?? status.mode;
      if (status.calibrating) text += ' Â· calibrating depth';
      cls = 'live';
    }
  } else if (source === 'mouse') {
    text = 'Mouse Â· scroll for depth';
  } else {
    text = 'Demo';
  }
  if (statusText.textContent !== text) statusText.textContent = text;
  statusPill.className = `pill ${cls}`;
}

function drawCamera(ctx, W, H) {
  const s = Math.max(1, W / 480);
  ctx.save();
  ctx.translate(W, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, W, H);
  ctx.restore();
  ctx.fillStyle = 'rgba(20,10,4,0.35)';
  ctx.fillRect(0, 0, W, H);
  controller.slots.forEach((slot, i) => {
    if (!slot.active || !slot.landmarks) return;
    const P = slot.landmarks.map((l) => [(1 - l.x) * W, l.y * H]);
    const isBody = controller.puppetCount === 2 ? true : i === controller.bodySlot;
    const gold = controller.puppetCount === 2 ? slot.role !== 1 : isBody;
    ctx.strokeStyle = gold ? 'rgba(242,199,107,0.9)' : 'rgba(150,210,255,0.9)';
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    for (const [a, b] of HAND_EDGES) {
      ctx.moveTo(...P[a]);
      ctx.lineTo(...P[b]);
    }
    ctx.stroke();
    const pair = { 'thumb-index': [4, 8], 'thumb-pinky': [4, 20], 'index-pinky': [8, 20] }[controller.settings.fingers];
    ctx.fillStyle = '#ff6b4a';
    for (const t of pair) {
      ctx.beginPath();
      ctx.arc(...P[t], 4 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    if (slot.pinky) {
      ctx.strokeStyle = '#ffe28a';
      ctx.lineWidth = 2.5 * s;
      ctx.beginPath();
      ctx.arc(...P[20], 8 * s, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (isBody) {
      const c = [0, 5, 9, 13, 17].reduce((acc, j) => [acc[0] + P[j][0] / 5, acc[1] + P[j][1] / 5], [0, 0]);
      ctx.strokeStyle = gold ? '#f2c76b' : '#96d2ff';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(...c, 9 * s, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}

const cameraReady = () => controller.source === 'camera' && video.readyState >= 2;
Object.assign(window.wayang, {
  drawCamera,
  cameraReady,
  attachCameraWindow(win) {
    cameraWin = win;
    syncPreview();
  },
  cameraWindow: () => cameraWin,
});

let wasPoppedOut = false;
function drawPreview() {
  const out = cameraPoppedOut();
  if (out !== wasPoppedOut) {
    wasPoppedOut = out;
    syncPreview();
  }
  if (!previewBox.hidden && cameraReady()) drawCamera(pctx, preview.width, preview.height);
}

// ---------- loop ----------
let last = performance.now() / 1000;
const PHYS_DT = 1 / 120;

function tick(nowMs) {
  const t = nowMs / 1000;
  const dt = clamp(t - last, 0, 1 / 15);
  last = t;

  const inputs = controller.update(t, view);
  const active = puppets.slice(0, controller.puppetCount);
  if (active.length === 2) {
    active[0].faceTargetX = active[1].pos.x;
    active[1].faceTargetX = active[0].pos.x;
  }
  const beat = beatClock.tick(dt);
  const steps = Math.max(1, Math.ceil(dt / PHYS_DT));
  const rhythm = { db: beat.db / steps, pos: beat.pos, period: beat.period };
  for (let i = 0; i < steps; i++) {
    active.forEach((p, j) => p.update(dt / steps, i === 0 ? inputs[j] ?? { active: false } : { ...(inputs[j] ?? { active: false }), danceTrigger: false }, view, rhythm));
  }
  active.forEach((p, j) => {
    if (p.danceStarted) {
      p.danceStarted = false;
      showToast(active.length === 2 ? `${j === 0 ? 'Left' : 'Right'} puppet Â· Kiprahan` : 'Kiprahan');
    }
  });

  const layers = active
    .map((p) => {
      const depth = Math.max(0, p.depth.x);
      return {
        depth: p.depth.x,
        items: p.frame(view),
        shadow: {
          scale: 1.03 + 0.2 * depth,
          dy: 8 + 34 * depth,
          blur: 3 + 30 * clamp(p.depth.x + 0.08, 0, 1.2),
          strength: 0.8 - 0.22 * clamp(depth, 0, 1),
        },
      };
    })
    .sort((a, b) => a.depth - b.depth);

  const flicker = 1 + 0.03 * Math.sin(t * 7.3) + 0.02 * Math.sin(t * 13.7 + 1.1) + (noise1(t * 6.5) - 0.5) * 0.07;
  const sway = (noise1(t * 1.2 + 10) - 0.5) * 26;

  const frame = {
    view,
    layers,
    time: t,
    lamp: [STAGE_W / 2 + sway, -560, 1300],
    eye: [STAGE_W / 2, STAGE_H * 0.55, 2300],
    lampColor: [1.0, 0.8, 0.56],
    intensity: 1.08 * flicker,
    flicker,
    hot: [STAGE_W / 2 + sway * 0.7, 440],
  };
  renderer.render(frame);
  window.wayang.lastFrame = frame;

  drawPreview();
  updateHud();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
