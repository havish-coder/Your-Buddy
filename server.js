#!/usr/bin/env node
"use strict";
// Open Floor, local server. Serves the page on 127.0.0.1 and answers /api/ask by running the
// Claude Code program (`claude`) in print mode. Node 22 built-ins only, no dependencies.
//
//   node server.js                 PORT=3000 by default (PORT=0 picks a free port)
//
// Environment:
//   PORT                       port to listen on (default 3000)
//   OPEN_FLOOR_CLAUDE_BIN      program to run (default "claude"); a .js/.mjs path is run with this Node
//   OPEN_FLOOR_PRESTART        "0" turns off pre-started processes (one process per ask, no images)
//   OPEN_FLOOR_PRESTART_MODELS models warmed at boot (default "haiku,sonnet"); any model used is re-warmed
//   OPEN_FLOOR_IDLE_MS         replace an unused pre-started process after this long (default 600000)
//   OPEN_FLOOR_ASK_TIMEOUT_MS  give up on an ask after this long without any output (default 120000)
//   OPEN_FLOOR_MAX_ASKS        most asks answered at once; more get 429 (default 3)

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = __dirname;
const IS_WIN = process.platform === "win32";
const BIN = process.env.OPEN_FLOOR_CLAUDE_BIN || "claude";
const PRESTART = process.env.OPEN_FLOOR_PRESTART !== "0";
const IDLE_MS = Number(process.env.OPEN_FLOOR_IDLE_MS) || 10 * 60 * 1000;
const ASK_TIMEOUT_MS = Number(process.env.OPEN_FLOOR_ASK_TIMEOUT_MS) || 120 * 1000;
const BOOT_MODELS = (process.env.OPEN_FLOOR_PRESTART_MODELS ?? "haiku,sonnet").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_BODY = 12 * 1024 * 1024;
const MAX_ASKS = Math.max(1, Math.floor(Number(process.env.OPEN_FLOOR_MAX_ASKS)) || 3);
// One private (mode 0700) working folder for every child, so no other local user can plant
// .claude/settings.json or CLAUDE.md where Claude Code reads them. Removed on exit.
let WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), "open-floor-"));
// A temp cleaner may delete the folder while the server runs: make a fresh private one (never mkdirSync on the old name).
function ensureWorkdir() {
  if (fs.existsSync(WORKDIR)) return;
  try { WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), "open-floor-")); }
  catch (e) { const w = new Error("cannot create the private working folder: " + e.message); w.code = "EWORKDIR"; throw w; }
}
// ENOENT means "program not found" only while the working folder is there; a missing folder is not that.
const programMissing = (e) => !!e && e.code === "ENOENT" && fs.existsSync(WORKDIR);
const TIERS = { quick: "haiku", default: "sonnet", complex: "opus" };
const SYSTEM_PROMPT = "You are Claude. Follow the instructions in the user's message exactly.";

// Only this flag may be dropped (and the ask retried) when the program says it is unknown.
const OPTIONAL_FLAGS = new Map([
  ["--permission-prompts", ["--permission-prompts", "none"]],
]);
// Security flags: if the program rejects one of these the ask fails; we never run without them.
const REQUIRED_FLAGS = ["--strict-mcp-config", "--disable-slash-commands", "--tools", "--no-session-persistence"];

const MESSAGES = {
  not_granted: "Claude Code is not signed in on this computer. Run `claude`, type /login, then try again.",
  rate_limited: "Claude Code reports a usage or rate limit. Wait a while, then try again.",
  sampling_disabled: "The `claude` program was not found. Install Claude Code (or set OPEN_FLOOR_CLAUDE_BIN), then restart this server.",
  refused: "Claude declined to answer that.",
  upstream_error: "Claude Code could not answer. The server's terminal window has the details.",
};

const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const clip = (s, n = 1500) => (s.length > n ? s.slice(0, n) + "...[cut]" : s);

// ---------------------------------------------------------------- the program

function winQuote(a) { return a === "" || /[\s&|<>^()"]/.test(a) ? '"' + a + '"' : a; }

// Every argument comes from constants in this file, never from a request. The prompt goes through stdin.
function spawnClaude(args) {
  ensureWorkdir();
  const opts = { cwd: WORKDIR, stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
  if (/\.(mjs|cjs|js)$/i.test(BIN)) return spawn(process.execPath, [BIN, ...args], opts);
  if (IS_WIN && !/\.exe$/i.test(BIN)) {
    // `claude` may be claude.cmd, which Node will not spawn directly. All parts are fixed constants.
    return spawn([BIN, ...args].map(winQuote).join(" "), { ...opts, shell: true });
  }
  return spawn(BIN, args, opts);
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (IS_WIN) { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); return; }
    child.kill("SIGTERM");
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500);
    t.unref();
  } catch {}
}

