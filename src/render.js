// WebGL2 renderer. The soup is uploaded as raw bytes and everything else happens on
// the GPU: colouring, the per-cell activity glow, mipmapped zoom-out, crisp zoom-in
// with instruction glyphs, bloom.
//
// Pipeline per frame:
//   glow      activity decay + new rewrites          -> glow texture (one texel per cell)
//   colourise bytes -> colours, 8x8 pixels per cell  -> world texture (mipmapped)
//   view      camera, grid, glyphs, overlays         -> scene texture
//   bloom     bright pass, blur down, blur up        -> half-res texture
//   composite scene + bloom, vignette                -> screen

import { OP } from './bff.js';

// Colour per instruction. Head 0 moves are blue, head 1 moves violet, arithmetic
// green, copies amber (the colour of life here), loops pink.
export const OP_COLOURS = {
  '<': [47, 139, 255],
  '>': [54, 214, 255],
  '{': [154, 91, 255],
  '}': [228, 91, 255],
  '-': [25, 195, 125],
  '+': [184, 240, 60],
  '.': [255, 176, 32],
  ',': [255, 106, 26],
  '[': [255, 59, 107],
  ']': [255, 134, 176],
};

export function byteColour(b) {
  if (b === 0) return [0, 0, 0];
  const op = OP_COLOURS[String.fromCharCode(b)];
  if (op) return op;
  const t = b / 255;
  return [9 + 13 * t, 10 + 14 * t, 17 + 24 * t];
}

const VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 o;
`;

const FS_GLOW = `${HEAD}
uniform sampler2D uPrev;
uniform sampler2D uHeat;
uniform float uDecay;
uniform float uFresh;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float prev = texelFetch(uPrev, c, 0).r * uDecay;
  // heat = positions rewired by one interaction (0..64), mirror flips excluded.
  // Junk fiddling scores 0-1; a replicator overwriting a stranger scores 10-40.
  float rewired = texelFetch(uHeat, c, 0).r * 255.0;
  float fresh = smoothstep(2.0, 16.0, rewired) * uFresh;
  o = vec4(max(prev, fresh));
}`;

const FS_COLOURISE = `${HEAD}
uniform sampler2D uSoup;
uniform sampler2D uPalette;
uniform sampler2D uSpecies;
uniform sampler2D uGlow;
uniform ivec2 uGrid;
uniform int uMode;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec2 cell = px >> 3;
  int i = ((px.y & 7) << 3) | (px.x & 7);
  int p = cell.y * uGrid.x + cell.x;
  float b = texelFetch(uSoup, ivec2(((p & 15) << 6) | i, p >> 4), 0).r;
  vec3 code = texelFetch(uPalette, ivec2(int(b * 255.0 + 0.5), 0), 0).rgb;
  vec4 sp = texelFetch(uSpecies, cell, 0);
  float glow = texelFetch(uGlow, cell, 0).r;
  vec3 col;
  if (uMode == 1) {
    float lum = dot(code, vec3(0.3, 0.5, 0.2));
    if (sp.a > 0.9) col = sp.rgb * (0.34 + 1.05 * lum);
    else if (sp.a > 0.4) col = mix(code * 0.3, sp.rgb, 0.45);
    else col = code * 0.22;
    col += vec3(1.0, 0.9, 0.75) * glow * 0.12;
  } else if (uMode == 2) {
    col = code * 0.16 + vec3(1.0, 0.5, 0.12) * glow * glow * 1.25 + vec3(1.0) * pow(glow, 4.0) * 0.55;
  } else {
    col = code + vec3(1.0, 0.82, 0.55) * glow * 0.08;
  }
  o = vec4(col, 1.0);
}`;

const FS_VIEW = `${HEAD}
uniform sampler2D uWorld;
uniform sampler2D uSoup;
uniform sampler2D uGlyphs;
uniform sampler2D uPalette;
uniform vec2 uRes;
uniform vec2 uWorldSize;
uniform ivec2 uGrid;
uniform vec2 uCenter;
uniform float uZoom;
uniform vec4 uSelected; // cell x, cell y, alpha, unused
uniform vec4 uPartner;  // the cell it is being run against
uniform vec4 uBrush;    // world x, world y, radius in world px, alpha
uniform vec4 uMarker;   // world x, world y, radius in world px, alpha
uniform float uTime;

