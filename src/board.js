// The chessboard: draws squares and pieces, glides pieces between squares,
// and turns clicks / drags into move requests. Knows nothing about chess rules;
// the app supplies legal moves through callbacks.
import { svgFor, NAMES } from "./pieces.js";

const FILES = "abcdefgh";

export class Board {
  /**
   * @param {HTMLElement} el container (gets the .board class)
   * @param {object} hooks
   *   legalMoves(square) -> [{ to, promotion? }]   moves the user may make from a square
   *   onMove(from, to, promotion) -> boolean        user made a move; return false to reject
   *   onSquareClick(square)                         used in edit mode instead of moves
   */
  constructor(el, hooks = {}) {
    this.el = el;
    this.hooks = hooks;
    this.orientation = "w";
    this.pieces = new Map();   // square -> element
    this.squares = new Map();  // square -> element
    this.selected = null;
    this.interactive = false;
    this.editMode = false;
    this.el.classList.add("board");
    this.overlay = document.createElement("div");
    this.overlay.className = "promo-overlay";
    this.overlay.hidden = true;
    this.#buildSquares();
    this.el.appendChild(this.overlay);
    this.#bindPointer();
  }

  // ---------- geometry ----------
  xy(sq) {
    const f = FILES.indexOf(sq[0]), r = Number(sq[1]);
    return this.orientation === "w" ? { x: f, y: 8 - r } : { x: 7 - f, y: r - 1 };
  }
  squareAt(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    const x = Math.floor(((clientX - rect.left) / rect.width) * 8);
    const y = Math.floor(((clientY - rect.top) / rect.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return this.orientation === "w" ? FILES[x] + (8 - y) : FILES[7 - x] + (y + 1);
  }
  #placeEl(el, sq) {
    const { x, y } = this.xy(sq);
    el.style.left = x * 12.5 + "%";
    el.style.top = y * 12.5 + "%";
  }

  #buildSquares() {
    this.squares.forEach(s => s.remove());
    this.squares.clear();
    for (let r = 1; r <= 8; r++) for (let f = 0; f < 8; f++) {
      const sq = FILES[f] + r, el = document.createElement("div");
      el.className = "sq " + ((f + r) % 2 ? "light" : "dark");
      el.dataset.square = sq;
      this.#placeEl(el, sq);
      const { x, y } = this.xy(sq);
      if (x === 7) el.insertAdjacentHTML("beforeend", `<span class="coord rank">${r}</span>`);
      if (y === 7) el.insertAdjacentHTML("beforeend", `<span class="coord file">${FILES[f]}</span>`);
      this.el.insertBefore(el, this.el.firstChild);
      this.squares.set(sq, el);
    }
  }

