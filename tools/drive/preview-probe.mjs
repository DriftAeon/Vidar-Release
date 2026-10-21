// Loopback transport observer for the preview renderer harness.
//
//   node tools\drive\preview-probe.mjs            (listens on 127.0.0.1:1447)
//
// Logs every TCP connection (server-side id + time) and every HTTP request
// line (with the fixture's ?run=&case=&config=&phase= query) to stdout and to
// bridge\preview-probe.log. Requests are associated to connections by id
// afterwards; a reused keep-alive connection needn't produce a new connection
// event per case. This observes loopback HTTP/TCP only — DNS and other
// destinations are the DevTools observer's job (tools\drive\preview-harness.mjs).
import http from "node:http";
import fs from "node:fs";
import { join } from "node:path";
import { resolve as resolveId } from "../lib/paths.mjs";

const PORT = 1447;
const LOG = join(resolveId("bridge"), "preview-probe.log");
let connId = 0;

function log(line) {
  const s = `${new Date().toISOString()} ${line}`;
  console.log(s);
  fs.appendFileSync(LOG, s + "\n");
}

const server = http.createServer((req, res) => {
  const id = req.socket.__id ?? "?";
  log(`REQUEST conn=${id} ${req.method} ${req.url} ua=${(req.headers["user-agent"] ?? "").slice(0, 40)}`);
  // a tiny valid PNG so a transport positive control actually "loads"
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "content-length": png.length });
  res.end(png);
});
server.on("connection", (sock) => {
  sock.__id = ++connId;
  log(`CONNECT conn=${sock.__id} from=${sock.remoteAddress}:${sock.remotePort}`);
});
server.listen(PORT, "127.0.0.1", () => log(`LISTEN 127.0.0.1:${PORT} pid=${process.pid}`));
