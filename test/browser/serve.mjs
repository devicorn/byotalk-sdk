// Serves the call-test harness (SDK + mediasoup-client bundled with esbuild) on :5180.
import { createServer } from "node:http";
import { build } from "esbuild";

const out = await build({ entryPoints: [new URL("./harness.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false, platform: "browser", target: "es2022" });
const js = out.outputFiles[0].text;
const html = `<!doctype html><meta charset="utf-8"><title>calls harness</title><script type="module" src="/harness.js"></script>`;
createServer((req, res) => {
  if (req.url === "/harness.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(js);
  res.writeHead(200, { "content-type": "text/html" }).end(html);
}).listen(5180, "127.0.0.1", () => console.log("harness on http://127.0.0.1:5180"));
