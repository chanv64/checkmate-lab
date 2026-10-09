// Copies the lite single-threaded Stockfish build (≈1.8 MB) from node_modules into public/engine,
// so Vite serves it as a static file the browser can load into a Web Worker.
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "stockfish", "bin");
const dest = join(root, "public", "engine");
const files = ["stockfish-19-lite-single.js", "stockfish-19-lite-single.wasm"];

mkdirSync(dest, { recursive: true });
for (const f of files) {
  const from = join(src, f), to = join(dest, f);
  if (!existsSync(from)) throw new Error(`Missing ${from}. Run npm install first.`);
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  console.log(`engine: copied ${f}`);
}
