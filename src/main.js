import { Chess } from "chess.js";
import { Board, positionFromChess } from "./board.js";
import { Engine } from "./engine.js";
import { svgFor, NAMES } from "./pieces.js";
import { recognize, learn, forgetLearned, learnedCount } from "./recognize.js";

const $ = id => document.getElementById(id);
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// ---------- saved preferences (per browser, optional) ----------
const prefs = (() => { try { return JSON.parse(localStorage.getItem("checkmate-lab") || "{}"); } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem("checkmate-lab", JSON.stringify(prefs)); } catch {} };

// ---------- shared state ----------
const engine = new Engine();
let mode = "play";
const board = new Board($("board"), {
  legalMoves: sq => (mode === "play" ? playLegalMoves(sq) : []),
  onMove: (from, to, promotion) => playUserMove(from, to, promotion),
  onSquareClick: sq => editSquare(sq),
});

engine.ready.then(() => { $("engineStatus").textContent = "Stockfish ready"; $("engineStatus").classList.add("ok"); })
  .catch(() => { $("engineStatus").textContent = "Engine failed to load"; });

// Move speed: slider 0–100 maps to 1.6 s (slow) … 0.12 s (fast) per move.
const speedMs = () => Math.round(1600 * Math.pow(0.12 / 1.6, Number($("speed").value) / 100));
const pauseMs = () => Math.max(350, speedMs() * 1.3);
function showSpeed() { $("speedOut").textContent = (speedMs() / 1000).toFixed(speedMs() < 1000 ? 2 : 1) + " s"; }
$("speed").addEventListener("input", () => { showSpeed(); prefs.speed = $("speed").value; savePrefs(); });
if (prefs.speed) $("speed").value = prefs.speed;
showSpeed();

$("theme").addEventListener("change", () => { applyTheme($("theme").value); prefs.theme = $("theme").value; savePrefs(); });
function applyTheme(t) { document.querySelector(".board-frame").dataset.theme = t; }
if (prefs.theme) $("theme").value = prefs.theme;
applyTheme($("theme").value);

$("flip").addEventListener("click", () => board.setOrientation(board.orientation === "w" ? "b" : "w"));

function markCheck(chess) {
  if (!chess.inCheck()) { board.setCheck(null); return; }
  const k = chess.board().flat().find(p => p && p.type === "k" && p.color === chess.turn());
  board.setCheck(k?.square);
}

function formatScore(score, turn) {
  if (!score) return "";
  // Convert side-to-move score to White's point of view.
  const s = turn === "w" ? score.value : -score.value;
  if (score.type === "mate") return s > 0 ? `White mates in ${Math.abs(s)}` : s < 0 ? `Black mates in ${Math.abs(s)}` : "Mate";
  const pawns = s / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)} ${Math.abs(pawns) < 0.3 ? "(about equal)" : pawns > 0 ? "(White better)" : "(Black better)"}`;
}

function renderMoveList(ol, sans, startTurn, current, onClick) {
  ol.innerHTML = "";
  const cells = startTurn === "b" ? [null, ...sans.map((_, i) => i)] : sans.map((_, i) => i);
  for (let i = 0; i < cells.length; i += 2) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="num">${i / 2 + 1}.</span>`;
    for (const j of [cells[i], cells[i + 1]]) {
      const b = document.createElement("button");
      b.type = "button";
      if (j === null || j === undefined) { b.className = "mv empty"; b.tabIndex = -1; b.textContent = j === null ? "…" : ""; }
      else {
        b.className = "mv" + (j === current ? " cur" : "") + (sans[j].includes("#") ? " mate" : "");
        b.textContent = sans[j];
        if (onClick) b.onclick = () => onClick(j);
        else b.tabIndex = -1;
      }
      li.appendChild(b);
    }
    ol.appendChild(li);
  }
  ol.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
}

// =====================================================================
// PLAY MODE
// =====================================================================
let game = new Chess();
let userColor = prefs.color || "w";
let thinking = false;
let playToken = 0; // bumps when a game is reset so stale engine replies are ignored

$("level").value = prefs.level ?? 8;
$("levelOut").textContent = $("level").value;
$("level").addEventListener("input", () => { $("levelOut").textContent = $("level").value; });
$("level").addEventListener("change", () => { prefs.level = $("level").value; savePrefs(); engine.setLevel(Number($("level").value)); });

