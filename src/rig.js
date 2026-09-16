// Puppet skeleton: body, arms with 2-bone IK, spring-driven joints,
// motion blur, dance integration, and stick/rod geometry.

import { Affine, Spring, Spring2, clamp, lerp, wrapAngle } from './math.js';
import { KIPRAH_BEATS, TURN_BEATS, kiprahPose, danceWeight } from './dance.js';

const DEFAULT_BEAT = 0.68;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const len = (v) => Math.hypot(v[0], v[1]);
const ang = (v) => Math.atan2(v[1], v[0]);
const rotV = (v, t) => {
  const c = Math.cos(t), s = Math.sin(t);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1]];
};
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// Pivot points measured in each PNG's own pixels.
const rot180 = (p, size) => [size[0] - p[0], size[1] - p[1]];
const LEFT = {
  upper: { src: 'assets/upper-arm-l.png', size: [231, 89], prox: [211, 44], dist: [22, 28] },
  fore: { src: 'assets/forearm-l.png', size: [195, 109], prox: [172, 58], dist: [13, 53] },
  hand: { src: 'assets/hand-l.png', size: [108, 124], prox: [91.7, 67.5], grip: [52, 76] },
};
const mirrorPiece = (p, src) => {
  const out = { src, size: p.size };
  for (const k of ['prox', 'dist', 'grip']) if (p[k]) out[k] = rot180(p[k], p.size);
  return out;
};

export const PARTS = {
  body: { src: 'assets/body.png', size: [706, 1377] },
  upperL: LEFT.upper,
  foreL: LEFT.fore,
  handL: LEFT.hand,
  upperR: mirrorPiece(LEFT.upper, 'assets/upper-arm-r.png'),
  foreR: mirrorPiece(LEFT.fore, 'assets/forearm-r.png'),
  handR: mirrorPiece(LEFT.hand, 'assets/hand-r.png'),
};

export const BODY = {
  anchor: [345, 760],
  shoulder: { L: [247.5, 432.5], R: [442.5, 432.5] },
  stickTop: [346, 318],
  stickFoot: [346, 1334],
  ties: [470, 1010, 1262],
};

const REST = { L: [-150, 250], R: [70, 330] };

class Arm {
  constructor(side) {
    this.side = side;
    this.upper = PARTS['upper' + side];
    this.fore = PARTS['fore' + side];
    this.hand = PARTS['hand' + side];
    this.shoulder = BODY.shoulder[side];

    const u = sub(this.upper.dist, this.upper.prox);
    this.Lu = len(u);
    this.restU = ang(u);
    const f = add(sub(this.fore.dist, this.fore.prox), sub(this.hand.grip, this.hand.prox));
    this.Lf = len(f);
    this.restF = ang(f);
    this.bend = side === 'L' ? -1 : 1;

    this.rotU = new Spring(0, 260, 0.34);
    this.rotF = new Spring(0, 210, 0.26);
    this.rotH = new Spring(0, 110, 0.2);
    this.target = null;
    this.rodX = new Spring(0, 45, 0.75);
    this.solution = { rotU: 0, rotF: 0 };
    this.initialized = false;
  }

  solve(T) {
    const S = this.shoulder;
    const d = sub(T, S);
    const a = ang(d);
    const dist = clamp(len(d), Math.abs(this.Lu - this.Lf) + 40, this.Lu + this.Lf - 0.5);
    const cosA = clamp((this.Lu * this.Lu + dist * dist - this.Lf * this.Lf) / (2 * this.Lu * dist), -1, 1);
    const thU = a + this.bend * Math.acos(cosA);
    const elbow = [S[0] + this.Lu * Math.cos(thU), S[1] + this.Lu * Math.sin(thU)];
    const reach = [S[0] + dist * Math.cos(a), S[1] + dist * Math.sin(a)];
    const thF = ang(sub(reach, elbow));
    return { rotU: wrapAngle(thU - this.restU), rotF: wrapAngle(thF - this.restF) };
  }