function buildArgs(alias, streamIn) {
  const a = ["-p"];
  if (streamIn) a.push("--input-format", "stream-json");
  a.push("--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", alias, "--no-session-persistence", "--tools", "");
  for (const v of OPTIONAL_FLAGS.values()) a.push(...v);
  a.push("--strict-mcp-config", "--disable-slash-commands");
  a.push("--system-prompt", SYSTEM_PROMPT);
  return a;
}

// The flag counts as unknown only when it is the quoted subject of the phrase, e.g. unknown option '--x'.
const RE_UNKNOWN_FLAG = /(?:unknown|unrecognized|invalid)\s+(?:option|argument|flag)s?\s*:?\s*['"\x60‘“](--[A-Za-z0-9-]+)['"\x60’”]/gi;
const unknownFlags = (text) => [...String(text).matchAll(RE_UNKNOWN_FLAG)].map((m) => m[1].toLowerCase());
const rejectedRequiredFlag = (text) => unknownFlags(text).find((f) => REQUIRED_FLAGS.includes(f)) || null;

// If stderr says an optional flag is unknown, forget the flag. Returns true when something changed.
function dropUnknownFlag(text) {
  let changed = false;
  for (const name of unknownFlags(text)) {
    if (OPTIONAL_FLAGS.delete(name)) { changed = true; log("this claude does not know " + name + "; running without it"); }
  }
  return changed;
}

const state = { found: null, version: null, checkedAt: 0, checking: null, failStreak: 0 };
const children = new Set();

function probeVersion() {
  if (state.checking) return state.checking;
  state.checking = new Promise((resolve) => {
    let out = "", done = false;
    const finish = (found, version) => {
      if (done) return; done = true;
      state.found = found; state.version = version; state.checkedAt = Date.now(); state.checking = null;
      resolve();
    };
    let child;
    try { child = spawnClaude(["--version"]); } catch { return finish(false, null); }
    children.add(child);
    const timer = setTimeout(() => { killTree(child); finish(false, null); }, 10000);
    child.stdout.on("data", (d) => { if (out.length < 2000) out += d; });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end();
    child.on("error", () => { clearTimeout(timer); finish(false, null); });
    child.on("close", (code) => {
      clearTimeout(timer); children.delete(child);
      const m = /(\d+\.\d+\.\d+\S*)/.exec(out);
      finish(code === 0 && out.trim() !== "", m ? m[1] : out.trim().split(/\s+/)[0] || null);
    });
  });
  return state.checking;
}

// ---------------------------------------------------------------- one process

// A running `claude`. Used idle (pre-started, waiting on stdin) and then handed to one ask.
class Run {
  constructor(alias, streamIn) {
    this.alias = alias; this.streamIn = streamIn;
    this.startedAt = Date.now();
    this.pending = []; this.sink = null; this.exit = null;
    this.stderr = ""; this.junk = ""; this.sawLine = false; this.buf = "";
    this.spawnError = null; this.idleTimer = null; this.onIdleExit = null; this.used = false;
    let child;
    try { child = spawnClaude(buildArgs(alias, streamIn)); } catch (e) { this.spawnError = e; this._end(-1, null); return; }
    this.child = child;
    children.add(child);
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) { const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); if (l.trim()) this._line(l); }
      if (this.buf.length > 20 * 1024 * 1024) { this.buf = ""; log("dropping an oversized output line"); }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { if (this.stderr.length < 20000) this.stderr += d; });
    child.on("error", (e) => { this.spawnError = e; this._end(-1, null); });
    child.on("close", (code, sig) => { if (this.buf.trim()) { this._line(this.buf); this.buf = ""; } this._end(code, sig); });
  }
  _line(l) { this.sawLine = true; if (this.sink) this.sink.line(l); else if (this.pending.length < 500) this.pending.push(l); }
  _end(code, sig) {
    if (this.exit) return;
    this.exit = { code, sig };
    clearTimeout(this.idleTimer);
    if (this.child) children.delete(this.child);
    if (this.sink) this.sink.exit(this.exit); else if (this.onIdleExit) this.onIdleExit(this);
  }
  attach(sink) {
    this.sink = sink; this.onIdleExit = null; clearTimeout(this.idleTimer);
    for (const l of this.pending.splice(0)) { if (this.sink !== sink) return; sink.line(l); }
    if (this.exit && this.sink === sink) sink.exit(this.exit);
  }
  send(prompt, images) {
    if (!this.child || this.exit) return;
    if (this.streamIn) {
      const content = [];
      for (const im of images || []) content.push({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } });
      content.push({ type: "text", text: prompt });
      this.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
    } else {
      this.child.stdin.end(prompt);
    }
  }
  kill() { this.sink = null; this.onIdleExit = null; clearTimeout(this.idleTimer); if (this.child) killTree(this.child); }
}

