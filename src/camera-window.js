// Pop-out camera window (camera.html). Draws the mirrored camera feed and
// hand-tracking overlay by calling back into the stage window's API.

const canvas = document.getElementById('cam');
const ctx = canvas.getContext('2d');
const msg = document.getElementById('msg');
const hint = document.getElementById('hint');

function stage() {
  try {
    return window.opener && !window.opener.closed ? window.opener.wayang ?? null : null;
  } catch {
    return null;
  }
}

function setMessage(text) {
  if (msg.textContent !== text) msg.textContent = text;
}

function frame() {
  const app = stage();
  const live = !!app?.cameraReady?.();
  if (app && app.cameraWindow?.() !== window) app.attachCameraWindow?.(window);

  if (live) {
    const aspect = app.tracker.aspect;
    let w = innerWidth, h = innerWidth / aspect;
    if (h > innerHeight) {
      h = innerHeight;
      w = h * aspect;
    }
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    app.drawCamera(ctx, W, H);
  } else if (!app) {
    setMessage('Not connected to the stage. Open the stage and press P (or Settings → Open camera in new window).');
  } else {
    setMessage('Waiting for the camera… press Start camera on the stage.');
  }
  document.body.classList.toggle('live', live);
  requestAnimationFrame(frame);
}
frame();

canvas.addEventListener('dblclick', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.key === 'Escape') return;
  const app = stage();
  if (app) window.opener.dispatchEvent(new KeyboardEvent('keydown', { key: e.key }));
});

setTimeout(() => hint.classList.add('gone'), 4000);
