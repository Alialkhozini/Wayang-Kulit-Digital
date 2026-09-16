// Input controller: translates camera hand tracking, mouse, or demo animation
// into puppet control inputs. Handles hand slot persistence, depth calibration,
// pinky-sign dance triggers, and coordinate mapping.

import { OneEuro, clamp } from './math.js';

// MediaPipe hand landmark indices
const WRIST = 0, THUMB_MCP = 2, THUMB_TIP = 4, INDEX_MCP = 5, INDEX_TIP = 8;
const MIDDLE_MCP = 9, RING_MCP = 13, PINKY_MCP = 17, PINKY_TIP = 20;

export const FINGER_PAIRS = {
  'thumb-index': { a: THUMB_TIP, aBase: THUMB_MCP, b: INDEX_TIP, bBase: INDEX_MCP },
  'thumb-pinky': { a: THUMB_TIP, aBase: THUMB_MCP, b: PINKY_TIP, bBase: PINKY_MCP },
  'index-pinky': { a: INDEX_TIP, aBase: INDEX_MCP, b: PINKY_TIP, bBase: PINKY_MCP },
};

const LOST_MS = 320;
const PINKY_HOLD_MS = 300;
const PINKY_REARM_MS = 350;

function makeSlot() {
  const pos = () => new OneEuro(1.6, 9, 1.0);
  return {
    active: false,
    lastSeen: 0,
    lastTs: 0,
    rawPalm: null,
    f: { px: pos(), py: pos(), ax: pos(), ay: pos(), bx: pos(), by: pos(), size: new OneEuro(0.7, 1.5), roll: new OneEuro(1.2, 2.5) },
    leftIsA: true,
    role: null,
    data: null,
    landmarks: null,
    pinky: false,
    pinkyOn: 0,
    pinkyOff: 0,
    pinkyArmed: true,
    danceTrigger: false,
  };
}

function resetSlot(s) {
  s.active = false;
  s.data = null;
  s.rawPalm = null;
  s.role = null;
  s.pinky = false;
  s.pinkyOn = 0;
  s.pinkyOff = 0;
  s.pinkyArmed = true;
  s.danceTrigger = false;
  for (const f of Object.values(s.f)) f.reset();
}

// Analyze hand landmarks in mirrored coordinates (x in video-height units).
function analyze(lms, aspect, pair) {
  const P = lms.map((l) => [(1 - l.x) * aspect, l.y]);
  const avg = (...ids) => [ids.reduce((s, i) => s + P[i][0], 0) / ids.length, ids.reduce((s, i) => s + P[i][1], 0) / ids.length];
  const d = (i, j) => Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]);
  const reach = (mcp, pip, tip) => ({ tipPip: d(WRIST, tip) / d(WRIST, pip), tipMcp: d(WRIST, tip) / d(WRIST, mcp) });
  const index = reach(5, 6, 8), middle = reach(9, 10, 12), ring = reach(13, 14, 16), pinky = reach(17, 18, 20);
  const pinkySign = pinky.tipPip > 1.12 && pinky.tipMcp > 1.4 && index.tipPip < 1.02 && middle.tipPip < 1.02 && ring.tipPip < 1.12;
  return {
    pinkySign,
    palm: avg(WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP),
    size: Math.max(d(WRIST, MIDDLE_MCP), d(INDEX_MCP, PINKY_MCP) * 1.3),
    roll: Math.atan2(P[MIDDLE_MCP][0] - P[WRIST][0], -(P[MIDDLE_MCP][1] - P[WRIST][1])),
    a: P[pair.a],
    b: P[pair.b],
    aBase: P[pair.aBase],
    bBase: P[pair.bBase],
  };
}

