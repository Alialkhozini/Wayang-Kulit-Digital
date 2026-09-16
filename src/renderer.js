// WebGL2 renderer: lamp-lit leather & gold leaf, horn sticks, projected soft shadows on the kelir, bloom.
export const STAGE_W = 1920;
export const STAGE_H = 1080;

const VS_PART = `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec3 uM0;
uniform vec3 uM1;
uniform vec2 uSize;
uniform vec4 uView;
uniform vec4 uProj;
out vec2 vUv;
out vec2 vWorld;
void main() {
  vec2 local = aPos * uSize;
  vec2 w = vec2(dot(uM0, vec3(local, 1.0)), dot(uM1, vec3(local, 1.0)));
  vWorld = w;
  w = uProj.xy + (w - uProj.xy) * uProj.z + vec2(0.0, uProj.w);
  vec2 ndc = (w - uView.xy) / uView.zw * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vUv = aPos;
}`;

const LIGHTING = `
uniform vec3 uLamp;
uniform vec3 uEye;
uniform vec3 uLampColor;
uniform float uIntensity;
vec3 lampLight(vec3 P, out vec3 L, out vec3 H) {
  vec3 Ld = uLamp - P;
  float dist = length(Ld);
  L = Ld / dist;
  H = normalize(L + normalize(uEye - P));
  return uLampColor * uIntensity / (1.0 + dist * dist / (2800.0 * 2800.0));
}`;

const FS_PART = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vWorld;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec3 uM0;
uniform vec3 uM1;
uniform vec2 uTilt;
uniform float uBump;
uniform float uAlpha;
${LIGHTING}
out vec4 outColor;

float height(vec2 uv) {
  vec4 t = texture(uTex, uv);
  return dot(t.rgb, vec3(0.299, 0.587, 0.114)) * 0.65 + t.a * 0.35;
}

void main() {
  vec4 t = texture(uTex, vUv);
  if (t.a < 0.003) discard;
  vec3 alb = t.rgb / t.a;

  // relief from the painted/punched detail (tatahan) -> tangent-space normal
  vec2 e = uTexel * 1.35;
  float hl = height(vUv - vec2(e.x, 0.0));
  float hr = height(vUv + vec2(e.x, 0.0));
  float hu = height(vUv - vec2(0.0, e.y));
  float hd = height(vUv + vec2(0.0, e.y));
  vec3 nt = normalize(vec3((hl - hr) * uBump, (hu - hd) * uBump, 1.0));

  vec2 c0 = vec2(uM0.x, uM1.x);
  vec2 c1 = vec2(uM0.y, uM1.y);
  float sc = max(length(c0), 1e-4);
  vec3 N = normalize(vec3((nt.x * c0 + nt.y * c1) / sc + uTilt, nt.z));

  // gold leaf (prada) detection: warm yellow, r >= g > b
  float mx = max(alb.r, max(alb.g, alb.b));
  float mn = min(alb.r, min(alb.g, alb.b));
  float sat = (mx - mn) / max(mx, 1e-3);
  float gold = smoothstep(0.03, 0.12, alb.g - alb.b)
             * (1.0 - smoothstep(0.16, 0.32, alb.r - alb.g))
             * smoothstep(-0.10, 0.02, alb.r - alb.g)
             * smoothstep(0.30, 0.55, mx)
             * smoothstep(0.12, 0.28, sat);

  vec3 L, H;
  vec3 light = lampLight(vec3(vWorld, 0.0), L, H);
  float ndl = max(dot(N, L), 0.0);
  float ndh = max(dot(N, H), 0.0);

  vec3 ambient = vec3(0.34, 0.27, 0.22);
  vec3 diffuse = alb * (ambient + light * ndl * mix(1.0, 0.72, gold));

  vec3 goldTint = mix(alb, vec3(1.0, 0.85, 0.52), 0.3);
  vec3 specGold = goldTint * (pow(ndh, 80.0) * 2.4 + pow(ndh, 14.0) * 0.30);
  vec3 specPaint = vec3(1.0, 0.94, 0.84) * pow(ndh, 40.0) * 0.16;
  vec3 spec = mix(specPaint, specGold, gold) * light;

  // slopes of the relief catch the glowing kelir behind the puppet
  float slope = clamp(1.0 - nt.z, 0.0, 1.0);
  vec3 rim = alb * vec3(1.0, 0.78, 0.5) * slope * 0.5;

  vec3 col = diffuse + spec + rim;
  outColor = vec4(col * t.a, t.a) * uAlpha;
}`;

const FS_PART_SHADOW = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vWorld;
uniform sampler2D uTex;
uniform float uTint;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec4 t = texture(uTex, vUv);
  outColor = vec4(t.rgb * uTint, t.a) * uAlpha;
}`;