  pose(B) {
    const upperM = Affine.chain(B, Affine.translate(...this.shoulder), Affine.rotate(this.rotU.x), Affine.translate(-this.upper.prox[0], -this.upper.prox[1]));
    const elbow = add(this.shoulder, rotV(sub(this.upper.dist, this.upper.prox), this.rotU.x));
    const foreM = Affine.chain(B, Affine.translate(...elbow), Affine.rotate(this.rotF.x), Affine.translate(-this.fore.prox[0], -this.fore.prox[1]));
    const wrist = add(elbow, rotV(sub(this.fore.dist, this.fore.prox), this.rotF.x));
    const handM = Affine.chain(B, Affine.translate(...wrist), Affine.rotate(this.rotH.x), Affine.translate(-this.hand.prox[0], -this.hand.prox[1]));
    const gripLocal = add(wrist, rotV(sub(this.hand.grip, this.hand.prox), this.rotH.x));
    return { upperM, foreM, handM, grip: Affine.apply(B, ...gripLocal) };
  }
}

export class Puppet {
  constructor({ x = 960, y = 650, facing = 1 } = {}) {
    this.baseScale = 0.53;
    this.scale = this.baseScale;
    this.home = [x, y];
    this.pos = new Spring2(x, y, 240, 0.62);
    this.bodyTarget = [x, y];
    this.tilt = new Spring(0, 60, 0.45);
    this.depth = new Spring(0, 28, 1.0);
    this.facing = facing;
    this.flip = { from: facing, to: facing, t: 1 };
    this.flipX = facing;
    this.facingMode = 'manual';
    this.faceTargetX = null;
    this.turnTimer = 0;
    this.walkPhase = 0;
    this.arms = { L: new Arm('L'), R: new Arm('R') };
    this.B = Affine.identity();
    this.surfaceTilt = [0, 0];
    this.prevVel = [0, 0];
    this.dance = null;
    this.danceStarted = false;
    this.danceOffset = [0, 0];
    this.danceTilt = 0;
    this.dSpring = { x: new Spring(0, 620, 0.32), y: new Spring(0, 620, 0.3), tilt: new Spring(0, 520, 0.3) };
    this.time = 0;
    this.lastBodyXY = null;
    this.lastBodyV = [0, 0];
    this.lastRot = 0;
    this.lastRotV = 0;
    this.prevFrame = new Map();
  }

  get dancing() {
    return this.dance !== null;
  }

  startDance(rhythm) {
    const period = rhythm?.period ?? DEFAULT_BEAT;
    const k = period < 0.5 ? 2 : 1;
    const pos = (rhythm?.pos ?? 0) / k;
    let lead = Math.ceil(pos) - pos;
    if (lead < 0.45) lead += 1;
    this.dance = { b: -lead, start: -lead, k, turned: new Set() };
    this.danceStarted = true;
    for (const s of Object.values(this.dSpring)) s.snap(0);
  }

  turn() {
    if (this.flip.t < 1) return;
    this.flip = { from: this.facing, to: -this.facing, t: 0 };
    this.facing = -this.facing;
  }

  bodyMatrix(bob) {
    return Affine.chain(
      Affine.translate(this.pos.x + this.danceOffset[0], this.pos.y + bob + this.danceOffset[1]),
      Affine.rotate(this.tilt.x + this.danceTilt),
      Affine.scale(this.scale * this.flipX, this.scale),
      Affine.translate(-BODY.anchor[0], -BODY.anchor[1]),
    );
  }