export class Controller {
  constructor(tracker) {
    this.tracker = tracker;
    this.source = 'demo';
    this.settings = { fingers: 'thumb-index', bodyHand: 'right', characters: 'two' };
    this.slots = [makeSlot(), makeSlot()];
    this.bodySlot = -1;
    this.calibs = {};
    this.mouse = { x: 960, y: 640, depth: 0, seen: false };
    this.status = { hands: 0, mode: 'demo', calibrating: false };
    this.prevCount = 0;
    this.home = [[640, 650], [1280, 650]];
    this.pendingDance = [false, false];
    this.demoDance = -1;
  }

  requestDance(i = null) {
    for (let j = 0; j < this.puppetCount; j++) if (i === null || i === j) this.pendingDance[j] = true;
  }

  get puppetCount() {
    return this.settings.characters === 'two' ? 2 : 1;
  }

  recalibrate() {
    this.calibs = {};
  }

  // Map camera normalized coords to stage coords.
  toStage(nx, ny, view) {
    const u = (nx - 0.12) / 0.76;
    const v = (ny - 0.1) / 0.8;
    return [view.x + view.w * (0.06 + 0.88 * u), view.y + view.h * (0.26 + 0.62 * v)];
  }

  ingest(det) {
    const { result, ts } = det;
    const aspect = this.tracker.aspect;
    const pair = FINGER_PAIRS[this.settings.fingers];
    const hands = result.landmarks.map((lm) => ({ lm, h: analyze(lm, aspect, pair) }));

    // Associate detections with persistent slots by palm distance
    const used = new Set();
    const assign = new Map();
    const dist = (s, h) => (s.rawPalm ? Math.hypot(s.rawPalm[0] - h.palm[0], s.rawPalm[1] - h.palm[1]) : 1e9);
    const pairs = [];
    hands.forEach((hd, hi) => this.slots.forEach((s, si) => pairs.push({ hi, si, d: s.active ? dist(s, hd.h) : 1e6 + si })));
    pairs.sort((p, q) => p.d - q.d);
    for (const p of pairs) {
      if (assign.has(p.hi) || used.has(p.si)) continue;
      assign.set(p.hi, p.si);
      used.add(p.si);
    }

    for (const [hi, si] of assign) {
      const s = this.slots[si];
      const { h, lm } = hands[hi];
      const dt = s.active ? clamp((ts - s.lastTs) / 1000, 1 / 240, 0.2) : 1 / 30;
      s.pinky = h.pinkySign;
      if (h.pinkySign) {
        s.pinkyOn += dt * 1000;
        s.pinkyOff = 0;
        if (s.pinkyArmed && s.pinkyOn >= PINKY_HOLD_MS) {
          s.danceTrigger = true;
          s.pinkyArmed = false;
        }
      } else {
        s.pinkyOff += dt * 1000;
        if (s.pinkyOff >= PINKY_REARM_MS) {
          s.pinkyOn = 0;
          s.pinkyArmed = true;
        }
      }
      s.active = true;
      s.lastSeen = ts;
      s.lastTs = ts;
      s.rawPalm = h.palm;
      s.landmarks = lm;
      const f = s.f;
      const side = (h.bBase[0] - h.aBase[0]) / h.size;
      if (side > 0.12) s.leftIsA = true;
      else if (side < -0.12) s.leftIsA = false;
      s.data = {
        palm: [f.px.filter(h.palm[0], dt), f.py.filter(h.palm[1], dt)],
        a: [f.ax.filter(h.a[0], dt), f.ay.filter(h.a[1], dt)],
        b: [f.bx.filter(h.b[0], dt), f.by.filter(h.b[1], dt)],
        size: f.size.filter(h.size, dt),
        roll: f.roll.filter(h.roll, dt),
      };
    }
    for (const s of this.slots) {
      if (s.active && ts - s.lastSeen > LOST_MS) resetSlot(s);
    }
  }

  activeSlots(now) {
    return this.slots.map((s, i) => ({ s, i })).filter(({ s }) => s.active && s.data && now - s.lastSeen <= LOST_MS);
  }