float cellOutline(vec2 w, vec2 cell) {
  vec2 lo = cell * 8.0;
  vec2 d = max(lo - w, w - (lo + 8.0));
  float px = max(d.x, d.y) * uZoom; // screen px outside the cell; negative inside
  float line = 1.0 - smoothstep(0.8, 1.9, abs(px - 1.6));
  float halo = px > 0.0 ? exp(-px / 9.0) * 0.5 : 0.0;
  return line + halo;
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 w = uCenter + (frag - 0.5 * uRes) / uZoom;
  vec3 col = vec3(0.010, 0.010, 0.020);
  vec2 edge = max(-w, w - uWorldSize);
  float outside = max(edge.x, edge.y);

  // The camera is a pure scale, so screen-space derivatives of w are known exactly.
  // (Implicit derivatives would be undefined inside these branches.)
  vec2 ddx = vec2(1.0 / uZoom, 0.0);
  vec2 ddy = vec2(0.0, 1.0 / uZoom);

  if (outside < 0.0) {
    if (uZoom < 1.0) {
      col = textureGrad(uWorld, w / uWorldSize, ddx / uWorldSize, ddy / uWorldSize).rgb;
    } else {
      // crisp texels with one screen pixel of antialiasing at their edges
      vec2 fl = floor(w - 0.5) + 0.5;
      vec2 t = clamp((w - fl - 0.5) * uZoom + 0.5, 0.0, 1.0);
      col = textureLod(uWorld, (fl + t) / uWorldSize, 0.0).rgb;
    }

    // instruction glyphs, once a byte is big enough to read
    float glyphs = smoothstep(9.0, 15.0, uZoom);
    if (glyphs > 0.0) {
      ivec2 px = ivec2(floor(w));
      ivec2 cell = px >> 3;
      int i = ((px.y & 7) << 3) | (px.x & 7);
      int p = cell.y * uGrid.x + cell.x;
      int b = int(texelFetch(uSoup, ivec2(((p & 15) << 6) | i, p >> 4), 0).r * 255.0 + 0.5);
      vec4 pal = texelFetch(uPalette, ivec2(b, 0), 0);
      vec2 auv = (vec2(float(b & 15), float(b >> 4)) + fract(w)) / 16.0;
      float a = textureGrad(uGlyphs, auv, ddx / 16.0, ddy / 16.0).r;
      vec3 ink = mix(vec3(0.40, 0.42, 0.56), mix(pal.rgb, vec3(1.0), 0.6), pal.a);
      vec3 paper = col * mix(0.55, 0.4, pal.a);
      col = mix(col, mix(paper, ink, a), glyphs);
    }

    // borders between programs
    float grid = smoothstep(2.5, 7.0, uZoom);
    if (grid > 0.0) {
      vec2 d = abs(fract(w / 8.0 + 0.5) - 0.5) * 8.0 * uZoom;
      float line = 1.0 - smoothstep(0.0, 1.25, min(d.x, d.y));
      col = mix(col, vec3(0.0), line * 0.6 * grid);
    }
  } else {
    float d = outside * uZoom;
    col += vec3(0.30, 0.33, 0.55) * (1.0 - smoothstep(0.0, 1.5, d)) * 0.5;
    col += vec3(0.05, 0.06, 0.12) * exp(-d / 60.0);
  }

  if (uPartner.z > 0.0) col = mix(col, vec3(0.89, 0.36, 1.0), clamp(cellOutline(w, uPartner.xy), 0.0, 1.0) * uPartner.z * 0.9);
  if (uSelected.z > 0.0) {
    float pulse = 0.82 + 0.18 * sin(uTime * 4.0);
    col = mix(col, vec3(1.0), clamp(cellOutline(w, uSelected.xy) * pulse, 0.0, 1.0) * uSelected.z);
  }
  if (uBrush.w > 0.0) {
    float d = abs(length(w - uBrush.xy) - uBrush.z) * uZoom;
    col = mix(col, vec3(1.0, 0.72, 0.3), (1.0 - smoothstep(0.6, 1.8, d)) * uBrush.w);
  }
  if (uMarker.w > 0.0) {
    float d = abs(length(w - uMarker.xy) - uMarker.z) * uZoom;
    col += vec3(1.0, 0.85, 0.55) * (1.0 - smoothstep(0.5, 3.0, d)) * uMarker.w;
  }
  o = vec4(col, 1.0);
}`;

const FS_DOWN = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uHalfPixel;
uniform float uThreshold; // > 0: keep only bright parts (first pass)
void main() {
  vec3 sum = texture(uTex, vUv).rgb * 4.0;
  sum += texture(uTex, vUv - uHalfPixel).rgb;
  sum += texture(uTex, vUv + uHalfPixel).rgb;
  sum += texture(uTex, vUv + vec2(uHalfPixel.x, -uHalfPixel.y)).rgb;
  sum += texture(uTex, vUv - vec2(uHalfPixel.x, -uHalfPixel.y)).rgb;
  vec3 c = sum / 8.0;
  if (uThreshold > 0.0) {
    float l = max(c.r, max(c.g, c.b));
    c *= smoothstep(uThreshold, uThreshold + 0.45, l);
  }
  o = vec4(c, 1.0);
}`;

