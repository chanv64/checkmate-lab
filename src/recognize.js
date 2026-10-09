// Offline chessboard recognition from a screenshot. Everything runs in the browser.
//
// 1. Find the 8×8 grid: the lines between squares show up as columns/rows where the
//    image steps light→dark along half their length and dark→light along the other half.
// 2. For each square, estimate its background from the corners, flood-fill the background
//    in from the edges (passing through brightly coloured arrows and highlights), and keep
//    the largest leftover blob as the piece.
// 3. Colour = how much of the blob is bright vs dark. Type = nearest reference silhouette
//    (our own piece set, system chess glyphs, and anything learned from your corrections).
// 4. Guess orientation (which side sits at the bottom) and who is to move.
import { svgFor } from "./pieces.js";
// Reference outlines learned from labelled screenshots (test/train.html), e.g. Chess.com's set.
import trainedRaw from "./trained-templates.json";

const CELL = 64;          // squares are resampled to CELL×CELL pixels
const GRID = 20;          // silhouettes are compared on a GRID×GRID raster
const TYPES = ["k", "q", "r", "b", "n", "p"];
const LEARN_KEY = "checkmate-lab-learned";

// ---------------------------------------------------------------- utilities
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function median(arr) { const s = [...arr].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; }
function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

// ---------------------------------------------------------------- 1. grid
function lineProfiles(img) {
  const { data, width: w, height: h } = img;
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const cP = new Float64Array(w), cN = new Float64Array(w), rP = new Float64Array(h), rN = new Float64Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x < w - 1) { const d = L[i + 1] - L[i]; if (d > 0) cP[x] += d; else cN[x] -= d; }
    if (y < h - 1) { const d = L[i + w] - L[i]; if (d > 0) rP[y] += d; else rN[y] -= d; }
  }
  const prof = (P, N) => {
    const v = Array.from(P, (p, i) => Math.sqrt(p * N[i]));
    const cap = [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.995)] || 1;
    const n = v.map(x => Math.min(1, x / cap));
    return n.map((x, i) => Math.max(x, n[i - 1] ?? 0, n[i + 1] ?? 0)); // tolerate 1px misalignment
  };
  return { cols: prof(cP, cN), rows: prof(rP, rN), L, w, h };
}

function lineCandidates(V, minS, maxS) {
  const out = [];
  for (let s = minS; s <= maxS; s += 0.25) {
    for (let x0 = 0; x0 + 8 * s < V.length - 1; x0++) {
      let sc = 0;
      for (let k = 1; k <= 7; k++) sc += V[Math.round(x0 + k * s)];
      sc += 0.5 * (V[x0] + V[Math.round(x0 + 8 * s)]);
      out.push({ x0, s, score: sc });
    }
  }
  out.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const c of out) {
    if (keep.every(k => Math.abs(k.s - c.s) / k.s > 0.03 || Math.abs(k.x0 - c.x0) > k.s / 4)) keep.push(c);
    if (keep.length >= 6) break;
  }
  return keep;
}

function checkerScore(L, w, gx, gy) {
  const s = [], t = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    // sample the 4 corners of the square, where pieces rarely reach
    const vals = [];
    for (const [fx, fy] of [[0.12, 0.12], [0.88, 0.12], [0.12, 0.88], [0.88, 0.88]]) {
      const x = Math.round(gx.x0 + (c + fx) * gx.s), y = Math.round(gy.x0 + (r + fy) * gy.s);
      vals.push(L[y * w + x]);
    }
    ((r + c) % 2 ? s : t).push(median(vals));
  }
  const m1 = median(s), m0 = median(t);
  const spread = (arr, m) => median(arr.map(v => Math.abs(v - m)));
  return Math.abs(m1 - m0) / (spread(s, m1) + spread(t, m0) + 6);
}