  // Depth from hand size: closer to camera = larger = lifted off kelir.
  depthFor(key, size) {
    let c = this.calibs[key];
    if (!c) c = this.calibs[key] = { base: null, samples: [] };
    if (c.base === null) {
      c.samples.push(size);
      if (c.samples.length >= 20) {
        const sorted = [...c.samples].sort((a, b) => a - b);
        c.base = sorted[sorted.length >> 1];
      }
      this.status.calibrating = true;
      return 0;
    }
    return clamp((size / c.base - 1) * 1.7, -0.35, 1.0);
  }

  handInput(slot, view, calibKey) {
    const d = slot.data;
    const aspect = this.tracker.aspect;
    const [x, y] = this.toStage(d.palm[0] / aspect, d.palm[1], view);
    const rel = (tip) => ({
      type: 'rel',
      dx: (tip[0] - d.palm[0]) / d.size,
      dy: (tip[1] - d.palm[1]) / d.size,
      rodX: this.toStage(tip[0] / aspect, tip[1], view)[0],
    });
    const A = rel(d.a), B = rel(d.b);
    const danceTrigger = slot.danceTrigger;
    slot.danceTrigger = false;
    return {
      active: true,
      body: { x, y },
      tilt: clamp(d.roll * 0.65, -0.45, 0.45),
      depth: this.depthFor(calibKey, d.size),
      arms: { left: slot.leftIsA ? A : B, right: slot.leftIsA ? B : A },
      danceTrigger,
    };
  }

  twoPuppetInput(active, view) {
    const fresh = active.length === 2 && (this.prevCount < 2 || active[0].s.role === active[1].s.role || active.some((a) => a.s.role === null));
    if (fresh) {
      const [p, q] = active;
      const pLeft = p.s.data.palm[0] < q.s.data.palm[0];
      p.s.role = pLeft ? 0 : 1;
      q.s.role = pLeft ? 1 : 0;
    } else if (active.length === 1 && active[0].s.role === null) {
      const s = active[0].s;
      s.role = s.data.palm[0] / this.tracker.aspect < 0.5 ? 0 : 1;
    }
    this.status.mode = active.length ? 'two puppets' : 'no hands';
    const out = [{ active: false }, { active: false }];
    for (const { s } of active) out[s.role] = this.handInput(s, view, `p${s.role}`);
    return out;
  }

  onePuppetInput(active, view) {
    if (!active.length) {
      this.bodySlot = -1;
      this.status.mode = 'no hands';
      return [{ active: false }];
    }
    if (active.length === 1) {
      this.bodySlot = active[0].i;
    } else if (!active.some((a) => a.i === this.bodySlot) || this.prevCount < 2) {
      const [p, q] = active;
      const pRight = p.s.data.palm[0] > q.s.data.palm[0];
      const wantRight = this.settings.bodyHand === 'right';
      this.bodySlot = pRight === wantRight ? p.i : q.i;
    }
    const input = this.handInput(this.slots[this.bodySlot], view, 'one');
    if (active.length === 1) {
      this.status.mode = 'one hand';
    } else {
      this.status.mode = 'two hands';
      const aspect = this.tracker.aspect;
      const rod = active.find((a) => a.i !== this.bodySlot).s;
      const abs = (tip) => {
        const [x, y] = this.toStage(tip[0] / aspect, tip[1], view);
        return { type: 'abs', x, y, rodX: x };
      };
      const A = abs(rod.data.a), B = abs(rod.data.b);
      input.arms = { left: rod.leftIsA ? A : B, right: rod.leftIsA ? B : A };
      input.danceTrigger = input.danceTrigger || rod.danceTrigger;
      rod.danceTrigger = false;
    }
    return [input];
  }

  cameraInput(now, view) {
    const active = this.activeSlots(now);
    this.status.hands = active.length;
    this.status.calibrating = false;
    const out = this.puppetCount === 2 ? this.twoPuppetInput(active, view) : this.onePuppetInput(active, view);
    this.prevCount = active.length;
    return out;
  }