const VS_STICK = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aCoord;
layout(location=2) in vec2 aAcross;
uniform vec4 uView;
uniform vec4 uProj;
out vec2 vCoord;
out vec2 vAcross;
out vec2 vWorld;
void main() {
  vWorld = aPos;
  vec2 w = uProj.xy + (aPos - uProj.xy) * uProj.z + vec2(0.0, uProj.w);
  vec2 ndc = (w - uView.xy) / uView.zw * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vCoord = aCoord;
  vAcross = aAcross;
}`;

const NOISE = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}`;

const FS_STICK = `#version 300 es
precision highp float;
in vec2 vCoord;
in vec2 vAcross;
in vec2 vWorld;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec2 uTies[4];
uniform int uTieCount;
uniform float uSeed;
uniform float uAlpha;
${LIGHTING}
${NOISE}
out vec4 outColor;
void main() {
  float u = vCoord.x;
  float v = vCoord.y;
  float aw = fwidth(u);
  float a = 1.0 - smoothstep(1.0 - aw, 1.0 + aw, abs(u));
  if (a <= 0.001) discard;
  float uc = clamp(u, -1.0, 1.0);
  float z = sqrt(max(1.0 - uc * uc, 0.0));
  vec3 N = normalize(vec3(vAcross * uc, z + 0.08));

  // buffalo horn: near-black with amber striations, translucent at thin edges
  float streak = vnoise(vec2(uc * 2.5 + uSeed, v * 0.02)) * 0.65 + vnoise(vec2(uc * 8.0 - uSeed, v * 0.09)) * 0.35;
  vec3 base = mix(uColorA, uColorB, smoothstep(0.45, 0.95, streak));
  base += uColorB * pow(1.0 - z, 2.0) * 0.45;
  float shin = 70.0;
  float specK = 1.0;

  for (int i = 0; i < 4; i++) {
    if (i >= uTieCount) break;
    float d = abs(v - uTies[i].x);
    if (d < uTies[i].y) {
      float wrap = 0.5 + 0.5 * sin(v * 2.2);
      base = vec3(0.80, 0.70, 0.50) * (0.62 + 0.38 * wrap);
      N = normalize(vec3(vAcross * uc * 0.8, z + 0.3));
      shin = 10.0;
      specK = 0.18;
    }
  }

  vec3 L, H;
  vec3 light = lampLight(vec3(vWorld, 0.0), L, H);
  float ndl = max(dot(N, L), 0.0);
  float ndh = max(dot(N, H), 0.0);
  vec3 col = base * (vec3(0.30, 0.25, 0.22) + light * ndl) + light * (pow(ndh, shin) * 1.1 + pow(ndh, 8.0) * 0.06) * specK;
  outColor = vec4(col * a, a) * uAlpha;
}`;

const FS_STICK_SHADOW = `#version 300 es
precision highp float;
in vec2 vCoord;
in vec2 vAcross;
in vec2 vWorld;
uniform float uAlpha;
out vec4 outColor;
void main() {
  float aw = fwidth(vCoord.x);
  float a = 1.0 - smoothstep(1.0 - aw, 1.0 + aw, abs(vCoord.x));
  outColor = vec4(0.0, 0.0, 0.0, a) * uAlpha;
}`;

