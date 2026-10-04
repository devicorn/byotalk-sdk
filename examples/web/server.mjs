// Example customer backend: serves the web app and a token route. The secret key never leaves this server.
// Run: node --env-file=.env server.mjs   (see README.md)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatServer } from "../../dist/server.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const { BYOTALK_SECRET_KEY, BYOTALK_ENV } = process.env;
const API_URL = process.env.BYOTALK_API_URL ?? "http://localhost:3000";
const RT_URL = process.env.BYOTALK_RT_URL ?? "ws://localhost:3001";
const PORT = Number(process.env.PORT ?? 5173);

if (!BYOTALK_SECRET_KEY || !BYOTALK_ENV) {
  console.error("Set BYOTALK_SECRET_KEY and BYOTALK_ENV in examples/web/.env (copy .env.example)");
  process.exit(1);
}

const chatServer = new ChatServer({ secretKey: BYOTALK_SECRET_KEY, baseUrl: API_URL });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

async function serveFile(res, root, rel) {
  const path = normalize(join(root, rel));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // DEMO ONLY: "logs in" whoever asks. In your app, use your own session and only mint a token for that user.
  if (url.pathname === "/api/token") {
    const userId = url.searchParams.get("userId") ?? "";
    const name = url.searchParams.get("name") || userId;
    if (!/^[A-Za-z0-9_\-@.:]{1,128}$/.test(userId)) return res.writeHead(400).end("bad userId");
    try {
      await chatServer.users.upsert({ id: userId, name });
      const token = chatServer.createToken(userId, { expiresIn: "1h" });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token, env: BYOTALK_ENV, apiUrl: API_URL, rtUrl: RT_URL }));
    } catch (err) {
      console.error("token route failed:", err.code ?? err.message, err.requestId ?? "");
      return res.writeHead(502).end("ByoTalk API error");
    }
  }

  if (url.pathname.startsWith("/sdk/")) return serveFile(res, join(here, "../../dist"), url.pathname.slice(5));
  return serveFile(res, join(here, "public"), url.pathname === "/" ? "index.html" : url.pathname.slice(1));
}).listen(PORT, () => console.log(`Example chat app: http://localhost:${PORT}`));