  demoInput(t, view) {
    const cx = view.x + view.w / 2;
    const drift = Math.sin(t * 0.13) * view.w * 0.08;
    const gap = view.w * (0.36 + 0.14 * Math.sin(t * 0.42));
    const floor = view.y + view.h * 0.6;
    const talk = (phase, amp) => ({
      left: { type: 'rel', dx: -0.95 + Math.sin(t * 1.7 + phase) * 0.35 * amp, dy: -0.25 + Math.sin(t * 1.1 + phase) * 0.8 * amp },
      right: { type: 'rel', dx: 0.55 + Math.sin(t * 1.3 + phase) * 0.3, dy: 0.45 + Math.sin(t * 0.9 + phase) * 0.55 },
    });
    const turn = Math.sin(t * 0.5);
    const inputs = [
      {
        active: true,
        body: { x: cx + drift - gap / 2, y: floor + Math.sin(t * 0.9) * 18 },
        tilt: Math.sin(t * 0.55) * 0.06,
        depth: Math.max(0, Math.sin(t * 0.21 - 1.2)) * 0.6,
        arms: mirrorArms(talk(0, turn > 0 ? 1 : 0.35)),
      },
      {
        active: true,
        body: { x: cx + drift + gap / 2, y: floor + Math.sin(t * 0.8 + 2) * 18 },
        tilt: Math.sin(t * 0.47 + 1) * 0.06,
        depth: Math.max(0, Math.sin(t * 0.19 + 1.5)) * 0.6,
        arms: talk(2, turn < 0 ? 1 : 0.35),
      },
    ];
    const n = Math.floor((t - 6) / 24);
    if (n >= 0 && n !== this.demoDance) {
      this.demoDance = n;
      inputs[n % this.puppetCount].danceTrigger = true;
    }
    return inputs.slice(0, this.puppetCount);
  }

  idleInput(t, i) {
    return {
      active: true,
      body: { x: this.home[i][0], y: this.home[i][1] + Math.sin(t * 0.8 + i) * 6 },
      tilt: 0,
      depth: 0,
      arms: {
        left: { type: 'rel', dx: -0.7 + Math.sin(t * 0.9 + i) * 0.15, dy: 0.55 + Math.sin(t * 0.6) * 0.2 },
        right: { type: 'rel', dx: 0.35 + Math.sin(t * 0.8 + 1 + i) * 0.12, dy: 0.85 + Math.sin(t * 0.5) * 0.1 },
      },
    };
  }

  mouseInput(t) {
    const idle = this.idleInput(t, 0);
    const first = this.mouse.seen ? { ...idle, body: { x: this.mouse.x, y: this.mouse.y }, depth: this.mouse.depth } : { active: false };
    return this.puppetCount === 2 ? [first, this.idleInput(t, 1)] : [first];
  }

  update(t, view) {
    this.home = [
      [view.x + view.w * 0.3, view.y + view.h * 0.6],
      [view.x + view.w * 0.7, view.y + view.h * 0.6],
    ];
    let inputs;
    if (this.source === 'camera') {
      const det = this.tracker.detect();
      if (det) this.ingest(det);
      inputs = this.cameraInput(performance.now(), view);
    } else if (this.source === 'mouse') {
      this.status.mode = 'mouse';
      inputs = this.mouseInput(t);
    } else {
      this.status.mode = 'demo';
      inputs = this.demoInput(t, view);
    }
    inputs.forEach((inp, i) => {
      if (this.pendingDance[i]) inp.danceTrigger = true;
    });
    this.pendingDance = [false, false];
    return inputs;
  }
}

function mirrorArms(arms) {
  const m = (s) => ({ ...s, dx: -s.dx });
  return { left: m(arms.right), right: m(arms.left) };
}