  update(dt, input, view, rhythm) {
    if (input.danceTrigger && !this.dance) this.startDance(rhythm);
    let D = null, w = 0;
    if (this.dance) {
      const d = this.dance;
      d.b += (rhythm?.db ?? dt / DEFAULT_BEAT) / d.k;
      for (const tb of TURN_BEATS) {
        if (!d.turned.has(tb) && d.b >= tb) {
          d.turned.add(tb);
          this.turn();
        }
      }
      if (d.b >= KIPRAH_BEATS) {
        this.dance = null;
      } else {
        D = kiprahPose(d.b);
        w = danceWeight(d.b, d.start);
      }
    }
    const fwd = -this.facing;
    const kS = this.scale / this.baseScale;
    this.time += dt;
    const ds = this.dSpring;
    ds.x.step(D ? w * D.x : 0, dt);
    ds.y.step(D ? w * D.y : 0, dt);
    ds.tilt.step(D ? w * D.tilt : 0, dt);
    const getar = D ? w * (0.35 + 0.65 * D.still) : 0;
    const t = this.time;
    const quiverY = getar * (1.6 * Math.sin(t * 2 * Math.PI * 10.5) + 0.9 * Math.sin(t * 2 * Math.PI * 6.3 + 1.7));
    const quiverT = getar * 0.009 * Math.sin(t * 2 * Math.PI * 8.1 + 0.4);
    this.danceOffset = [ds.x.x * fwd * kS, (ds.y.x + quiverY) * kS];
    this.danceTilt = (ds.tilt.x + quiverT) * fwd;

    if (input.body) {
      this.bodyTarget = [
        clamp(input.body.x, view.x + 40, view.x + view.w - 40),
        clamp(input.body.y, view.y + view.h * 0.12, view.y + view.h * 1.1),
      ];
    }
    this.pos.step(this.bodyTarget[0], this.bodyTarget[1], dt);
    const vx = this.pos.vx, vy = this.pos.vy;
    this.danceOffset[0] = clamp(this.danceOffset[0], view.x + 60 - this.pos.x, view.x + view.w - 60 - this.pos.x);

    const lean = clamp(-vx * 0.00018, -0.14, 0.14);
    this.tilt.stepAngle(clamp(((input.tilt ?? 0) + lean) * (1 - w), -0.5, 0.5), dt);

    this.depth.step(lerp(input.depth ?? 0, D ? D.depth : 0, w), dt);
    this.scale = this.baseScale * (1 + 0.14 * this.depth.x);

    const speed = Math.abs(vx);
    this.walkPhase += dt * speed * 0.017;
    const bob = -Math.abs(Math.sin(this.walkPhase)) * clamp(speed / 380, 0, 1) * 9;

    let wantTurn = false;
    if (this.dance) {
      /* choreography decides */
    } else if (this.facingMode === 'walk') {
      wantTurn = speed > 240 && Math.sign(vx) === this.facing;
    } else if (this.facingMode === 'target' && this.faceTargetX !== null) {
      const dx = this.faceTargetX - this.pos.x;
      wantTurn = Math.abs(dx) > 60 && Math.sign(dx) === this.facing;
    }
    if (wantTurn) {
      this.turnTimer += dt;
      if (this.turnTimer > 0.2) this.turn();
    } else {
      this.turnTimer = 0;
    }
    if (this.flip.t < 1) {
      this.flip.t = Math.min(1, this.flip.t + dt / 0.42);
      this.flipX = this.flip.from * Math.cos(Math.PI * easeInOut(this.flip.t));
    } else {
      this.flipX = this.facing;
    }

    const ax = (vx - this.prevVel[0]) / Math.max(dt, 1e-3);
    this.prevVel = [vx, vy];
    this.surfaceTilt = [clamp(vx * 0.00035 + ax * 0.00002, -0.35, 0.35), clamp(vy * 0.0003, -0.25, 0.25)];

    this.B = this.bodyMatrix(bob);
    const B = this.B;
    const canSolve = Math.abs(this.flipX) > 0.25;
    const invB = canSolve ? Affine.invert(B) : null;

    const bodyXY = [this.pos.x + this.danceOffset[0], this.pos.y + bob + this.danceOffset[1]];
    const rot = this.tilt.x + this.danceTilt;
    let acc = [0, 0], rotAcc = 0;
    if (this.lastBodyXY && dt > 0) {
      const v = [(bodyXY[0] - this.lastBodyXY[0]) / dt, (bodyXY[1] - this.lastBodyXY[1]) / dt];
      acc = [(v[0] - this.lastBodyV[0]) / dt, (v[1] - this.lastBodyV[1]) / dt];
      this.lastBodyV = v;
      const rv = (rot - this.lastRot) / dt;
      rotAcc = (rv - this.lastRotV) / dt;
      this.lastRotV = rv;
    }
    this.lastBodyXY = bodyXY;
    this.lastRot = rot;
    const mirror = Math.sign(this.flipX) || 1;
    const kick = (seg, gain) => {
      const r = [B[0] * seg[0] + B[2] * seg[1], B[1] * seg[0] + B[3] * seg[1]];
      const r2 = r[0] * r[0] + r[1] * r[1] || 1;
      const alpha = clamp((r[0] * -acc[1] - r[1] * -acc[0]) / r2, -900, 900);
      return (alpha * mirror - rotAcc) * gain * dt;
    };
    const snappy = D !== null;

    const sL = Affine.apply(B, ...BODY.shoulder.L);
    const sR = Affine.apply(B, ...BODY.shoulder.R);
    const leftArm = sL[0] <= sR[0] ? 'L' : 'R';
    const specs = {
      [leftArm]: input.arms?.left,
      [leftArm === 'L' ? 'R' : 'L']: input.arms?.right,
    };

    for (const side of ['L', 'R']) {
      const arm = this.arms[side];
      const shoulderW = side === 'L' ? sL : sR;
      const spec = specs[side];
      let tgt;
      if (spec?.type === 'rel') {
        const g = (arm.Lu + arm.Lf) * this.scale * 0.82;
        tgt = [shoulderW[0] + spec.dx * g, shoulderW[1] + spec.dy * g];
      } else if (spec?.type === 'abs') {
        tgt = [spec.x, spec.y];
      } else {
        tgt = Affine.apply(B, ...add(arm.shoulder, REST[side]));
      }
      if (D) {
        const v = side === 'L' ? D.front : D.back;
        const g = (arm.Lu + arm.Lf) * this.scale * 0.82;
        const dtgt = [shoulderW[0] + fwd * v[0] * g, shoulderW[1] - v[1] * g];
        tgt = [lerp(tgt[0], dtgt[0], w), lerp(tgt[1], dtgt[1], w)];
      }

      if (!arm.initialized) {
        arm.target = new Spring2(tgt[0], tgt[1], 320, 0.5);
        arm.initialized = true;
      }
      for (const s of [arm.target.sx, arm.target.sy]) {
        s.k = snappy ? 560 : 320;
        s.zeta = snappy ? 0.3 : 0.5;
      }
      arm.target.step(tgt[0], tgt[1], dt);

      if (canSolve) arm.solution = arm.solve(Affine.apply(invB, arm.target.x, arm.target.y));
      arm.rotU.v += kick(rotV(sub(arm.upper.dist, arm.upper.prox), arm.rotU.x), 0.07);
      arm.rotF.v += kick(rotV([arm.Lf * Math.cos(arm.restF), arm.Lf * Math.sin(arm.restF)], arm.rotF.x), 0.1);
      arm.rotH.v += kick(rotV(sub(arm.hand.grip, arm.hand.prox), arm.rotH.x), 0.14);
      arm.rotU.stepAngle(arm.solution.rotU, dt);
      arm.rotF.stepAngle(arm.solution.rotF, dt);
      arm.rotH.stepAngle(arm.rotF.x, dt);
      rodLimit(arm.rotU, arm.solution.rotU, 0.7);
      rodLimit(arm.rotF, arm.solution.rotF, 0.9);
      rodLimit(arm.rotH, arm.rotF.x, 0.8);

      const restRod = arm.target.x + (this.pos.x - arm.target.x) * 0.3;
      const rodTarget = lerp(spec?.rodX ?? restRod, restRod, w);
      if (!arm.rodInit) {
        arm.rodX.snap(rodTarget);
        arm.rodInit = true;
      }
      arm.rodX.step(rodTarget, dt);
    }
  }

