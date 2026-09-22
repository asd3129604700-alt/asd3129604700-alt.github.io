/**
 * 本地静态服务（只在本机用，不参与发布）
 *
 * 为什么不能随便找个静态服务器：这个网页依赖
 *   Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy
 * 才会开启"跨源隔离"，onnxruntime-web 的多线程 WASM（SharedArrayBuffer）
 * 才能用；缺了这两个头会退化成单线程甚至直接失败。
 * 这两个头写在 dist/_headers 里（那是给 Cloudflare Pages 用的），
 * 本地服务得自己发。CSP 也照抄，否则和线上行为不一致、排查会跑偏。
 *
 * 用法：
 *   node serve-local.js            # 默认 8774
 *   node serve-local.js 9000
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "apps", "web", "dist");
// 模型文件不在 dist 里（构建时的 release-boundaries 检查会把它们排除，
// 线上是走私有网关的）。本地直接从 public/models 兜底，不复制那 196MB。
const MODEL_DIR = path.resolve(__dirname, "public", "models");
const PORT = Number(process.argv[2] || process.env.PORT || 8774);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".ort": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// 与 dist/_headers 保持一致
const HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), geolocation=(), microphone=(), payment=(), usb=()",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
    "form-action 'none'; manifest-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; " +
    // connect-src 里的 blob: 和 data: 都是本地必须的：
    //  · blob: —— 模型是从 OPFS 读出来以 blob: URL 交给 onnxruntime 的
    //    （线上走私有网关，模型地址是 https，不需要 blob:）；
    //  · data: —— 处理流水线会把画布结果当 data: URL 再 fetch 回来。
    // 少了任何一个都会在控制台看到
    // "violates the following Content Security Policy directive: connect-src ..."，
    // 表现为模型能力测试一直失败、或者批次跑起来立刻"本地图片处理失败"。
    "connect-src 'self' blob: data: https: http://localhost:* http://127.0.0.1:*; worker-src 'self' blob:",
};

const server = http.createServer(function (req, res) {
  let rel;
  try {
    rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
  } catch (e) {
    rel = "/";
  }
  if (rel === "/") rel = "/index.html";

  // 本地假的 OpenAI 兼容 /models 端点：只为验证界面上「拉取模型列表」这个按钮，
  // 真实使用时它请求的是各家提供商的地址。也顺手接一个 /chat/completions，
  // 免得只想试试排版时因为没配 Key 而卡住。（只在本地服务里，不进应用代码）
  if (rel === "/v1/models") {
    res.writeHead(200, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, HEADERS));
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "local-fake-model-small", object: "model" },
        { id: "local-fake-model-large", object: "model" },
        { id: "local-fake-model-vision", object: "model" },
      ],
    }));
    return;
  }

  let file = path.join(ROOT, path.normalize(rel).replace(/^[/\\]+/, ""));
  if (file.indexOf(ROOT) !== 0) {
    res.writeHead(403, HEADERS);
    return res.end("403");
  }
  // 目录 → index.html
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  } catch (e) {
    /* 交给下面的 readFile 报 404 */
  }
  // dist 里没有的模型文件，从 public/models 兜底
  if (!fs.existsSync(file) && rel.indexOf("/models/") === 0) {
    file = path.join(MODEL_DIR, path.normalize(rel.slice("/models/".length)));
    if (file.indexOf(MODEL_DIR) !== 0) {
      res.writeHead(403, HEADERS);
      return res.end("403");
    }
  }

  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, HEADERS));
      return res.end("404 " + rel);
    }

    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    const headers = Object.assign({ "Content-Type": type, "Accept-Ranges": "bytes" }, HEADERS);
    // 模型文件很大，浏览器/ORT 可能发 Range 请求
    if (rel.indexOf("/assets/") === 0) headers["Cache-Control"] = "public, max-age=31536000, immutable";
    else headers["Cache-Control"] = "no-store, must-revalidate";

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (start >= st.size || end >= st.size || start > end) {
          res.writeHead(416, Object.assign({ "Content-Range": "bytes */" + st.size }, headers));
          return res.end();
        }
        headers["Content-Range"] = "bytes " + start + "-" + end + "/" + st.size;
        headers["Content-Length"] = end - start + 1;
        res.writeHead(206, headers);
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(file, { start: start, end: end }).pipe(res);
      }
    }

    headers["Content-Length"] = st.size;
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

server.on("error", function (err) {
  if (err && err.code === "EADDRINUSE") {
    console.error("端口 " + PORT + " 已被占用，换一个：node serve-local.js 9000");
  } else {
    console.error("启动失败：" + (err && err.message ? err.message : err));
  }
  process.exitCode = 1;
});

server.listen(PORT, "127.0.0.1", function () {
  console.log("ShinobuTranslator 网页版（本地）");
  console.log("  目录：" + ROOT);
  console.log("  打开：http://127.0.0.1:" + PORT + "/");
  console.log("");
  console.log("按 Ctrl+C 停止。");
});