for (const b of $("colorSeg").children) {
  b.setAttribute("aria-pressed", String(b.dataset.color === userColor));
  b.addEventListener("click", () => {
    userColor = b.dataset.color; prefs.color = userColor; savePrefs();
    for (const x of $("colorSeg").children) x.setAttribute("aria-pressed", String(x === b));
    newGame();
  });
}

function playLegalMoves(sq) {
  if (thinking || game.isGameOver() || game.turn() !== userColor) return [];
  return game.moves({ square: sq, verbose: true }).map(m => ({ to: m.to, promotion: m.promotion }));
}

async function playUserMove(from, to, promotion) {
  if (mode !== "play") return false;
  let move;
  try { move = game.move({ from, to, promotion }); } catch { return false; }
  hideHint();
  await board.animateMove(move, positionFromChess(game), Math.min(speedMs(), 220));
  afterPlayMove(move);
  if (!game.isGameOver()) engineMove();
  return true;
}

function afterPlayMove(move) {
  board.setLastMove(move?.from, move?.to);
  markCheck(game);
  renderPlay();
}

async function engineMove() {
  const token = playToken;
  thinking = true;
  renderPlay();
  const level = Number($("level").value);
  const movetime = 250 + level * 60;
  const res = await engine.analyse(game.fen(), { movetime });
  if (token !== playToken || mode !== "play") return;
  const uci = res.bestmove;
  let move = null;
  try { move = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch {}
  if (move) await board.animateMove(move, positionFromChess(game), speedMs());
  if (token !== playToken) return;
  thinking = false;
  $("playEval").textContent = res.score ? `Engine's view: ${formatScore(res.score, game.turn() === "w" ? "b" : "w")}` : "";
  afterPlayMove(move);
}

function renderPlay() {
  const hist = game.history();
  const startTurn = new Chess(game.history({ verbose: true })[0]?.before || game.fen()).turn();
  renderMoveList($("playMoves"), hist, startTurn, hist.length - 1);
  let s;
  if (game.isCheckmate()) s = game.turn() === userColor ? "Checkmate. The engine wins." : "Checkmate! You win.";
  else if (game.isStalemate()) s = "Stalemate. It's a draw.";
  else if (game.isDraw()) s = "Draw.";
  else if (thinking) s = "Stockfish is thinking…";
  else s = game.turn() === userColor ? (game.inCheck() ? "You're in check. Your move." : "Your move.") : "Engine to move.";
  $("playStatus").textContent = s;
  $("playStatus").classList.toggle("done", game.isGameOver());
  $("undo").disabled = thinking || game.history().length === 0;
  $("hint").disabled = thinking || game.isGameOver() || game.turn() !== userColor;
  board.interactive = mode === "play" && !thinking && !game.isGameOver() && game.turn() === userColor;
}

async function newGame(fen = START_FEN) {
  playToken++;
  await engine.stop();
  thinking = false;
  game = new Chess(fen);
  hideHint();
  $("playEval").textContent = "";
  board.setOrientation(userColor);
  board.setPosition(positionFromChess(game));
  board.setLastMove(null);
  markCheck(game);
  await engine.newGame();
  await engine.setLevel(Number($("level").value));
  renderPlay();
  if (game.turn() !== userColor && !game.isGameOver()) engineMove();
}

$("newGame").addEventListener("click", () => newGame());
$("undo").addEventListener("click", async () => {
  if (thinking) return;
  playToken++;
  game.undo();
  if (game.turn() !== userColor && game.history().length) game.undo();
  hideHint();
  board.setPosition(positionFromChess(game));
  const last = game.history({ verbose: true }).at(-1);
  afterPlayMove(last);
  if (game.turn() !== userColor) engineMove();
});

let hintSquares = null;
function hideHint() { hintSquares?.forEach(s => board.squares.get(s)?.classList.remove("hinted")); hintSquares = null; }
$("hint").addEventListener("click", async () => {
  $("hint").disabled = true;
  const token = playToken;
  const res = await engine.analyse(game.fen(), { movetime: 800 });
  if (token !== playToken || !res.bestmove) return;
  hideHint();
  hintSquares = [res.bestmove.slice(0, 2), res.bestmove.slice(2, 4)];
  hintSquares.forEach(s => board.squares.get(s)?.classList.add("hinted"));
  $("playEval").textContent = `Hint: move the piece on ${hintSquares[0]} to ${hintSquares[1]}.`;
  renderPlay();
});

// =====================================================================
// PUZZLE MODE
// =====================================================================
let setupPos = {};          // square -> "wk"
let setupTurn = "w";
let tool = "wq";            // selected palette piece, or "x" to erase
let solution = null;        // { fen, moves: [verbose], score, startTurn }
let ply = 0, replaying = false, replayTimer = null, replayGen = 0;

// Palette
const TOOLS = ["wk", "wq", "wr", "wb", "wn", "wp", "bk", "bq", "br", "bb", "bn", "bp", "x"];
for (const t of TOOLS) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tool";
  b.dataset.tool = t;
  b.innerHTML = t === "x" ? `<span class="erase">✕</span>` : svgFor(t[0], t[1]);
  b.setAttribute("aria-label", t === "x" ? "Eraser" : `${t[0] === "w" ? "White" : "Black"} ${NAMES[t[1]]}`);
  b.addEventListener("click", () => { tool = t; renderPalette(); });
  $("palette").appendChild(b);
}
function renderPalette() { for (const b of $("palette").children) b.setAttribute("aria-pressed", String(b.dataset.tool === tool)); }