const VS_FULL = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_BG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBg;
uniform sampler2D uShadow0;
uniform sampler2D uShadow1;
uniform vec4 uView;
uniform vec2 uHot;
uniform float uFlicker;
uniform vec2 uShadowK;
uniform float uTime;
${NOISE}
out vec4 outColor;
void main() {
  vec2 stage = vec2(uView.x + vUv.x * uView.z, uView.y + (1.0 - vUv.y) * uView.w);
  vec2 buv = stage / vec2(${STAGE_W.toFixed(1)}, ${STAGE_H.toFixed(1)});
  vec3 bg = texture(uBg, clamp(buv, vec2(0.0), vec2(1.0))).rgb;

  // blencong hotspot on the cloth, breathing with the flame
  vec2 d = (stage - uHot) / vec2(1250.0, 820.0);
  float glow = exp(-dot(d, d) * 1.7);
  vec3 lit = bg * (0.64 + 0.36 * glow) * uFlicker;
  lit += vec3(1.0, 0.62, 0.28) * glow * 0.05 * uFlicker;

  // faint drifting smoke in the lamp light
  float smoke = vnoise(stage * 0.004 + vec2(uTime * 0.05, -uTime * 0.03)) * vnoise(stage * 0.009 - vec2(uTime * 0.04, 0.0));
  lit += vec3(1.0, 0.8, 0.55) * smoke * glow * 0.035;

  // shadows (one layer per puppet, each blurred by its own distance from the cloth)
  vec4 s0 = texture(uShadow0, vUv);
  vec4 s1 = texture(uShadow1, vUv);
  vec3 trans = clamp(1.0 - uShadowK.x * s0.a + uShadowK.x * s0.rgb, 0.0, 1.0)
             * clamp(1.0 - uShadowK.y * s1.a + uShadowK.y * s1.rgb, 0.0, 1.0);
  lit *= trans;
  outColor = vec4(lit, 1.0);
}`;

const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 outColor;
const float W[5] = float[](0.2270270, 0.1945946, 0.1216216, 0.0540540, 0.0162162);
void main() {
  vec4 c = texture(uTex, vUv) * W[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uDir * float(i);
    c += (texture(uTex, vUv + o) + texture(uTex, vUv - o)) * W[i];
  }
  outColor = c;
}`;