function detectGrid(img) {
  const { cols, rows, L, w, h } = lineProfiles(img);
  const dim = Math.min(w, h);
  const minS = Math.max(8, dim / 26), maxS = dim / 8.05;
  const cx = lineCandidates(cols, minS, Math.min(maxS, (w - 2) / 8));
  const cy = lineCandidates(rows, minS, Math.min(maxS, (h - 2) / 8));
  let best = null;
  for (const a of cx) for (const b of cy) {
    if (Math.abs(a.s - b.s) / Math.max(a.s, b.s) > 0.06) continue;
    const score = (a.score + b.score) / 18 + 0.35 * Math.min(4, checkerScore(L, w, a, b));
    if (!best || score > best.score) best = { gx: a, gy: b, score };
  }
  if (best) { best.gx = refine(cols, best.gx); best.gy = refine(rows, best.gy); }
  return best;
}

// Fine-tune one axis with sub-pixel steps, scoring only the 7 inner lines
// (outer edges are often confused by frames and coordinate margins).
function refine(V, { x0, s }) {
  const at = x => { const i = Math.floor(x), f = x - i; return (V[i] ?? 0) * (1 - f) + (V[i + 1] ?? 0) * f; };
  let best = { x0, s, score: -1 };
  for (let ss = s * 0.96; ss <= s * 1.04; ss += 0.05) {
    for (let xx = x0 - s / 3; xx <= x0 + s / 3; xx += 0.25) {
      if (xx < 0 || xx + 8 * ss > V.length - 1) continue;
      let sc = 0;
      for (let k = 1; k <= 7; k++) sc += at(xx + k * ss);
      if (sc > best.score) best = { x0: xx, s: ss, score: sc };
    }
  }
  return best;
}

// ---------------------------------------------------------------- 2. one square
function squareBackground(px) {
  // Background: the most common colour in a ring just inside the square's edge.
  // Corners alone get fooled when labels, badges or arrows sit in them.
  const ring = [];
  for (let y = 1; y < CELL - 1; y++) for (let x = 1; x < CELL - 1; x++) {
    if (x > 4 && x < CELL - 5 && y > 4 && y < CELL - 5) continue;
    ring.push(y * CELL + x);
  }
  const bins = new Map();
  for (const i of ring) {
    const key = (px[i * 4] >> 4) << 8 | (px[i * 4 + 1] >> 4) << 4 | (px[i * 4 + 2] >> 4);
    bins.set(key, (bins.get(key) || 0) + 1);
  }
  // merge each bin with its neighbours so a colour split across a bin edge still wins
  let bestKey = 0, bestN = -1;
  for (const key of bins.keys()) {
    const r = key >> 8, g = (key >> 4) & 15, b = key & 15;
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++)
      n += bins.get((r + dr) << 8 | (g + dg) << 4 | (b + db)) || 0;
    if (n > bestN) { bestN = n; bestKey = key; }
  }
  const samples = [[], [], []];
  for (const i of ring) {
    const r = px[i * 4] >> 4, g = px[i * 4 + 1] >> 4, b = px[i * 4 + 2] >> 4;
    if (Math.abs(r - (bestKey >> 8)) <= 1 && Math.abs(g - ((bestKey >> 4) & 15)) <= 1 && Math.abs(b - (bestKey & 15)) <= 1)
      for (let k = 0; k < 3; k++) samples[k].push(px[i * 4 + k]);
  }
  const bg = samples.map(median);
  // texture allowance: how far typical edge pixels sit from the background colour
  const spread = median(ring.map(i => dist3([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]], bg)));
  return { bg, spread };
}

/**
 * px: CELL×CELL RGBA pixels. squareColour (optional): the board's usual colour for this
 * square's parity, so highlights and "check" glows can't pass for the background.
 */