function editSquare(sq) {
  unsure.delete(sq);
  if (tool === "x" || setupPos[sq] === tool) delete setupPos[sq];
  else {
    if (tool[1] === "k") for (const [s, c] of Object.entries(setupPos)) if (c === tool) delete setupPos[s]; // one king per side
    setupPos[sq] = tool;
  }
  refreshSetup();
}

function castlingFor(pos) {
  let c = "";
  if (pos.e1 === "wk" && pos.h1 === "wr") c += "K";
  if (pos.e1 === "wk" && pos.a1 === "wr") c += "Q";
  if (pos.e8 === "bk" && pos.h8 === "br") c += "k";
  if (pos.e8 === "bk" && pos.a8 === "br") c += "q";
  return c || "-";
}
function fenFromSetup() {
  const rows = [];
  for (let r = 8; r >= 1; r--) {
    let row = "", empty = 0;
    for (const f of "abcdefgh") {
      const code = setupPos[f + r];
      if (!code) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += code[0] === "w" ? code[1].toUpperCase() : code[1];
    }
    rows.push(row + (empty || ""));
  }
  return `${rows.join("/")} ${setupTurn} ${castlingFor(setupPos)} - 0 1`;
}
function loadSetupFen(fen) {
  const c = new Chess(fen, { skipValidation: true });
  setupPos = positionFromChess(c);
  setupTurn = fen.trim().split(/\s+/)[1] === "b" ? "b" : "w";
}

function refreshSetup() {
  board.setPosition(setupPos);
  board.setLastMove(null);
  board.setCheck(null);
  if (document.activeElement !== $("fen")) $("fen").value = fenFromSetup();
  for (const b of $("turnSeg").children) b.setAttribute("aria-pressed", String(b.dataset.turn === setupTurn));
  $("setupError").textContent = "";
  markUnsure();
  prefs.setupFen = fenFromSetup(); savePrefs();
}

for (const b of $("turnSeg").children) b.addEventListener("click", () => { setupTurn = b.dataset.turn; refreshSetup(); });
$("clearBoard").addEventListener("click", () => { setupPos = {}; refreshSetup(); });
$("startPos").addEventListener("click", () => { loadSetupFen(START_FEN); refreshSetup(); });
$("fen").addEventListener("change", () => {
  const v = $("fen").value.trim();
  try { loadSetupFen(v.split(/\s+/).length === 1 ? `${v} w - - 0 1` : v); refreshSetup(); }
  catch { $("setupError").textContent = "That FEN couldn't be read. Check it has 8 ranks separated by slashes."; }
});

// Screenshot: choose, drop or paste. The pieces are read in the browser (src/recognize.js).
let lastRecog = null;     // recognition result, kept so corrections can be learned on Solve
let unsure = new Set();   // squares the recogniser wasn't sure about

async function showShot(file) {
  if (!file || !file.type.startsWith("image/")) return;
  $("drop").classList.add("busy");
  $("dropText").textContent = "Reading the pieces…";
  try {
    const image = await createImageBitmap(file);
    const result = await recognize(image);
    drawShot(image, result?.grid);
    if (!result) {
      lastRecog = null;
      showRecog(`<span class="warn">I couldn't find a chessboard in this image.</span> Try cropping closer around the board, or place the pieces by hand.`);
      return;
    }
    lastRecog = result;
    applyRecognition(result.flipped);
  } catch (err) {
    showRecog(`<span class="warn">That image couldn't be read (${err.message}).</span>`);
  } finally {
    $("drop").classList.remove("busy");
    $("dropText").textContent = "Choose, drop or paste another screenshot to read it.";
  }
}