// ---------------------------------------------------------------- the pool of idle processes

const pool = new Map(); // alias -> Run
let shuttingDown = false;
const refillTimers = new Set();

function fill(alias) {
  if (!PRESTART || shuttingDown || pool.has(alias) || state.found === false) return;
  const run = new Run(alias, true);
  pool.set(alias, run);
  if (run.spawnError) {
    pool.delete(alias);
    if (programMissing(run.spawnError)) state.found = false;
    return;
  }
  run.idleTimer = setTimeout(() => {
    if (pool.get(alias) !== run) return;
    pool.delete(alias); run.kill(); fill(alias); // quiet replacement of a long-idle process
  }, IDLE_MS);
  run.idleTimer.unref();
  run.onIdleExit = () => {
    if (pool.get(alias) === run) pool.delete(alias);
    const err = run.stderr.trim();
    if (err) log(`idle ${alias} process exited (${run.exit.code}): ${clip(err)}`);
    if (shuttingDown) return;
    const rej = rejectedRequiredFlag(run.stderr);
    if (rej) log("this claude rejected required flag " + rej + "; asks will fail until that is fixed");
    if (dropUnknownFlag(run.stderr)) { for (const r of [...pool.values()]) { pool.delete(r.alias); r.kill(); } fill(alias); return; }
    if (Date.now() - run.startedAt < 5000) state.failStreak++; // dying right away: back off
    const delay = state.failStreak ? Math.min(30000, 500 * 2 ** Math.min(state.failStreak, 6)) : 0;
    const t = setTimeout(() => { refillTimers.delete(t); fill(alias); }, delay);
    t.unref(); refillTimers.add(t);
  };
}

function takeRun(alias) {
  if (PRESTART) {
    const run = pool.get(alias);
    if (run && !run.exit) { pool.delete(alias); run.used = true; setImmediate(() => fill(alias)); return run; }
    if (run) pool.delete(alias);
  }
  const run = new Run(alias, PRESTART);
  if (PRESTART) setImmediate(() => fill(alias));
  return run;
}

// ---------------------------------------------------------------- failure mapping

const RE_AUTH = /not logged in|please run \/login|invalid api key|authentication[_ ]failed|authentication_error|oauth|unauthori[sz]ed|\b401\b|run \/login/i;
const RE_RATE = /usage limit|rate[ _-]?limit|\b429\b|limit reached|too many requests|quota|out of (extra )?usage/i;
const RE_MISSING = /ENOENT|is not recognized|command not found|not found: |no such file/i;

function classify(text) {
  if (RE_RATE.test(text)) return "rate_limited";
  if (RE_AUTH.test(text)) return "not_granted";
  if (RE_MISSING.test(text)) return "sampling_disabled";
  return "upstream_error";
}

// ---------------------------------------------------------------- one ask