  frame(view) {
    const B = this.B;
    const bottom = view.y + view.h + 90;
    const k = this.scale / this.baseScale;
    const poses = { L: this.arms.L.pose(B), R: this.arms.R.pose(B) };

    const tilt = this.surfaceTilt;
    const armItems = (side) => [
      { kind: 'part', id: 'upper' + side, key: 'upper' + side, m: poses[side].upperM, tilt },
      { kind: 'part', id: 'fore' + side, key: 'fore' + side, m: poses[side].foreM, tilt },
      { kind: 'part', id: 'hand' + side, key: 'hand' + side, m: poses[side].handM, tilt },
    ];

    const top = Affine.apply(B, ...BODY.stickTop);
    const foot = Affine.apply(B, ...BODY.stickFoot);
    const axis = sub(foot, top);
    const axisLen = len(axis);
    const dir = [axis[0] / axisLen, axis[1] / axisLen];
    const s = this.scale;
    const cap = [top[0] - dir[0] * 10 * s, top[1] - dir[1] * 10 * s];
    const handleStart = [foot[0] + dir[0] * 150 * s, foot[1] + dir[1] * 150 * s];
    const tEnd = dir[1] > 0.15 ? Math.max(0, (bottom - handleStart[1]) / dir[1]) : 1600;
    const end = [handleStart[0] + dir[0] * tEnd, handleStart[1] + dir[1] * tEnd];
    const gapit = {
      kind: 'stick',
      id: 'gapit',
      style: 'gapit',
      pts: [
        { p: cap, w: 2.5 * s },
        { p: top, w: 8 * s },
        { p: foot, w: 13 * s },
        { p: handleStart, w: 26 * s },
        { p: end, w: 30 * s },
      ],
      ties: BODY.ties.map((y) => [(y - BODY.stickTop[1] + 10) * s, 9 * s]),
    };

    const rods = ['L', 'R'].map((side) => {
      const grip = poses[side].grip;
      const bx = this.arms[side].rodX.x;
      const ropeDir = sub([bx, bottom], grip);
      const L = len(ropeDir);
      const d = [ropeDir[0] / L, ropeDir[1] / L];
      return {
        kind: 'stick',
        id: 'rod' + side,
        style: 'rod',
        pts: [
          { p: [grip[0] - d[0] * 3 * k, grip[1] - d[1] * 3 * k], w: 1.6 * k },
          { p: [grip[0] + d[0] * 4 * k, grip[1] + d[1] * 4 * k], w: 3.4 * k },
          { p: [bx, bottom], w: 6.5 * k },
        ],
        ties: [[5 * k, 6 * k]],
      };
    });

    const back = this.flipX >= 0 ? 'R' : 'L';
    const front = back === 'R' ? 'L' : 'R';
    const items = [
      ...armItems(back),
      { kind: 'part', id: 'body', key: 'body', m: B, tilt },
      gapit,
      ...armItems(front),
      ...rods,
    ];
    return this.withMotionBlur(items);
  }

