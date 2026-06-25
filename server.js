// Sxratch — zero-dependency static dev server.
// AudioWorklet modules and decodeAudioData require files to be served over HTTP
// (file:// won't work), so we ship a tiny static server with correct MIME types.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { gzipSync, brotliCompressSync, constants as zlib } from "node:zlib";

// Text assets compress well; audio/images are already compressed — skip them.
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|manifest\+json)|image\/svg)/;

const __dirname = dirname(fileURLToPath(import.meta.url));
// `--dist` serves the optimized production build (see build.js); default = source.
const SERVE_DIST = process.argv.includes("--dist");
const ROOT = SERVE_DIST ? join(__dirname, "dist") : __dirname;
const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".map": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";

    // Resolve against ROOT and guard against path traversal.
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    let target = filePath;
    try {
      const info = await stat(target);
      if (info.isDirectory()) target = join(target, "index.html");
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }

    const data = await readFile(target);
    const type = MIME[extname(target).toLowerCase()] || "application/octet-stream";
    const headers = {
      "Content-Type": type,
      "Cache-Control": "no-cache",
      "Vary": "Accept-Encoding",
      // Cross-origin isolation enables SharedArrayBuffer (low-latency scratch
      // control). "credentialless" keeps the cross-origin GM-sample CDN working
      // without requiring CORP headers from it.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    };

    // Compress text assets on the fly (brotli preferred, gzip fallback).
    let body = data;
    const accept = req.headers["accept-encoding"] || "";
    if (COMPRESSIBLE.test(type) && data.length > 512) {
      if (/\bbr\b/.test(accept)) {
        body = brotliCompressSync(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } });
        headers["Content-Encoding"] = "br";
      } else if (/\bgzip\b/.test(accept)) {
        body = gzipSync(data);
        headers["Content-Encoding"] = "gzip";
      }
    }

    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end("Server error");
    console.error(err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Sxratch running${SERVE_DIST ? " (dist build)" : ""}:\n`);
  console.log(`    Local:   http://localhost:${PORT}`);
  console.log(`    Network: http://<your-ip>:${PORT}   (open on your phone, same Wi-Fi)\n`);
});