// Runs one ask. cb = { delta(text), done(text), error(code) }. Returns cancel().
function runAsk({ alias, prompt, images }, cb) {
  let cancelled = false, finished = false, current = null, retried = false, inactivity = null;

  function end() { clearTimeout(inactivity); finished = true; if (current) { current.kill(); } }
  function succeed(text, extra) { if (finished) return; end(); state.failStreak = 0; cb.done(text, extra); }
  function fail(code, why) {
    if (finished) return; end();
    if (why) log(`ask failed (${code}): ${clip(why)}`);
    cb.error(code);
  }

  function start() {
    const run = takeRun(alias);
    current = run;
    let text = "", stopReason = null, hint = "", resultSeen = false;
    const bump = () => { clearTimeout(inactivity); inactivity = setTimeout(() => { run.kill(); fail("upstream_error", "no output for " + ASK_TIMEOUT_MS + " ms"); }, ASK_TIMEOUT_MS); };
    bump();
    const sink = {
      line(l) {
        if (finished || cancelled) return;
        bump();
        let j;
        try { j = JSON.parse(l); } catch { if (run.junk.length < 5000) run.junk += l + "\n"; return; }
        if (!j || typeof j !== "object") return;
        if (j.type === "stream_event" && j.event) {
          const ev = j.event;
          if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
            text += ev.delta.text; cb.delta(ev.delta.text);
          } else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason) {
            stopReason = ev.delta.stop_reason;
          } else if (ev.type === "message_stop" && stopReason === "end_turn" && text) {
            // The text is complete (only for end_turn; other stop reasons wait for the result line). The real program spends a few more seconds on a summary before its
            // result line; nobody needs to wait for it.
            succeed(text);
          }
        } else if (j.type === "assistant" && j.error) {
          const body = JSON.stringify(j.message && j.message.content || "");
          const code = j.error === "authentication_failed" ? "not_granted" : j.error === "rate_limit" ? "rate_limited" : classify(String(j.error) + " " + body);
          fail(code, "assistant error " + j.error + " " + body);
        } else if (j.type === "rate_limit_event" && j.rate_limit_info && j.rate_limit_info.status === "rejected") {
          hint += " rate limit rejected";
        } else if (j.type === "result") {
          resultSeen = true;
          if (j.is_error) fail(classify(String(j.result || "") + " " + (j.api_error_status || "") + hint + " " + run.stderr), "result error: " + String(j.result || "") + " status " + j.api_error_status);
          else {
            const reason = stopReason || j.stop_reason;
            const final = text || (typeof j.result === "string" ? j.result : "");
            if (reason === "refusal" && !final.trim()) fail("refused", "the model refused");
            else if (reason === "refusal") succeed(final, { refused: true });
            else if (reason === "max_tokens") succeed(final, { truncated: true });
            else succeed(final);
          }
        }
      },
      exit(info) {
        if (finished || cancelled) return;
        const err = (run.stderr + "\n" + run.junk).trim();
        if (run.spawnError && programMissing(run.spawnError)) { state.found = false; return fail("sampling_disabled", String(run.spawnError)); }
        const rej = rejectedRequiredFlag(run.stderr);
        if (rej) return fail("upstream_error", "this claude rejected required flag " + rej + "; refusing to run without it. " + err);
        if (dropUnknownFlag(run.stderr) && !retried) { retried = true; return start(); }
        // A pre-started process that was already dead or died without saying anything: try once with a fresh one.
        if (!retried && run.used && !run.sawLine && !err) { retried = true; log("pre-started process was not usable; retrying with a fresh one"); return start(); }
        const code = classify(err + hint);
        fail(code, `process ended (code ${info.code}, signal ${info.sig}, result ${resultSeen}) ${err}`);
      },
    };
    run.attach(sink);
    if (!finished && !cancelled && !run.exit) run.send(prompt, images);
  }

  start();
  return function cancel() { if (cancelled) return; cancelled = true; end(); };
}

// ---------------------------------------------------------------- the conversation as one prompt

function flatten(messages) {
  const first = messages[0].content;
  const last = messages[messages.length - 1].content;
  if (messages.length === 1) return first;
  const middle = messages.slice(1, -1);
  let p = first;
  if (middle.length) p += "\n\n--- The conversation so far ---\n" + middle.map((m) => (m.role === "assistant" ? "Assistant: " : "User: ") + m.content).join("\n\n");
  p += "\n\n--- The user's latest message. Reply to this one. ---\n" + last;
  return p;
}

function validateAsk(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be an object";
  const { messages, tier, images } = body;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 1000) return "messages must be a non-empty array";
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return "each message needs role user|assistant and string content";
  }
  if (messages[messages.length - 1].role !== "user") return "the last message must be from the user";
  if (messages[0].role !== "user") return "the first message must be from the user";
  if (tier !== undefined && !Object.prototype.hasOwnProperty.call(TIERS, tier)) return "tier must be quick, default or complex";
  if (images !== undefined) {
    if (!Array.isArray(images) || images.length > 20) return "images must be an array of at most 20";
    for (const im of images) {
      if (!im || typeof im.mediaType !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(im.mediaType)) return "image mediaType must be png, jpeg, gif or webp";
      if (typeof im.data !== "string" || !/^[A-Za-z0-9+/=\s]+$/.test(im.data)) return "image data must be base64";
    }
  }
  return null;
}