function extractSquare(px, squareColour) {
  const N = CELL * CELL;
  const rgb = i => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
  let { bg, spread } = squareBackground(px);
  const T = Math.min(80, Math.max(38, spread * 3.2));
  // If the board's normal colour for this square still shows around the edge (e.g. a red
  // "check" glow fading out toward the corners), trust it over the edge's most common
  // colour, which can be a greyish blend that thin outlines blur into.
  if (squareColour) {
    let near = 0, total = 0;
    for (let y = 1; y < CELL - 1; y++) for (let x = 1; x < CELL - 1; x++) {
      if (x > 4 && x < CELL - 5 && y > 4 && y < CELL - 5) continue;
      total++;
      if (dist3(rgb(y * CELL + x), squareColour) < T) near++;
    }
    if (near / total > 0.2) bg = squareColour;
  }
  const isBg = c => dist3(c, bg) < T || (squareColour && dist3(c, squareColour) < T);
  const passable = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const c = rgb(i);
    const mx = Math.max(...c), mn = Math.min(...c);
    const sat = mx > 40 ? (mx - mn) / mx : 0;
    passable[i] = isBg(c) || sat > 0.5 ? 1 : 0;
  }
  // flood the background in from the edges
  const seen = new Uint8Array(N), stack = [];
  for (let k = 0; k < CELL; k++) for (const i of [k, (CELL - 1) * CELL + k, k * CELL, k * CELL + CELL - 1]) {
    if (passable[i] && !seen[i]) { seen[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop(), x = i % CELL, y = (i / CELL) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < CELL - 1 ? i + 1 : -1, y > 0 ? i - CELL : -1, y < CELL - 1 ? i + CELL : -1]) {
      if (j >= 0 && !seen[j] && passable[j]) { seen[j] = 1; stack.push(j); }
    }
  }
  // largest remaining blob = the piece
  const label = new Int32Array(N); let bestLab = 0, bestArea = 0, lab = 0;
  for (let i = 0; i < N; i++) {
    if (seen[i] || label[i]) continue;
    lab++; let area = 0; stack.push(i); label[i] = lab;
    while (stack.length) {
      const p = stack.pop(); area++;
      const x = p % CELL, y = (p / CELL) | 0;
      for (const j of [x > 0 ? p - 1 : -1, x < CELL - 1 ? p + 1 : -1, y > 0 ? p - CELL : -1, y < CELL - 1 ? p + CELL : -1]) {
        if (j >= 0 && !seen[j] && !label[j]) { label[j] = lab; stack.push(j); }
      }
    }
    if (area > bestArea) { bestArea = area; bestLab = lab; }
  }
  const res = { bg, area: bestArea / N, piece: false };
  if (!bestLab || bestArea < N * 0.045) return res;
  // Colour: median brightness of the piece's inside (skipping the outline and any
  // enclosed background), which ignores the thin light details drawn on dark pieces.
  let x0 = CELL, y0 = CELL, x1 = -1, y1 = -1;
  const inner = [], all = [];
  const inBlob = j => j >= 0 && j < N && label[j] === bestLab;
  for (let i = 0; i < N; i++) {
    if (label[i] !== bestLab) continue;
    const x = i % CELL, y = (i / CELL) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    const c = rgb(i);
    if (isBg(c)) continue;
    const mx = Math.max(...c), mn = Math.min(...c);
    if (mx > 40 && (mx - mn) / mx > 0.3) continue;   // coloured glow or arrow, not white/black paint
    const l = lum(...c);
    all.push(l);
    if (x > 1 && x < CELL - 2 && inBlob(i - 2) && inBlob(i + 2) && inBlob(i - 2 * CELL) && inBlob(i + 2 * CELL)) inner.push(l);
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bh < CELL * 0.22 || bw < CELL * 0.12) return res;
  res.piece = true;
  res.whiteness = median(inner.length > 30 ? inner : all) / 255;
  res.h = bh / CELL;
  res.aspect = bw / bh;
  res.grid = rasterise(label, bestLab, x0, y0, bw, bh);
  res.sym = symmetric(label, bestLab, y0, bh);
  return res;
}

// Most pieces are left-right symmetric. Mirroring the blob about its axis and taking the
// union restores a side hidden under an arrow; we compare this version too.
function symmetric(label, lab, y0, bh) {
  let sx = 0, n = 0;
  for (let y = y0; y < y0 + Math.max(2, bh * 0.2); y++) for (let x = 0; x < CELL; x++) if (label[y * CELL + x] === lab) { sx += x; n++; }
  const axis = n ? sx / n : CELL / 2;
  const sym = new Int32Array(CELL * CELL);
  let x0 = CELL, x1 = -1;
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const m = Math.round(2 * axis - x);
    if (label[y * CELL + x] === lab || (m >= 0 && m < CELL && label[y * CELL + m] === lab)) {
      sym[y * CELL + x] = 1; if (x < x0) x0 = x; if (x > x1) x1 = x;
    }
  }
  const bw = x1 - x0 + 1;
  return { grid: rasterise(sym, 1, x0, y0, bw, bh), aspect: bw / bh };
}