  setOrientation(color) {
    if (color === this.orientation) return;
    this.orientation = color;
    this.#buildSquares();
    this.pieces.forEach((el, sq) => { el.classList.add("instant"); this.#placeEl(el, sq); });
    requestAnimationFrame(() => this.pieces.forEach(el => el.classList.remove("instant")));
    this.#restoreMarks();
  }

  // ---------- pieces ----------
  #makePiece(code, sq) {
    const el = document.createElement("div");
    el.className = "piece instant";
    el.dataset.code = code;
    el.innerHTML = svgFor(code[0], code[1]);
    el.setAttribute("aria-label", `${code[0] === "w" ? "White" : "Black"} ${NAMES[code[1]]} on ${sq}`);
    this.#placeEl(el, sq);
    this.el.appendChild(el);
    requestAnimationFrame(() => el.classList.remove("instant"));
    return el;
  }

  /** Make the board show exactly this position, with no animation. pos: { e4: "wp", ... } */
  setPosition(pos) {
    for (const [sq, el] of this.pieces) {
      if (pos[sq] !== el.dataset.code) { el.remove(); this.pieces.delete(sq); }
    }
    for (const [sq, code] of Object.entries(pos)) {
      if (!this.pieces.has(sq)) this.pieces.set(sq, this.#makePiece(code, sq));
    }
    this.clearSelection();
  }

  /**
   * Glide a move. move is a chess.js verbose move ({ from, to, flags, promotion, color, piece }).
   * finalPos is the position after the move; the board is synced to it at the end.
   */
  animateMove(move, finalPos, duration) {
    return new Promise(resolve => {
      this.clearSelection();
      this.el.style.setProperty("--move-ms", `${duration}ms`);
      const mover = this.pieces.get(move.from);
      if (!mover) { this.setPosition(finalPos); resolve(); return; }
      const victimSq = move.flags.includes("e") ? move.to[0] + move.from[1] : move.to;
      const victim = this.pieces.get(victimSq);
      this.pieces.delete(move.from);
      mover.classList.remove("instant");
      mover.classList.add("moving");
      this.#placeEl(mover, move.to);
      // Castling: the rook glides too.
      let rook = null;
      if (move.flags.includes("k") || move.flags.includes("q")) {
        const rank = move.from[1];
        const [rf, rt] = move.flags.includes("k") ? ["h" + rank, "f" + rank] : ["a" + rank, "d" + rank];
        rook = this.pieces.get(rf);
        if (rook) { this.pieces.delete(rf); this.#placeEl(rook, rt); this.pieces.set(rt, rook); }
      }
      if (victim && victim !== mover) {
        this.pieces.delete(victimSq);
        setTimeout(() => victim.classList.add("captured"), duration * 0.7);
      }
      setTimeout(() => {
        if (victim && victim !== mover) victim.remove();
        mover.classList.remove("moving");
        this.pieces.set(move.to, mover);
        if (move.promotion) {
          const code = move.color + move.promotion;
          mover.dataset.code = code;
          mover.innerHTML = svgFor(code[0], code[1]);
        }
        this.setPosition(finalPos);
        resolve();
      }, duration + 30);
    });
  }

  // ---------- marks ----------
  setLastMove(from, to) { this.lastMove = from ? [from, to] : null; this.#restoreMarks(); }
  setCheck(square) { this.check = square || null; this.#restoreMarks(); }
  #restoreMarks() {
    this.squares.forEach(s => s.classList.remove("last", "check", "selected", "target", "capture-target"));
    if (this.lastMove) this.lastMove.forEach(sq => this.squares.get(sq)?.classList.add("last"));
    if (this.check) this.squares.get(this.check)?.classList.add("check");
    if (this.selected) {
      this.squares.get(this.selected)?.classList.add("selected");
      for (const m of this.targets || []) {
        this.squares.get(m.to)?.classList.add(this.pieces.has(m.to) ? "capture-target" : "target");
      }
    }
  }
  select(sq) {
    this.selected = sq;
    this.targets = sq ? this.hooks.legalMoves?.(sq) || [] : [];
    this.#restoreMarks();
  }
  clearSelection() { this.select(null); }

  // ---------- user input ----------
  async #tryMove(from, to) {
    const options = (this.hooks.legalMoves?.(from) || []).filter(m => m.to === to);
    if (!options.length) return false;
    let promotion;
    if (options.some(m => m.promotion)) {
      promotion = await this.#askPromotion(this.pieces.get(from)?.dataset.code[0] || "w", to);
      if (!promotion) return false;
    }
    this.clearSelection();
    return this.hooks.onMove?.(from, to, promotion) ?? false;
  }

  #askPromotion(color, to) {
    return new Promise(resolve => {
      this.overlay.innerHTML = "";
      const box = document.createElement("div");
      box.className = "promo-box";
      const { x } = this.xy(to);
      box.style.left = Math.min(x, 4) * 12.5 + "%";
      for (const p of ["q", "r", "b", "n"]) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "promo-choice";
        b.innerHTML = svgFor(color, p);
        b.setAttribute("aria-label", `Promote to ${NAMES[p]}`);
        b.onclick = e => { e.stopPropagation(); finish(p); };
        box.appendChild(b);
      }
      const finish = p => { this.overlay.hidden = true; this.overlay.onclick = null; resolve(p); };
      this.overlay.onclick = () => finish(null);
      this.overlay.appendChild(box);
      this.overlay.hidden = false;
    });
  }

  #bindPointer() {
    let drag = null;
    this.el.addEventListener("pointerdown", e => {
      if (e.button !== 0 || !this.overlay.hidden) return;
      const sq = this.squareAt(e.clientX, e.clientY);
      if (!sq) return;
      if (this.editMode) { this.hooks.onSquareClick?.(sq); return; }
      if (!this.interactive) return;
      // Clicking a highlighted target finishes a click-to-move.
      if (this.selected && this.targets.some(m => m.to === sq)) {
        const from = this.selected;
        this.#tryMove(from, sq);
        return;
      }
      const moves = this.hooks.legalMoves?.(sq) || [];
      if (!moves.length) { this.clearSelection(); return; }
      this.select(sq);
      const el = this.pieces.get(sq);
      const rect = this.el.getBoundingClientRect();
      drag = { from: sq, el, startX: e.clientX, startY: e.clientY, size: rect.width / 8, rect, active: false };
      this.el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.el.addEventListener("pointermove", e => {
      if (!drag) return;
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (!drag.active && Math.hypot(dx, dy) < 4) return;
      drag.active = true;
      drag.el.classList.add("dragging");
      drag.el.style.transform = `translate(${dx}px, ${dy}px) scale(1.08)`;
    });
    const end = async e => {
      if (!drag) return;
      const d = drag; drag = null;
      if (!d.active) return; // plain click: selection stays, targets are shown
      const to = this.squareAt(e.clientX, e.clientY);
      // Drop in place: snap the piece to the target without a glide.
      d.el.classList.add("instant");
      d.el.style.transform = "";
      d.el.classList.remove("dragging");
      if (to && to !== d.from) {
        this.#placeEl(d.el, to);
        const ok = await this.#tryMove(d.from, to);
        if (!ok) this.#placeEl(d.el, d.from);
      }
      requestAnimationFrame(() => d.el.classList.remove("instant"));
    };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);
  }
}

/** chess.js board() -> { square: "wp" } map */
export function positionFromChess(chess) {
  const pos = {};
  for (const row of chess.board()) for (const p of row) if (p) pos[p.square] = p.color + p.type;
  return pos;
}
