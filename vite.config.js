import { defineConfig } from "vite";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Dev-only endpoint used by test/train.html to save trained piece outlines.
const saveTrained = {
  name: "save-trained-templates",
  configureServer(server) {
    server.middlewares.use("/__save-trained", (req, res) => {
      if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (!Array.isArray(data) || !data.every(t => "kqrbnp".includes(t.t) && typeof t.g === "string")) throw new Error("not a template list");
          writeFileSync(fileURLToPath(new URL("./src/trained-templates.json", import.meta.url)), JSON.stringify(data) + "\n");
          res.end(`saved ${data.length}`);
        } catch (err) { res.statusCode = 400; res.end(String(err.message)); }
      });
    });
  },
};

// Relative asset paths, so the built site works from any folder
// (e.g. https://<user>.github.io/checkmate-lab/).
export default defineConfig({
  base: "./",
  plugins: [saveTrained],
});