/** Share of strongly red pixels, used to spot a "king in check" glow. */
function redShare(px) {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] - Math.max(px[i + 1], px[i + 2]) > 70) n++;
  return n / (px.length / 4);
}

function rasterise(label, lab, x0, y0, bw, bh) {
  const g = new Float32Array(GRID * GRID);
  for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
    let on = 0, tot = 0;
    const ya = y0 + (gy * bh) / GRID, yb = y0 + ((gy + 1) * bh) / GRID;
    const xa = x0 + (gx * bw) / GRID, xb = x0 + ((gx + 1) * bw) / GRID;
    for (let y = Math.floor(ya); y < Math.max(Math.floor(ya) + 1, Math.ceil(yb)); y++)
      for (let x = Math.floor(xa); x < Math.max(Math.floor(xa) + 1, Math.ceil(xb)); x++) { tot++; if (label[y * CELL + x] === lab) on++; }
    g[gy * GRID + gx] = on / tot > 0.5 ? 1 : 0;
  }
  return g;
}

// ---------------------------------------------------------------- 3. reference silhouettes
let templatesPromise = null;
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }

async function buildTemplates() {
  const c = canvas(CELL, CELL), ctx = c.getContext("2d", { willReadFrequently: true });
  const sets = [];
  const extract = draw => {
    ctx.fillStyle = "rgb(120,150,180)"; ctx.fillRect(0, 0, CELL, CELL);
    draw();
    return extractSquare(ctx.getImageData(0, 0, CELL, CELL).data);
  };
  // our own piece artwork
  const ours = {};
  for (const t of TYPES) {
    const svg = svgFor("w", t).replace("<svg ", `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${CELL}" `);
    const im = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
    ours[t] = extract(() => ctx.drawImage(im, CELL * 0.04, CELL * 0.04, CELL * 0.92, CELL * 0.92));
  }
  sets.push(ours);
  // filled chess glyphs from whatever symbol fonts the system has
  const glyph = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  for (const font of ['"Apple Symbols"', '"Segoe UI Symbol"', '"DejaVu Sans"', "serif"]) {
    const set = {};
    for (const t of TYPES) set[t] = extract(() => {
      ctx.fillStyle = "#000"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `${CELL * 0.86}px ${font}`;
      ctx.fillText(glyph[t] + "︎", CELL / 2, CELL * 0.52);
    });
    if (TYPES.every(t => set[t].piece)) sets.push(set);
  }
  // normalise heights by each set's king, and add mirrored knights
  const list = [];
  for (const set of sets) {
    const kh = set.k.h;
    for (const t of TYPES) {
      const f = set[t];
      list.push({ t, grid: f.grid, aspect: f.aspect, h: f.h / kh, sym: f.sym });
      if (t === "n") list.push({ t, grid: mirror(f.grid), aspect: f.aspect, h: f.h / kh, sym: f.sym });
    }
  }
  return list;
}
function mirror(g) { const m = new Float32Array(g.length); for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) m[y * GRID + x] = g[y * GRID + GRID - 1 - x]; return m; }

// Outlines are stored as "0101…" strings (learned) or hex, 4 cells per digit (trained).
const bits = str => str.length === GRID * GRID ? Float32Array.from(str, ch => Number(ch))
  : Float32Array.from({ length: GRID * GRID }, (_, i) => (parseInt(str[i >> 2], 16) >> (3 - (i & 3))) & 1);