const FS_BRIGHT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uThreshold;
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  outColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.35, l), 1.0);
}`;

const FS_FINAL = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomK;
uniform vec2 uRes;
uniform float uTime;
out vec4 outColor;
void main() {
  vec3 c = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * uBloomK;
  vec2 q = vUv - 0.5;
  q.x *= uRes.x / uRes.y;
  float vig = smoothstep(1.15, 0.28, length(q * vec2(0.85, 1.05)));
  c *= mix(0.38, 1.0, vig);
  c = c / (1.0 + 0.16 * c) * 1.12;
  c = pow(max(c, 0.0), vec3(1.0, 1.02, 1.08));
  float g = fract(sin(dot(floor(vUv * uRes) + fract(uTime * 7.13) * 91.7, vec2(12.9898, 78.233))) * 43758.5453);
  c += (g - 0.5) * 0.02;
  outColor = vec4(c, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    throw new Error(`Shader compile failed: ${log}\n${src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}`);
  }
  return sh;
}

function makeProgram(gl, vs, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const cache = new Map();
  const u = (name) => {
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(prog, name));
    return cache.get(name);
  };
  return { prog, u };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.floatRT = !!gl.getExtension('EXT_color_buffer_float');
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');

    this.p = {
      part: makeProgram(gl, VS_PART, FS_PART),
      partShadow: makeProgram(gl, VS_PART, FS_PART_SHADOW),
      stick: makeProgram(gl, VS_STICK, FS_STICK),
      stickShadow: makeProgram(gl, VS_STICK, FS_STICK_SHADOW),
      bg: makeProgram(gl, VS_FULL, FS_BG),
      blur: makeProgram(gl, VS_FULL, FS_BLUR),
      bright: makeProgram(gl, VS_FULL, FS_BRIGHT),
      final: makeProgram(gl, VS_FULL, FS_FINAL),
    };

    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.stickVao = gl.createVertexArray();
    gl.bindVertexArray(this.stickVao);
    this.stickBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stickBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 4096 * 4, gl.DYNAMIC_DRAW);
    const stride = 6 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16);

    this.emptyVao = gl.createVertexArray();
    gl.bindVertexArray(null);

    this.tex = {};
    this.rt = {};
    this.size = [0, 0];
  }

  async loadTexture(key, url) {
    const gl = this.gl;
    const img = new Image();
    img.src = url;
    await img.decode();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
    this.tex[key] = { tex, w: img.naturalWidth, h: img.naturalHeight };
  }

  makeRT(w, h, float) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  resize(w, h) {
    if (w === this.size[0] && h === this.size[1]) return;
    const gl = this.gl;
    for (const rt of Object.values(this.rt)) {
      gl.deleteTexture(rt.tex);
      gl.deleteFramebuffer(rt.fb);
    }
    this.canvas.width = w;
    this.canvas.height = h;
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.rt = {
      scene: this.makeRT(w, h, this.floatRT),
      shadow0: this.makeRT(hw, hh, false),
      shadow1: this.makeRT(hw, hh, false),
      shadowTmp: this.makeRT(hw, hh, false),
      bloomA: this.makeRT(qw, qh, this.floatRT),
      bloomB: this.makeRT(qw, qh, this.floatRT),
    };
    this.size = [w, h];
  }

  bindRT(rt) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt ? rt.fb : null);
    gl.viewport(0, 0, rt ? rt.w : this.size[0], rt ? rt.h : this.size[1]);
  }

  fullscreen(prog) {
    const gl = this.gl;
    gl.useProgram(prog.prog);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  bindTex(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  blur(src, tmp, px) {
    const gl = this.gl;
    const { blur } = this.p;
    const step = Math.max(px / 4, 0.001);
    gl.useProgram(blur.prog);
    gl.uniform1i(blur.u('uTex'), 0);
    this.bindRT(tmp);
    this.bindTex(0, src.tex);
    gl.uniform2f(blur.u('uDir'), step / src.w, 0);
    this.fullscreen(blur);
    this.bindRT(src);
    this.bindTex(0, tmp.tex);
    gl.uniform2f(blur.u('uDir'), 0, step / src.h);
    this.fullscreen(blur);
  }

  setLight(prog, f) {
    const gl = this.gl;
    gl.uniform3f(prog.u('uLamp'), ...f.lamp);
    gl.uniform3f(prog.u('uEye'), ...f.eye);
    gl.uniform3f(prog.u('uLampColor'), ...f.lampColor);
    gl.uniform1f(prog.u('uIntensity'), f.intensity);
  }

  drawPart(prog, item, f, proj, lit) {
    const gl = this.gl;
    const t = this.tex[item.key];
    const m = item.m;
    gl.uniform3f(prog.u('uM0'), m[0], m[2], m[4]);
    gl.uniform3f(prog.u('uM1'), m[1], m[3], m[5]);
    gl.uniform2f(prog.u('uSize'), t.w, t.h);
    gl.uniform4f(prog.u('uView'), f.view.x, f.view.y, f.view.w, f.view.h);
    gl.uniform4f(prog.u('uProj'), ...proj);
    this.bindTex(0, t.tex);
    gl.uniform1i(prog.u('uTex'), 0);
    if (lit) {
      gl.uniform2f(prog.u('uTexel'), 1 / t.w, 1 / t.h);
      gl.uniform2f(prog.u('uTilt'), ...(item.tilt ?? [0, 0]));
      gl.uniform1f(prog.u('uBump'), 5.5);
    } else {
      gl.uniform1f(prog.u('uTint'), 0.22);
    }
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  drawStick(prog, item, f, proj, lit) {
    const gl = this.gl;
    const pts = item.pts;
    const data = [];
    let v = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)].p, b = pts[Math.min(pts.length - 1, i + 1)].p;
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      const nx = -dy, ny = dx;
      if (i > 0) v += Math.hypot(pts[i].p[0] - pts[i - 1].p[0], pts[i].p[1] - pts[i - 1].p[1]);
      const w = pts[i].w;
      const pad = 1 + 1.5 / Math.max(w, 0.5);
      const [px, py] = pts[i].p;
      data.push(px - nx * w * pad, py - ny * w * pad, -pad, v, nx, ny);
      data.push(px + nx * w * pad, py + ny * w * pad, pad, v, nx, ny);
    }
    gl.bindVertexArray(this.stickVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stickBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(data));
    gl.uniform4f(prog.u('uView'), f.view.x, f.view.y, f.view.w, f.view.h);
    gl.uniform4f(prog.u('uProj'), ...proj);
    if (lit) {
      const ties = new Float32Array(8);
      item.ties.slice(0, 4).forEach((t, i) => {
        ties[i * 2] = t[0];
        ties[i * 2 + 1] = t[1];
      });
      gl.uniform2fv(prog.u('uTies'), ties);
      gl.uniform1i(prog.u('uTieCount'), Math.min(4, item.ties.length));
      if (item.style === 'gapit') {
        gl.uniform3f(prog.u('uColorA'), 0.075, 0.045, 0.03);
        gl.uniform3f(prog.u('uColorB'), 0.42, 0.22, 0.08);
        gl.uniform1f(prog.u('uSeed'), 3.1);
      } else {
        gl.uniform3f(prog.u('uColorA'), 0.11, 0.065, 0.035);
        gl.uniform3f(prog.u('uColorB'), 0.46, 0.27, 0.11);
        gl.uniform1f(prog.u('uSeed'), 11.7);
      }
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, pts.length * 2);
  }

  drawItems(items, f, proj, lit) {
    const gl = this.gl;
    const partProg = lit ? this.p.part : this.p.partShadow;
    const stickProg = lit ? this.p.stick : this.p.stickShadow;
    for (const item of items) {
      const prog = item.kind === 'part' ? partProg : stickProg;
      gl.useProgram(prog.prog);
      if (lit) this.setLight(prog, f);
      gl.uniform1f(prog.u('uAlpha'), item.alpha ?? 1);
      if (item.kind === 'part') this.drawPart(prog, item, f, proj, lit);
      else this.drawStick(prog, item, f, proj, lit);
    }
  }

  render(f) {
    const gl = this.gl;
    const { rt, p } = this;
    const [W, H] = this.size;

    // 1) shadow silhouettes projected from lamp onto cloth
    const layers = f.layers.slice(0, 2);
    const shadowRTs = [rt.shadow0, rt.shadow1];
    const strengths = [0, 0];
    const pxPerStage = rt.shadow0.w / f.view.w;
    layers.forEach((layer, i) => {
      const target = shadowRTs[i];
      this.bindRT(target);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const proj = [f.lamp[0], f.lamp[1], layer.shadow.scale, layer.shadow.dy];
      this.drawItems(layer.items, f, proj, false);
      gl.disable(gl.BLEND);
      const px = layer.shadow.blur * pxPerStage;
      this.blur(target, rt.shadowTmp, px);
      if (px > 6) this.blur(target, rt.shadowTmp, px * 0.5);
      strengths[i] = layer.shadow.strength;
    });

    // 2) lit kelir + shadows
    this.bindRT(rt.scene);
    gl.useProgram(p.bg.prog);
    this.bindTex(0, this.tex.background.tex);
    this.bindTex(1, rt.shadow0.tex);
    this.bindTex(2, rt.shadow1.tex);
    gl.uniform1i(p.bg.u('uBg'), 0);
    gl.uniform1i(p.bg.u('uShadow0'), 1);
    gl.uniform1i(p.bg.u('uShadow1'), 2);
    gl.uniform4f(p.bg.u('uView'), f.view.x, f.view.y, f.view.w, f.view.h);
    gl.uniform2f(p.bg.u('uHot'), f.hot[0], f.hot[1]);
    gl.uniform1f(p.bg.u('uFlicker'), f.flicker);
    gl.uniform2f(p.bg.u('uShadowK'), strengths[0], strengths[1]);
    gl.uniform1f(p.bg.u('uTime'), f.time);
    this.fullscreen(p.bg);

    // 3) puppets and sticks, lit by the blencong
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const layer of layers) this.drawItems(layer.items, f, [0, 0, 1, 0], true);
    gl.disable(gl.BLEND);

    // 4) bloom from flame-lit highlights
    this.bindRT(rt.bloomA);
    gl.useProgram(p.bright.prog);
    this.bindTex(0, rt.scene.tex);
    gl.uniform1i(p.bright.u('uTex'), 0);
    gl.uniform1f(p.bright.u('uThreshold'), 1.05);
    this.fullscreen(p.bright);
    this.blur(rt.bloomA, rt.bloomB, 10);
    this.blur(rt.bloomA, rt.bloomB, 22);

    // 5) grade to screen
    this.bindRT(null);
    gl.useProgram(p.final.prog);
    this.bindTex(0, rt.scene.tex);
    this.bindTex(1, rt.bloomA.tex);
    gl.uniform1i(p.final.u('uScene'), 0);
    gl.uniform1i(p.final.u('uBloom'), 1);
    gl.uniform1f(p.final.u('uBloomK'), 0.22);
    gl.uniform2f(p.final.u('uRes'), W, H);
    gl.uniform1f(p.final.u('uTime'), f.time);
    this.fullscreen(p.final);
  }
}