  withMotionBlur(items) {
    const out = [];
    const next = new Map();
    for (const item of items) {
      next.set(item.id, item);
      const prev = this.prevFrame.get(item.id);
      if (prev) {
        const moved = item.kind === 'part' ? partTravel(prev, item) : stickTravel(prev, item);
        if (moved > 8) {
          const strength = clamp((moved - 8) / 24, 0, 1);
          for (const [s, a] of [[0.33, 0.3], [0.66, 0.45]]) {
            out.push({ ...(item.kind === 'part' ? lerpPart(prev, item, s) : lerpStick(prev, item, s)), alpha: a * strength });
          }
        }
      }
      out.push(item);
    }
    this.prevFrame = next;
    return out;
  }
}

function rodLimit(spring, target, maxDev) {
  const d = wrapAngle(spring.x - target);
  if (Math.abs(d) > maxDev) {
    spring.x = target + Math.sign(d) * maxDev;
    if (spring.v * Math.sign(d) > 0) spring.v *= -0.3;
  } else {
    spring.x = target + d;
  }
}

const PART_SIZE = (key) => PARTS[key].size;
function partTravel(a, b) {
  const [w, h] = PART_SIZE(b.key);
  let max = 0;
  for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const p = Affine.apply(a.m, x, y), q = Affine.apply(b.m, x, y);
    max = Math.max(max, Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  return max;
}
function stickTravel(a, b) {
  const n = Math.min(a.pts.length, b.pts.length);
  let max = 0;
  for (let i = 0; i < Math.min(n, 3); i++) max = Math.max(max, Math.hypot(a.pts[i].p[0] - b.pts[i].p[0], a.pts[i].p[1] - b.pts[i].p[1]));
  return max;
}
const lerpPart = (a, b, s) => ({ ...b, m: b.m.map((v, i) => a.m[i] + (v - a.m[i]) * s) });
const lerpStick = (a, b, s) => ({
  ...b,
  pts: b.pts.map((pt, i) => {
    const q = a.pts[i] ?? pt;
    return { p: [q.p[0] + (pt.p[0] - q.p[0]) * s, q.p[1] + (pt.p[1] - q.p[1]) * s], w: q.w + (pt.w - q.w) * s };
  }),
});