const fromStored = (s, extra) => ({ t: s.t, aspect: s.a, h: s.h, grid: bits(s.g), sym: s.sg ? { grid: bits(s.sg), aspect: s.sa } : null, ...extra });
const trained = trainedRaw.map(s => fromStored(s, { trained: true }));
function loadLearned() {
  try { return (JSON.parse(localStorage.getItem(LEARN_KEY) || "[]")).map(s => fromStored(s, { learned: true })); }
  catch { return []; }
}
/** Remember confirmed pieces so the next screenshot in the same style reads better. */
export function learn(samples) {
  try {
    const all = JSON.parse(localStorage.getItem(LEARN_KEY) || "[]");
    for (const s of samples) all.push({ t: s.t, a: +s.aspect.toFixed(3), h: +s.h.toFixed(3), g: Array.from(s.grid).join(""),
      sg: s.sym ? Array.from(s.sym.grid).join("") : undefined, sa: s.sym ? +s.sym.aspect.toFixed(3) : undefined });
    const per = {}; const kept = [];
    for (const s of all.reverse()) { per[s.t] = (per[s.t] || 0) + 1; if (per[s.t] <= 24) kept.push(s); }
    localStorage.setItem(LEARN_KEY, JSON.stringify(kept.reverse()));
  } catch {}
}
export function forgetLearned() { try { localStorage.removeItem(LEARN_KEY); } catch {} }
export function learnedCount() { return loadLearned().length; }

function distance(a, b) {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.grid.length; i++) { const x = a.grid[i], y = b.grid[i]; if (x && y) inter++; if (x || y) uni++; }
  return (1 - inter / Math.max(1, uni)) + 0.6 * Math.abs(a.aspect - b.aspect) + 1.1 * Math.abs(a.h - b.h);
}
function rank(f, templates) {
  const best = {};
  for (const tp of templates) {
    let d = distance(f, tp);
    if (f.sym && tp.sym && tp.t !== "n") d = Math.min(d, distance({ ...f.sym, h: f.h }, { ...tp.sym, h: tp.h }) + 0.05);
    d -= tp.learned ? 0.04 : 0;
    if (best[tp.t] === undefined || d < best[tp.t]) best[tp.t] = d;
  }
  return TYPES.map(t => ({ t, d: best[t] ?? 9 })).sort((a, b) => a.d - b.d);
}

// ---------------------------------------------------------------- 4. whole board
/**
 * @param {HTMLImageElement|ImageBitmap} image
 * @param {{ trained?: boolean }} [options] trained: false ignores the built-in trained outlines (used by test/train.html)
 * @returns {Promise<null | { position, flipped, turn, turnReason, grid, squares, pieces }>}
 */