function applyRecognition(flipped) {
  const r = lastRecog;
  const name = (row, col) => flipped ? "hgfedcba"[col] + (row + 1) : "abcdefgh"[col] + (8 - row);
  setupPos = {};
  unsure = new Set();
  for (const p of r.pieces) {
    p.square = name(p.r, p.c);
    setupPos[p.square] = p.color + p.type;
    if (p.ranked[1].d - p.ranked[0].d < 0.05) unsure.add(p.square);
  }
  // Same fix-ups the recogniser does, re-run in case the sides were swapped.
  for (const p of r.pieces) if (p.type === "p" && /[18]/.test(p.square[1])) {
    p.type = p.ranked.find(x => x.t !== "p" && x.t !== "k").t; setupPos[p.square] = p.color + p.type; unsure.add(p.square);
  }
  r.flippedUsed = flipped;
  setupTurn = r.turn;
  board.setOrientation(flipped ? "b" : "w");
  refreshSetup();
  const n = r.pieces.length;
  const who = setupTurn === "w" ? "White" : "Black";
  let msg = `Read ${n} piece${n === 1 ? "" : "s"}. ${who} to move` + (r.turnReason ? ` because ${r.turnReason}.` : ` (a guess; change it above if needed).`);
  if (unsure.size) msg += ` Squares with an orange outline were hard to read, so check those first.`;
  else msg += ` Check the board against your screenshot, fix anything that's off, then press Solve.`;
  showRecog(msg);
}

function showRecog(html) {
  $("recog").hidden = false;
  $("recogStatus").innerHTML = html;
  $("turnAround").hidden = !lastRecog;
  const k = learnedCount();
  $("forget").hidden = !k;
  $("forget").textContent = `Forget ${k} learned piece${k === 1 ? "" : "s"}`;
}

function drawShot(image, grid) {
  const c = $("shotCanvas"), max = 680;
  const s = Math.min(1, max / Math.max(image.width, image.height));
  c.width = Math.round(image.width * s); c.height = Math.round(image.height * s);
  const ctx = c.getContext("2d");
  ctx.drawImage(image, 0, 0, c.width, c.height);
  if (grid) {
    ctx.strokeStyle = "rgba(255, 138, 0, .95)"; ctx.lineWidth = 2;
    for (let k = 0; k <= 8; k++) {
      ctx.beginPath(); ctx.moveTo((grid.x + k * grid.sx) * s, grid.y * s); ctx.lineTo((grid.x + k * grid.sx) * s, (grid.y + 8 * grid.sy) * s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(grid.x * s, (grid.y + k * grid.sy) * s); ctx.lineTo((grid.x + 8 * grid.sx) * s, (grid.y + k * grid.sy) * s); ctx.stroke();
    }
  }
  c.hidden = false;
}

function markUnsure() {
  board.squares.forEach((el, sq) => el.classList.toggle("unsure", board.editMode && unsure.has(sq)));
}

$("turnAround").addEventListener("click", () => { if (lastRecog) applyRecognition(!lastRecog.flippedUsed); });
$("forget").addEventListener("click", () => { forgetLearned(); showRecog($("recogStatus").innerHTML); });

// When a recognised position is confirmed with Solve, remember the pieces that were
// corrected or uncertain, so screenshots in the same style read better next time.
function learnFromSetup() {
  if (!lastRecog) return;
  const samples = [];
  for (const p of lastRecog.pieces) {
    const final = setupPos[p.square];
    if (!final) continue;
    if (final[1] !== p.type || unsure.has(p.square)) samples.push({ t: final[1], ...p.norm });
  }
  if (samples.length) learn(samples);
  lastRecog = null;
  unsure.clear();
}
$("shot").addEventListener("change", e => showShot(e.target.files[0]));
$("drop").addEventListener("dragover", e => { e.preventDefault(); $("drop").classList.add("over"); });
$("drop").addEventListener("dragleave", () => $("drop").classList.remove("over"));
$("drop").addEventListener("drop", e => { e.preventDefault(); $("drop").classList.remove("over"); showShot(e.dataTransfer.files[0]); });
document.addEventListener("paste", e => {
  if (mode !== "puzzle") return;
  const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith("image/"));
  if (f) showShot(f);
});

