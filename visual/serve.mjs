// The report with working verdict buttons (run.sh report): serves one run's
// folder, writes the buttons' verdicts into verdicts.txt and redraws the
// report on request (review.mjs with REDRAW=1: no Grok, no cost).
//
// Runs in the kit's container; run.sh publishes the port on 127.0.0.1 only.
// Writes come only from the report itself: same origin, JSON.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

import { parseLine, sameTarget } from "./verdicts.mjs";

const OUT = process.env.REVIEW_OUT ?? "/out";
const VERDICTS = process.env.REVIEW_VERDICTS ?? "/verdicts.txt";
const PORT = Number(process.env.PORT || 7317);
const types = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".json": "application/json", ".log": "text/plain; charset=utf-8" };

// A new line replaces every line about the same finding; removals name lines.
function apply({ lines = [], remove = [] }) {
  const add = lines.map((l) => [l, parseLine(l)]);
  const drop = remove.map((l) => parseLine(l));
  const bad = [...add.filter(([, e]) => !e).map(([l]) => l), ...remove.filter((_, i) => !drop[i])];
  if (bad.length) throw new Error(`not a verdict line: ${bad[0]}`);
  const targets = [...add.map(([, e]) => e), ...drop];
  const kept = (existsSync(VERDICTS) ? readFileSync(VERDICTS, "utf8") : "").split("\n").filter((raw) => {
    const e = parseLine(raw);
    return !e || !targets.some((t) => sameTarget(e, t));
  });
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  // Written in place: the file is a single mounted file, a rename would not reach it.
  writeFileSync(VERDICTS, [...kept, ...add.map(([l]) => l), ""].join("\n"));
}

const redraw = () =>
  new Promise((done, fail) => {
    const child = spawn("node", [join(import.meta.dirname, "review.mjs")], { env: { ...process.env, REDRAW: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("close", (code) => (code === 0 ? done(log) : fail(new Error(log.slice(-600)))));
  });

const body = (req) =>
  new Promise((done, fail) => {
    let data = "";
    req.on("data", (d) => {
      data += d;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        done(JSON.parse(data || "{}"));
      } catch (e) {
        fail(e);
      }
    });
  });

createServer(async (req, res) => {
  const reply = (status, text, type = "text/plain; charset=utf-8") => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(text);
  };
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST") {
    const origin = req.headers.origin ? new URL(req.headers.origin) : null;
    const ours = !origin || (["127.0.0.1", "localhost"].includes(origin.hostname) && origin.port === String(PORT));
    if (!/^application\/json/.test(req.headers["content-type"] ?? "") || !ours)
      return reply(403, "only from the report itself");
    try {
      if (url.pathname === "/verdicts") apply(await body(req));
      else if (url.pathname === "/redraw") console.log((await redraw()).trim().split("\n").slice(-4).join("\n"));
      else return reply(404, "no such action");
      return reply(200, "ok");
    } catch (e) {
      return reply(400, String(e.message ?? e).slice(0, 600));
    }
  }
  const path = normalize(join(OUT, decodeURIComponent(url.pathname === "/" ? "/report.html" : url.pathname)));
  if (!path.startsWith(OUT + "/") || !existsSync(path) || !statSync(path).isFile()) return reply(404, "not found");
  reply(200, readFileSync(path), types[extname(path)] ?? "application/octet-stream");
}).listen(PORT, "0.0.0.0", () => console.log(`The report with working buttons: http://127.0.0.1:${PORT}/  (Ctrl-C ends it)`));