export async function recognize(image, { trained: useTrained = true } = {}) {
  templatesPromise ||= buildTemplates();
  const templates = [...(await templatesPromise), ...(useTrained ? trained : []), ...loadLearned()];
  const W = image.naturalWidth || image.width, H = image.naturalHeight || image.height;
  const scale = Math.min(1, 900 / Math.max(W, H));
  const sw = Math.round(W * scale), sh = Math.round(H * scale);
  const small = canvas(sw, sh).getContext("2d", { willReadFrequently: true });
  small.drawImage(image, 0, 0, sw, sh);
  const found = detectGrid(small.getImageData(0, 0, sw, sh));
  if (!found) return null;
  const grid = { x: found.gx.x0 / scale, y: found.gy.x0 / scale, sx: found.gx.s / scale, sy: found.gy.s / scale };

  // read every square
  const cell = canvas(CELL, CELL).getContext("2d", { willReadFrequently: true });
  cell.imageSmoothingQuality = "high";
  const crops = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const inset = 0.015;
    cell.clearRect(0, 0, CELL, CELL);
    cell.drawImage(image, grid.x + (c + inset) * grid.sx, grid.y + (r + inset) * grid.sy,
      grid.sx * (1 - 2 * inset), grid.sy * (1 - 2 * inset), 0, 0, CELL, CELL);
    const px = cell.getImageData(0, 0, CELL, CELL).data;
    crops.push({ r, c, px, bg: squareBackground(px).bg });
  }
  // the board's two square colours (median per parity)
  const parity = [0, 1].map(par => [0, 1, 2].map(k => median(crops.filter(q => (q.r + q.c) % 2 === par).map(q => q.bg[k]))));
  const squares = crops.map(({ r, c, px }) => ({ r, c, red: redShare(px), ...extractSquare(px, parity[(r + c) % 2]) }));
  let pieces = squares.filter(s => s.piece);
  // type: heights relative to the tallest piece (normally a king). A blob that resembles
  // no piece at all is debris (frame edge, label, badge): drop it, then classify again
  // so it can't skew the height scale.
  const classify = () => {
    const maxH = Math.max(...pieces.map(p => p.h));
    for (const p of pieces) {
      p.norm = { grid: p.grid, aspect: p.aspect, h: p.h / maxH, sym: p.sym };
      p.ranked = rank(p.norm, templates);
      p.type = p.ranked[0].t;
    }
  };
  if (pieces.length) classify();
  const debris = pieces.filter(p => p.ranked[0].d > 0.8);
  if (debris.length) {
    for (const p of debris) p.piece = false;
    pieces = pieces.filter(p => p.piece);
    if (pieces.length) classify();
  }
  if (!pieces.length) return { position: {}, flipped: false, turn: "w", turnReason: "", grid, squares, pieces };

  // colour: split the pieces' brightness into two groups (2-means), falling back to mid-grey
  let cut = 0.5;
  { let lo = 0.15, hi = 0.85;
    for (let it = 0; it < 12; it++) {
      const m = (lo + hi) / 2, a = pieces.filter(p => p.whiteness <= m), b = pieces.filter(p => p.whiteness > m);
      if (!a.length || !b.length) break;
      lo = a.reduce((s, p) => s + p.whiteness, 0) / a.length;
      hi = b.reduce((s, p) => s + p.whiteness, 0) / b.length;
    }
    if (hi - lo > 0.25) cut = (lo + hi) / 2; }
  for (const p of pieces) p.color = p.whiteness > cut ? "w" : "b";

  // orientation: White's pieces normally sit at the bottom
  const meanRow = col => { const a = pieces.filter(p => p.color === col); return a.length ? a.reduce((s, p) => s + p.r, 0) / a.length : 3.5; };
  const flipped = meanRow("w") < meanRow("b") - 0.25;
  const sqName = (r, c) => flipped ? "hgfedcba"[c] + (r + 1) : "abcdefgh"[c] + (8 - r);
  for (const s of squares) s.square = sqName(s.r, s.c);

  fixKings(pieces);
  for (const p of pieces) {
    const rk = p.square[1];
    if (p.type === "p" && (rk === "1" || rk === "8")) p.type = p.ranked.find(x => x.t !== "p" && x.t !== "k").t;
  }
  const position = {};
  for (const p of pieces) position[p.square] = p.color + p.type;

  const { turn, reason } = guessTurn(squares);
  return { position, flipped, turn, turnReason: reason, grid, squares, pieces };
}

// Exactly one king per side: keep the best king candidate, demote the rest.
function fixKings(pieces) {
  for (const col of ["w", "b"]) {
    const mine = pieces.filter(p => p.color === col);
    if (!mine.length) continue;
    const kd = p => p.ranked.find(x => x.t === "k").d;
    const king = mine.reduce((a, b) => (kd(b) < kd(a) ? b : a));
    for (const p of mine) {
      if (p === king) p.type = "k";
      else if (p.type === "k") p.type = p.ranked.find(x => x.t !== "k").t;
    }
  }
}

// Who moves? A king sitting on a red-tinted square is in check, so that side moves.
// Otherwise a highlighted pair of squares usually marks the last move.
function guessTurn(squares) {
  const groupBg = [0, 1].map(par => {
    const g = squares.filter(s => (s.r + s.c) % 2 === par);
    return [0, 1, 2].map(k => median(g.map(s => s.bg[k])));
  });
  const checked = squares.find(s => s.piece && s.type === "k" && s.red > 0.04);
  if (checked) return { turn: checked.color, reason: `the ${checked.color === "w" ? "White" : "Black"} king is shown in check` };
  const marked = squares.filter(s => dist3(s.bg, groupBg[(s.r + s.c) % 2]) > 26);
  if (marked.length >= 2 && marked.length <= 4) {
    const occupied = marked.filter(s => s.piece);
    if (occupied.length === 1) {
      const mover = occupied[0].color;
      return { turn: mover === "w" ? "b" : "w", reason: `the last move (to ${occupied[0].square}) is highlighted` };
    }
  }
  return { turn: "w", reason: "" };
}