function validateSetup(fen) {
  const pieces = Object.values(setupPos);
  if (pieces.filter(p => p === "wk").length !== 1 || pieces.filter(p => p === "bk").length !== 1)
    return "Each side needs exactly one king.";
  if (Object.entries(setupPos).some(([sq, p]) => p[1] === "p" && (sq[1] === "1" || sq[1] === "8")))
    return "Pawns can't stand on the first or last rank.";
  let c;
  try { c = new Chess(fen); } catch (err) { return "That isn't a legal position: " + err.message; }
  const other = setupTurn === "w" ? "b" : "w";
  const k = Object.entries(setupPos).find(([, p]) => p === other + "k")[0];
  if (c.isAttacked(k, setupTurn)) return `The ${other === "w" ? "White" : "Black"} king is in check, but it's ${setupTurn === "w" ? "White" : "Black"}'s turn. Switch who moves first.`;
  if (c.isGameOver()) return c.isCheckmate() ? "This position is already checkmate." : "There are no legal moves in this position.";
  return null;
}

// Ask Stockfish for the best line. If it sees a mate but the line it reports
// stops short, keep searching from the end of the line until the mate appears.
async function solve() {
  const fen = fenFromSetup();
  const err = validateSetup(fen);
  if (err) { $("setupError").textContent = err; return; }
  $("setupError").textContent = "";
  learnFromSetup();
  const movetime = Number($("thinkTime").value);
  $("solve").disabled = true;
  $("solve").textContent = "Thinking…";
  board.editMode = false;
  markUnsure();
  const c = new Chess(fen);
  const moves = [];
  let firstScore = null;
  try {
    for (let round = 0; round < 6; round++) {
      const res = await engine.analyse(c.fen(), { movetime: round === 0 ? movetime : Math.max(1000, movetime / 2) }, info => {
        if (round === 0) $("solve").textContent = `Depth ${info.depth} · ${formatScore(info.score, c.turn())}`;
      });
      if (round === 0) firstScore = { ...res.score, turn: c.turn() };
      const limit = res.score?.type === "mate" ? res.pv.length : Math.min(res.pv.length, 12);
      for (const uci of res.pv.slice(0, limit)) {
        try { moves.push(c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })); } catch { break; }
      }
      if (c.isGameOver() || res.score?.type !== "mate" || !res.pv.length) break;
    }
  } finally {
    $("solve").disabled = false;
    $("solve").textContent = "Solve";
  }
  solution = { fen, moves, score: firstScore, startTurn: setupTurn, endsInMate: c.isCheckmate() };
  showSolution();
}
$("solve").addEventListener("click", solve);

function showSolution() {
  $("setup").hidden = true;
  $("solution").hidden = false;
  $("replay").hidden = false;
  const s = solution.score;
  const side = solution.startTurn === "w" ? "White" : "Black";
  let headline;
  if (solution.endsInMate) {
    const n = Math.ceil(solution.moves.length / 2);
    headline = `${side} mates in ${n}`;
  } else if (s?.type === "mate") headline = formatScore(s, s.turn);
  else headline = `Best line · ${formatScore(s, s?.turn)}`;
  $("solveStatus").textContent = headline;
  $("solveStatus").classList.toggle("done", solution.endsInMate);
  replayJump(0);
  replayPlay();
}

function positionAtPly(n) {
  const c = new Chess(solution.fen);
  for (let i = 0; i < n; i++) c.move(solution.moves[i].san);
  return c;
}
function renderReplay() {
  const sans = solution.moves.map(m => m.san);
  renderMoveList($("solveMoves"), sans, solution.startTurn, ply - 1, j => replayJump(j + 1));
  const m = solution.moves[ply - 1];
  let note;
  if (!m) note = `Start position. ${solution.startTurn === "w" ? "White" : "Black"} to move.`;
  else {
    const who = m.color === "w" ? "White" : "Black";
    const num = Math.floor((ply - 1 + (solution.startTurn === "b" ? 1 : 0)) / 2) + 1;
    note = `${num}${m.color === "w" ? "." : "…"} ${m.san}: ${who} ${describe(m)}.`;
    if (ply === solution.moves.length) note += solution.endsInMate ? " Checkmate." : " That's as far as the engine's best line goes.";
  }
  $("solveNote").textContent = note;
  $("rPrev").disabled = ply === 0;
  $("rNext").disabled = ply >= solution.moves.length;
  $("rPlay").textContent = replaying ? "❚❚ Pause" : ply >= solution.moves.length ? "↻ Replay" : "▶ Play";
}
function describe(m) {
  const piece = NAMES[m.piece];
  let s = m.flags.includes("k") || m.flags.includes("q") ? `castles ${m.flags.includes("k") ? "kingside" : "queenside"}`
    : `moves the ${piece} from ${m.from} to ${m.to}`;
  if (m.captured) s += `, capturing the ${NAMES[m.captured]}`;
  if (m.promotion) s += ` and promotes to a ${NAMES[m.promotion]}`;
  if (m.san.includes("#")) s += " with checkmate";
  else if (m.san.includes("+")) s += " with check";
  return s;
}