const FS_UP = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uHalfPixel;
void main() {
  vec2 h = uHalfPixel;
  vec3 sum = texture(uTex, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  sum += texture(uTex, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  sum += texture(uTex, vUv + vec2(0.0, h.y * 2.0)).rgb;
  sum += texture(uTex, vUv + vec2(h.x, h.y)).rgb * 2.0;
  sum += texture(uTex, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  sum += texture(uTex, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  sum += texture(uTex, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  sum += texture(uTex, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(sum / 12.0, 1.0);
}`;

const FS_COMPOSITE = `${HEAD}
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomAmount;
uniform float uFlash;
uniform float uTime;
void main() {
  vec3 c = texture(uScene, vUv).rgb + texture(uBloom, vUv).rgb * uBloomAmount;
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * 0.5;
  c += vec3(1.0, 0.95, 0.85) * uFlash;
  float n = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;

const SOUP_TEX_WIDTH = 1024; // 16 programs of 64 bytes per texture row
const BLOOM_LEVELS = 3;

export class Renderer {
  constructor(canvas, gridW, gridH) {
    this.canvas = canvas;
    this.gridW = gridW;
    this.gridH = gridH;
    this.cells = gridW * gridH;
    this.worldW = gridW * 8;
    this.worldH = gridH * 8;

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.progGlow = this.program(FS_GLOW);
    this.progColourise = this.program(FS_COLOURISE);
    this.progView = this.program(FS_VIEW);
    this.progDown = this.program(FS_DOWN);
    this.progUp = this.program(FS_UP);
    this.progComposite = this.program(FS_COMPOSITE);

    // raw soup bytes
    this.soupRows = Math.ceil(this.cells / 16);
    this.texSoup = this.texture(gl.R8, SOUP_TEX_WIDTH, this.soupRows, gl.RED, gl.NEAREST);

    // per-cell data
    this.texHeat = this.texture(gl.R8, gridW, gridH, gl.RED, gl.NEAREST);
    this.texSpecies = this.texture(gl.RGBA8, gridW, gridH, gl.RGBA, gl.NEAREST);
    this.glow = [0, 1].map(() => this.target(gl.R8, gridW, gridH, gl.RED, gl.NEAREST));
    this.glowIndex = 0;
    this.heatFresh = false;

    // palette: rgb = colour, a = 1 for instructions
    const palette = new Uint8Array(256 * 4);
    for (let b = 0; b < 256; b++) {
      const [r, g, bl] = byteColour(b);
      palette.set([r, g, bl, OP[b] ? 255 : 0], b * 4);
    }
    this.texPalette = this.texture(gl.RGBA8, 256, 1, gl.RGBA, gl.NEAREST, palette);

    this.texGlyphs = this.glyphAtlas();

    // the colourised universe, with mipmaps for zooming out
    this.world = this.target(gl.RGBA8, this.worldW, this.worldH, gl.RGBA, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, this.world.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);

    this.scene = null;
    this.bloom = [];
    this.width = 0;
    this.height = 0;
    this.lastTime = 0;
  }

  program(fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(s)}`);
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Shader link failed: ${gl.getProgramInfoLog(prog)}`);
    }
    const u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(prog, i).name;
      u[name] = gl.getUniformLocation(prog, name);
    }
    return { prog, u };
  }

  texture(internal, w, h, format, filter, data = null) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  target(internal, w, h, format, filter) {
    const gl = this.gl;
    const tex = this.texture(internal, w, h, format, filter);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  dispose(t) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  // 16x16 atlas: instructions as their character, everything else as two hex digits.
  glyphAtlas() {
    const gl = this.gl;
    const cell = 64;
    const c = document.createElement('canvas');
    c.width = c.height = cell * 16;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const mono = 'ui-monospace, "Cascadia Mono", "SF Mono", Consolas, Menlo, monospace';
    for (let b = 0; b < 256; b++) {
      const x = (b & 15) * cell + cell / 2;
      const y = (b >> 4) * cell + cell / 2;
      if (OP[b]) {
        g.font = `700 44px ${mono}`;
        g.fillText(String.fromCharCode(b), x, y + 2);
      } else {
        g.font = `500 22px ${mono}`;
        g.fillText(b.toString(16).padStart(2, '0'), x, y + 1);
      }
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, c);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // New soup contents: `bytes` is cells*64 program bytes, `heat` one byte per cell.
  setFrame(bytes, heat) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texSoup);
    const fullRows = this.cells >> 4;
    if (fullRows) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SOUP_TEX_WIDTH, fullRows, gl.RED, gl.UNSIGNED_BYTE, bytes);
    }
    const rest = this.cells & 15;
    if (rest) {
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, fullRows, rest * 64, 1, gl.RED, gl.UNSIGNED_BYTE,
        bytes.subarray(fullRows * SOUP_TEX_WIDTH),
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texHeat);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.gridW, this.gridH, gl.RED, gl.UNSIGNED_BYTE, heat);
    this.heatFresh = true;
  }

  setSpecies(rgba) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texSpecies);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.gridW, this.gridH, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  clearGlow() {
    const gl = this.gl;
    for (const t of this.glow) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Match the drawing buffer to the canvas's CSS size. Returns true if it changed.
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height) return false;
    const gl = this.gl;
    this.canvas.width = this.width = w;
    this.canvas.height = this.height = h;
    this.dispose(this.scene);
    this.bloom.forEach((t) => this.dispose(t));
    this.scene = this.target(gl.RGBA8, w, h, gl.RGBA, gl.LINEAR);
    this.bloom = [];
    for (let i = 1; i <= BLOOM_LEVELS; i++) {
      this.bloom.push(this.target(gl.RGBA8, Math.max(1, w >> i), Math.max(1, h >> i), gl.RGBA, gl.LINEAR));
    }
    return true;
  }

  bind(unit, tex, location) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(location, unit);
  }

  draw(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : this.width, target ? target.h : this.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // view: { cx, cy, zoom } in world pixels (one pixel per byte) and device pixels per world pixel.
  // opts: { mode, selected, partner, brush, marker, flash, time }
  render(view, opts) {
    const gl = this.gl;
    this.resize();
    const time = opts.time || 0;
    const dt = Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    gl.bindVertexArray(this.vao);

    // 1. activity glow
    const src = this.glow[this.glowIndex];
    const dst = this.glow[1 - this.glowIndex];
    this.glowIndex = 1 - this.glowIndex;
    let p = this.progGlow;
    gl.useProgram(p.prog);
    this.bind(0, src.tex, p.u.uPrev);
    this.bind(1, this.texHeat, p.u.uHeat);
    gl.uniform1f(p.u.uDecay, Math.exp(-dt / 0.3));
    gl.uniform1f(p.u.uFresh, this.heatFresh ? 1 : 0);
    this.heatFresh = false;
    this.draw(dst);

    // 2. colourise the universe
    p = this.progColourise;
    gl.useProgram(p.prog);
    this.bind(0, this.texSoup, p.u.uSoup);
    this.bind(1, this.texPalette, p.u.uPalette);
    this.bind(2, this.texSpecies, p.u.uSpecies);
    this.bind(3, dst.tex, p.u.uGlow);
    gl.uniform2i(p.u.uGrid, this.gridW, this.gridH);
    gl.uniform1i(p.u.uMode, opts.mode || 0);
    this.draw(this.world);
    gl.bindTexture(gl.TEXTURE_2D, this.world.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // 3. camera
    p = this.progView;
    gl.useProgram(p.prog);
    this.bind(0, this.world.tex, p.u.uWorld);
    this.bind(1, this.texSoup, p.u.uSoup);
    this.bind(2, this.texGlyphs, p.u.uGlyphs);
    this.bind(3, this.texPalette, p.u.uPalette);
    gl.uniform2f(p.u.uRes, this.width, this.height);
    gl.uniform2f(p.u.uWorldSize, this.worldW, this.worldH);
    gl.uniform2i(p.u.uGrid, this.gridW, this.gridH);
    gl.uniform2f(p.u.uCenter, view.cx, view.cy);
    gl.uniform1f(p.u.uZoom, view.zoom);
    gl.uniform4fv(p.u.uSelected, opts.selected || [0, 0, 0, 0]);
    gl.uniform4fv(p.u.uPartner, opts.partner || [0, 0, 0, 0]);
    gl.uniform4fv(p.u.uBrush, opts.brush || [0, 0, 0, 0]);
    gl.uniform4fv(p.u.uMarker, opts.marker || [0, 0, 0, 0]);
    gl.uniform1f(p.u.uTime, time);
    this.draw(this.scene);

    // 4. bloom: bright pass + blur down, then blur back up
    p = this.progDown;
    gl.useProgram(p.prog);
    let from = this.scene;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const to = this.bloom[i];
      this.bind(0, from.tex, p.u.uTex);
      gl.uniform2f(p.u.uHalfPixel, 0.5 / from.w, 0.5 / from.h);
      gl.uniform1f(p.u.uThreshold, i === 0 ? 0.42 : 0);
      this.draw(to);
      from = to;
    }
    p = this.progUp;
    gl.useProgram(p.prog);
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      const to = this.bloom[i - 1];
      this.bind(0, this.bloom[i].tex, p.u.uTex);
      gl.uniform2f(p.u.uHalfPixel, 0.5 / this.bloom[i].w, 0.5 / this.bloom[i].h);
      this.draw(to);
    }

    // 5. composite to the screen
    p = this.progComposite;
    gl.useProgram(p.prog);
    this.bind(0, this.scene.tex, p.u.uScene);
    this.bind(1, this.bloom[0].tex, p.u.uBloom);
    gl.uniform1f(p.u.uBloomAmount, opts.bloom ?? 0.9);
    gl.uniform1f(p.u.uFlash, opts.flash || 0);
    gl.uniform1f(p.u.uTime, time % 100);
    this.draw(null);
  }
}
