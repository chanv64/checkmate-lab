# Checkmate Lab

Play chess against Stockfish in your browser, or set up a puzzle and watch the engine solve it with the pieces moving on the board.

**Live:** https://chanv64.github.io/checkmate-lab/ (redeployed by GitHub Actions on every push to `main`).

- **Engine:** Stockfish 19 (lite, single-threaded WebAssembly build from the `stockfish` npm package, ≈1.8 MB), running in a Web Worker.
- **Rules:** `chess.js`.
- **Board:** custom, in `src/board.js`. Pieces glide between squares; drag-and-drop or click-to-move.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ — upload anywhere
```

`npm run dev` and `npm run build` first copy the engine files from `node_modules/stockfish/bin` into `public/engine/` (see `scripts/copy-engine.mjs`).

## Using it

**Play** — choose White or Black and an engine level (0–20; 20 is full strength), then drag or click pieces. *Take back* undoes your last move, *Hint* highlights the engine's suggestion.

**Puzzle**
1. **Drop, paste or choose a screenshot** of the puzzle. The app finds the board, reads every piece, turns the board if the screenshot is shown from Black's side, and guesses who is to move (a king in a red "check" glow moves next; otherwise the side that did *not* make the highlighted last move). Squares it wasn't sure about get an orange dashed outline. Nothing is uploaded: recognition runs in your browser.
2. Fix anything that's wrong: pick a piece from the palette and click squares to place it (click again to remove), or paste a FEN. *Turn position around* swaps the sides if White and Black ended up reversed.
3. Check who moves first.
4. Press **Solve**. If the position came from a screenshot, the pieces you corrected (and the ones marked unsure) are remembered, so screenshots in the same style read better next time. *Forget learned pieces* clears that memory. Stockfish searches for the chosen think time, then the solution plays out on the board. Use ⏮ ◀ ▶ or the arrow keys / space bar, or click any move in the list.
5. *Play from here* switches to Play mode at the current replay position.

**Move speed** (top bar) controls how fast pieces glide, in both modes. *Flip* turns the board around (useful for puzzles shown from Black's side).

## Files

| File | What it does |
|---|---|
| `src/engine.js` | Starts Stockfish in a Worker and talks UCI (`analyse`, `setLevel`, `stop`) |
| `src/board.js` | Board drawing, piece animation, drag/click input, promotion picker |
| `src/main.js` | Play mode, puzzle editor, solver and replay |
| `src/recognize.js` | Screenshot → position: grid detection, piece outlines, colour, type, orientation, side to move, learning |
| `src/trained-templates.json` | Built-in reference outlines learned from labelled screenshots (covers e.g. Chess.com's default pieces) |
| `test/train.html` | Rebuilds `src/trained-templates.json` from the screenshots in `test/fixtures/` (press **Save**; dev server only) |
| `src/pieces.js` | SVG piece artwork |
| `test/recognize.html` | Recognition test page (open `/test/recognize.html` while `npm run dev` runs). It reads the screenshots listed in `test/fixtures/expected.json`; the images themselves aren't committed, so drop your own into `test/fixtures/`. |
| `src/style.css` | Styles, light/dark, blue and wood board themes |

## Notes

- **Teaching it a new piece style:** put the screenshot in `test/fixtures/`, add its correct FEN and side to move to `test/fixtures/expected.json`, open `/test/train.html` and press **Save**, then check `/test/recognize.html`. Each screenshot contributes up to 3 outlines per piece type; screenshots themselves stay out of git.
- Recognition works best on flat 2D boards (Lichess, Chess.com and similar). It copes with arrows, highlighted squares, coordinate labels and flipped boards; unusual 3D piece styles may need a correction or two, which it then learns. Crop the screenshot around the board if it's a full-screen capture with lots of other UI.
- To use the stronger (but ≈100 MB) full engine, change the file names in `scripts/copy-engine.mjs` and `src/engine.js` to `stockfish-19-single.*`.
- Stockfish is GPL-3.0, so this app is GPL-3.0 too: if you publish it, publish its source as well.