function replayStop() { replaying = false; clearTimeout(replayTimer); if (solution) renderReplay(); }
function replayJump(n) {
  replayGen++;
  replayStop();
  ply = n;
  const c = positionAtPly(n);
  board.setPosition(positionFromChess(c));
  const m = solution.moves[n - 1];
  board.setLastMove(m?.from, m?.to);
  markCheck(c);
  renderReplay();
}
let stepping = false;
async function replayStep() {
  if (stepping || ply >= solution.moves.length) return false;
  stepping = true;
  const gen = replayGen;
  const m = solution.moves[ply];
  const after = positionAtPly(ply + 1);
  board.setLastMove(null); board.setCheck(null);
  await board.animateMove(m, positionFromChess(after), speedMs());
  stepping = false;
  if (gen !== replayGen) return false;
  ply++;
  board.setLastMove(m.from, m.to);
  markCheck(after);
  renderReplay();
  return true;
}
async function replayLoop() {
  if (!replaying) return;
  const ok = await replayStep();
  if (!ok || ply >= solution.moves.length) { replaying = false; renderReplay(); return; }
  replayTimer = setTimeout(replayLoop, pauseMs());
}
function replayPlay() {
  if (replaying) { replayStop(); return; }
  if (ply >= solution.moves.length) replayJump(0);
  replaying = true;
  renderReplay();
  replayTimer = setTimeout(replayLoop, 600);
}
$("rPlay").addEventListener("click", replayPlay);
$("rNext").addEventListener("click", () => { replayStop(); replayStep(); });
$("rPrev").addEventListener("click", () => { if (ply > 0 && !stepping) replayJump(ply - 1); });
$("rReset").addEventListener("click", () => replayJump(0));

$("editPos").addEventListener("click", () => enterSetup());
$("playFromHere").addEventListener("click", () => {
  const fen = positionAtPly(ply).fen();
  userColor = new Chess(fen).turn();
  for (const x of $("colorSeg").children) x.setAttribute("aria-pressed", String(x.dataset.color === userColor));
  setMode("play", fen);
});

function enterSetup() {
  replayGen++;
  replayStop();
  solution = null;
  $("setup").hidden = false;
  $("solution").hidden = true;
  $("replay").hidden = true;
  board.interactive = false;
  board.editMode = true;
  refreshSetup();
}

// =====================================================================
// MODE SWITCHING + KEYS
// =====================================================================
function setMode(m, fen) {
  mode = m;
  for (const t of document.querySelectorAll(".mode")) t.setAttribute("aria-selected", String(t.dataset.mode === m));
  $("panel-play").hidden = m !== "play";
  $("panel-puzzle").hidden = m !== "puzzle";
  if (m === "play") {
    replayGen++; replayStop();
    $("replay").hidden = true;
    board.editMode = false;
    newGame(fen);
  } else {
    playToken++;
    engine.stop();
    thinking = false;
    board.interactive = false;
    if (solution) { board.editMode = false; showSolution(); } else enterSetup();
  }
  prefs.mode = m; savePrefs();
}
for (const t of document.querySelectorAll(".mode")) t.addEventListener("click", () => { if (t.dataset.mode !== mode) setMode(t.dataset.mode); });

document.addEventListener("keydown", e => {
  if (mode !== "puzzle" || !solution || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === "ArrowRight") { replayStop(); replayStep(); }
  else if (e.key === "ArrowLeft" && ply > 0 && !stepping) replayJump(ply - 1);
  else if (e.key === " ") { e.preventDefault(); replayPlay(); }
});

// ---------- start ----------
renderPalette();
try { loadSetupFen(prefs.setupFen || "7k/5r1p/1pq2Pbp/2p5/8/1P5Q/1BP3P1/R5K1 w - - 0 1"); }
catch { loadSetupFen(START_FEN); }
setMode(prefs.mode === "puzzle" ? "puzzle" : "play");