// ---------------------------------------------------------------- http

const HTML_HEAD = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><script src="/local/shim.js"></script><style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}
:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}</style></head><body>`;
const STATIC = {
  "/floor.js": { file: "floor.js", type: "text/javascript; charset=utf-8" },
  "/local/shim.js": { file: path.join("local", "shim.js"), type: "text/javascript; charset=utf-8" },
};
const BASE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" };

function send(res, status, type, body, extra) {
  res.writeHead(status, { ...BASE_HEADERS, "content-type": type, ...(extra || {}) });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, "application/json; charset=utf-8", JSON.stringify(obj) + "\n");
const sendErrorLine = (res, status, code, message) => send(res, status, "application/x-ndjson; charset=utf-8", JSON.stringify({ error: { code, message } }) + "\n");

function hostOk(value, port) {
  if (typeof value !== "string") return false;
  const m = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/i.exec(value.trim());
  return !!m && (m[2] === undefined ? 80 : Number(m[2])) === port; // no port means 80
}
function originOk(value, port) {
  if (value === undefined) return true; // same-origin GETs and non-browser clients send none
  let u;
  try { u = new URL(value); } catch { return false; }
  if (u.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && (u.port === "" ? 80 : Number(u.port)) === port;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (declared > limit) { const e = new Error("too large"); e.tooLarge = true; req.resume(); return reject(e); }
    const chunks = []; let n = 0, over = false;
    req.on("data", (c) => { n += c.length; if (n > limit) { over = true; chunks.length = 0; return; } if (!over) chunks.push(c); });
    req.on("end", () => { if (over) { const e = new Error("too large"); e.tooLarge = true; reject(e); } else resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

let activeAsks = 0;
const openAsks = new Set(); // responses of asks that are streaming now

async function handleAsk(req, res) {
  let raw;
  try { raw = await readBody(req, MAX_BODY); } catch (e) {
    if (e.tooLarge) { res.shouldKeepAlive = false; return sendErrorLine(res, 413, "upstream_error", "The request is too large (limit 12 MB)."); }
    return;
  }
  let body;
  try { body = JSON.parse(raw); } catch { return sendErrorLine(res, 400, "upstream_error", "The request body is not valid JSON."); }
  const bad = validateAsk(body);
  if (bad) return sendErrorLine(res, 400, "upstream_error", "Bad request: " + bad + ".");
  const images = body.images && body.images.length ? body.images : [];
  if (images.length && !PRESTART) return sendErrorLine(res, 400, "upstream_error", "Images are not supported in this server mode.");
  if (activeAsks >= MAX_ASKS) return sendErrorLine(res, 429, "rate_limited", "Too many requests at once.");
  activeAsks++;
  let released = false;
  const release = () => { if (!released) { released = true; activeAsks--; } };
  res.on("close", release);
  const alias = TIERS[body.tier || "default"];
  if (state.found === false && Date.now() - state.checkedAt > 5000) await probeVersion();
  if (state.found === false) return sendErrorLine(res, 200, "sampling_disabled", MESSAGES.sampling_disabled);

  res.writeHead(200, { ...BASE_HEADERS, "content-type": "application/x-ndjson; charset=utf-8" });
  res.flushHeaders();
  openAsks.add(res);
  res.on("close", () => openAsks.delete(res));
  let over = false;
  const line = (o) => { if (!over && !res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + "\n"); };
  const cancel = runAsk({ alias, prompt: flatten(body.messages), images }, {
    delta: (t) => line({ delta: t }),
    done: (t, extra) => { line({ done: true, text: t, ...(extra || {}) }); over = true; release(); res.end(); },
    error: (code) => { line({ error: { code, message: MESSAGES[code] || MESSAGES.upstream_error } }); over = true; release(); res.end(); },
  });
  // The page aborted the fetch (or went away): stop the child at once.
  res.on("close", () => { if (!res.writableFinished) { over = true; cancel(); } });
}

function handle(req, res, port) {
  if (!hostOk(req.headers.host, port) || !originOk(req.headers.origin, port)) return sendJson(res, 403, { error: "forbidden" });
  const pathname = String(req.url || "/").split("?")[0].split("#")[0];
  const method = req.method;

  if (pathname === "/api/ask") {
    if (method !== "POST") return send(res, 405, "text/plain; charset=utf-8", "Method not allowed\n", { allow: "POST" });
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") return sendErrorLine(res, 403, "upstream_error", "Forbidden.");
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers["content-type"] || ""))) return sendErrorLine(res, 415, "upstream_error", "Content-Type must be application/json.");
    return handleAsk(req, res).catch((e) => { log("ask handler error", e); if (!res.headersSent) sendErrorLine(res, 500, "upstream_error", MESSAGES.upstream_error); else res.end(); });
  }
  if (pathname === "/api/health") {
    if (method !== "GET" && method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "Method not allowed\n", { allow: "GET, HEAD" });
    const answer = () => sendJson(res, 200, { ok: true, claude: { found: !!state.found, version: state.found ? state.version : null }, images: !!(PRESTART && state.found) });
    if (state.found !== true && Date.now() - state.checkedAt > 5000) return probeVersion().then(answer);
    return answer();
  }
  if (method !== "GET" && method !== "HEAD") return send(res, 405, "text/plain; charset=utf-8", "Method not allowed\n", { allow: "GET, HEAD" });
  let body, type;
  try {
    if (pathname === "/") {
      body = HTML_HEAD + fs.readFileSync(path.join(ROOT, "index.html"), "utf8") + "</body></html>";
      type = "text/html; charset=utf-8";
    } else if (Object.prototype.hasOwnProperty.call(STATIC, pathname)) {
      body = fs.readFileSync(path.join(ROOT, STATIC[pathname].file));
      type = STATIC[pathname].type;
    } else return send(res, 404, "text/plain; charset=utf-8", "Not found\n");
  } catch { return send(res, 404, "text/plain; charset=utf-8", "Not found\n"); }
  if (method === "HEAD") { res.writeHead(200, { ...BASE_HEADERS, "content-type": type, "content-length": Buffer.byteLength(body) }); return res.end(); }
  return send(res, 200, type, body);
}

// ---------------------------------------------------------------- start and stop

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(0), 2500).unref();
  for (const t of refillTimers) clearTimeout(t);
  server.close();
  // Tell every open ask why it ends, then give the lines a moment to leave before closing sockets.
  const msg = JSON.stringify({ error: { code: "upstream_error", message: "The server is shutting down." } }) + "\n";
  const flushed = [...openAsks].map((res) => new Promise((resolve) => {
    if (res.destroyed || res.writableEnded) return resolve();
    res.once("finish", resolve); res.once("close", resolve);
    try { res.end(msg); } catch { resolve(); }
  }));
  openAsks.clear();
  Promise.race([Promise.all(flushed), new Promise((r) => setTimeout(r, 500))]).then(finishShutdown);
}

function finishShutdown() {
  for (const r of pool.values()) r.kill();
  pool.clear();
  for (const c of children) killTree(c);
  server.closeAllConnections();
  const wait = setInterval(() => { if (!children.size) { clearInterval(wait); process.exit(0); } }, 50);
}

const server = http.createServer((req, res) => {
  try { handle(req, res, server.address().port); } catch (e) { log("handler error", e); try { if (!res.headersSent) sendJson(res, 500, { error: "server error" }); else res.end(); } catch {} }
});
server.headersTimeout = 30000;

if (require.main === module) for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, shutdown);
process.on("exit", () => {
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
  try { fs.rmSync(WORKDIR, { recursive: true, force: true }); } catch {}
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`Port ${process.env.PORT || 3000} is already in use. Start with another one, for example: PORT=3001 node server.js`);
  else console.error("Server error:", e.message);
  process.exit(1);
});

const wantedPort = process.env.PORT === undefined || process.env.PORT === "" ? 3000 : Number(process.env.PORT);
if (require.main === module) server.listen(wantedPort, "127.0.0.1", async () => {
  const port = server.address().port;
  await probeVersion();
  console.log(`Open Floor is running at http://localhost:${port}/`);
  if (state.found) {
    console.log(`Claude Code ${state.version || ""} found.${PRESTART ? " Warming up..." : ""}`.replace("  ", " "));
    for (const m of BOOT_MODELS) fill(m);
  } else {
    console.log("The `claude` program was not found. Install Claude Code and run `claude` once to sign in; the page will show an error until then.");
  }
});

module.exports = { hostOk, originOk }; // for tests
