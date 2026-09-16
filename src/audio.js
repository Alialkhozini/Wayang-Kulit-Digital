// Beat-synced clock and looping background music for the gamelan backsound.

// BeatClock follows a precomputed beat grid from the recording, handling tempo
// (irama) changes. Falls back to a steady pulse when music isn't playing.
export class BeatClock {
  constructor(audioEl, fallbackPeriod = 0.68) {
    this.el = audioEl;
    this.beats = null;
    this.fallback = fallbackPeriod;
    this.mt = 0;
    this.pos = 0;
    this.period = fallbackPeriod;
  }

  async load(url) {
    try {
      const data = await (await fetch(url)).json();
      if (Array.isArray(data.beats) && data.beats.length > 2) this.beats = data.beats;
    } catch (err) {
      console.warn('Beat grid unavailable, dancing to a steady pulse', err);
    }
  }

  // Continuous beat index at music time t (binary search through the grid).
  posAt(t) {
    const B = this.beats;
    const n = B.length;
    if (t <= B[0]) return (t - B[0]) / (B[1] - B[0]);
    if (t >= B[n - 1]) return n - 1 + (t - B[n - 1]) / (B[n - 1] - B[n - 2]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (B[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo + (t - B[lo]) / (B[hi] - B[lo]);
  }

  periodAt(t) {
    const i = Math.max(1, Math.min(this.beats.length - 1, Math.floor(this.posAt(t)) + 1));
    return this.beats[i] - this.beats[i - 1];
  }

  get synced() {
    return !!this.beats && !this.el.paused && this.el.volume > 0.01;
  }

  // Advance by dt seconds. Returns beats elapsed, current position, and period.
  tick(dt) {
    if (this.synced) {
      const ct = this.el.currentTime;
      this.mt += dt;
      // currentTime updates coarsely — follow gently, snap on seeks/loops
      if (Math.abs(ct - this.mt) > 0.15) this.mt = ct;
      else this.mt += (ct - this.mt) * 0.1;
      const pos = this.posAt(this.mt);
      this.period = this.periodAt(this.mt);
      let db = pos - this.pos;
      if (db < -0.5 || db > 4) db = dt / this.period;
      this.pos = pos;
      return { db: Math.max(0, db), pos, period: this.period, synced: true };
    }
    this.period = this.fallback;
    this.pos += dt / this.fallback;
    return { db: dt / this.fallback, pos: this.pos, period: this.fallback, synced: false };
  }
}

// Looping gamelan backsound with fade, mute persistence, and autoplay-on-gesture.
const STORE_KEY = 'wayang.audio';

export class BackgroundMusic {
  constructor(src) {
    this.el = new Audio(src);
    this.el.loop = true;
    this.el.preload = 'auto';
    this.el.volume = 0;
    this.started = false;
    this.fadeRaf = 0;
    const saved = this._load();
    this.volume = saved.volume ?? 0.6;
    this.muted = saved.muted ?? false;
  }

  _load() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch {
      return {};
    }
  }

  _save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ volume: this.volume, muted: this.muted }));
    } catch { /* storage unavailable */ }
  }

  get target() {
    return this.muted ? 0 : this.volume;
  }

  fadeTo(value, seconds) {
    cancelAnimationFrame(this.fadeRaf);
    const from = this.el.volume;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / (seconds * 1000));
      this.el.volume = from + (value - from) * k * k * (3 - 2 * k);
      if (k < 1) this.fadeRaf = requestAnimationFrame(step);
      else if (value === 0 && this.muted) this.el.pause();
    };
    this.fadeRaf = requestAnimationFrame(step);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    if (this.muted) return;
    try {
      await this.el.play();
      this.fadeTo(this.target, 3);
    } catch (err) {
      this.started = false;
      console.warn('Backsound could not start yet:', err?.message || err);
    }
  }

  setMuted(muted) {
    this.muted = muted;
    this._save();
    if (!this.started) return;
    if (muted) {
      this.fadeTo(0, 0.4);
    } else {
      this.el.play().catch(() => {});
      this.fadeTo(this.target, 0.8);
    }
  }

  setVolume(v) {
    this.volume = v;
    this._save();
    if (this.started && !this.muted) {
      cancelAnimationFrame(this.fadeRaf);
      this.el.volume = v;
    }
  }
}
