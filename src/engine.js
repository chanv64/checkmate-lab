// Thin wrapper around Stockfish running in a Web Worker, speaking UCI.
// One search runs at a time; starting a new one stops the old one first.

const ENGINE_URL = `${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`;

export class Engine {
  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.listeners = new Set();
    this.worker.onmessage = e => {
      const line = typeof e.data === "string" ? e.data : String(e.data);
      for (const fn of [...this.listeners]) fn(line);
    };
    this.queue = Promise.resolve();
    this.current = null;
    this.ready = this.#init();
  }

  #send(cmd) { this.worker.postMessage(cmd); }

  #waitFor(prefix) {
    return new Promise(resolve => {
      const fn = line => { if (line.startsWith(prefix)) { this.listeners.delete(fn); resolve(line); } };
      this.listeners.add(fn);
    });
  }

  async #init() {
    const ok = this.#waitFor("uciok");
    this.#send("uci");
    await ok;
    await this.isReady();
  }

  async isReady() {
    const ok = this.#waitFor("readyok");
    this.#send("isready");
    await ok;
  }

  /** Strength: level 0–20 (Stockfish "Skill Level"); 20 is full strength. */
  async setLevel(level) {
    await this.ready;
    this.#send(`setoption name Skill Level value ${level}`);
    await this.isReady();
  }

  async newGame() {
    await this.ready;
    this.#send("ucinewgame");
    await this.isReady();
  }

  /** Stop whatever search is running. Resolves once the engine has answered with bestmove. */
  async stop() {
    if (this.current) { this.#send("stop"); await this.current; }
  }

  /**
   * Search a position. Options: { movetime } in ms or { depth }.
   * onInfo receives live progress { depth, score, pv } while it thinks.
   * Resolves to { bestmove, pv: [uci...], score: { type: "cp"|"mate", value }, depth }.
   * Scores are from the side to move's point of view.
   */
  analyse(fen, { movetime, depth } = {}, onInfo) {
    const run = async () => {
      await this.ready;
      let last = { depth: 0, score: null, pv: [] };
      const infoFn = line => {
        if (!line.startsWith("info") || !line.includes(" pv ")) return;
        if (/ multipv (\d+)/.test(line) && !/ multipv 1 /.test(line)) return;
        const d = Number(line.match(/ depth (\d+)/)?.[1] ?? 0);
        const sc = line.match(/ score (cp|mate) (-?\d+)/);
        const pv = line.split(" pv ")[1].trim().split(/\s+/);
        if (!sc) return;
        // Ignore bound-only lines, they are less reliable than exact ones.
        if (/ (lowerbound|upperbound)/.test(line) && last.pv.length) return;
        last = { depth: d, score: { type: sc[1], value: Number(sc[2]) }, pv };
        onInfo?.(last);
      };
      this.listeners.add(infoFn);
      const done = this.#waitFor("bestmove");
      this.#send(`position fen ${fen}`);
      this.#send(depth ? `go depth ${depth}` : `go movetime ${movetime ?? 1000}`);
      const line = await done;
      this.listeners.delete(infoFn);
      const bestmove = line.split(/\s+/)[1];
      if (!last.pv.length || last.pv[0] !== bestmove) last = { ...last, pv: bestmove && bestmove !== "(none)" ? [bestmove] : [] };
      return { bestmove, ...last };
    };
    // Chain behind any search already queued; stop a running one so we don't wait for it.
    const prev = this.current;
    if (prev) this.#send("stop");
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    this.current = p;
    p.finally(() => { if (this.current === p) this.current = null; });
    return p;
  }
}
