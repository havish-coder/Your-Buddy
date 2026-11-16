"use strict";
// Server tests. Run: node --test test/server.test.js
// Every test starts its own server on a free port with test/fixtures/fake-claude.mjs as the program.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const FAKE = path.join(__dirname, "fixtures", "fake-claude.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "open-floor-test-"));
let seq = 0;

async function waitFor(fn, ms = 5000, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what);
    await sleep(25);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Start the server. env overrides; returns { port, logLines(), stop(), serverLog() }.
async function startServer(env = {}) {
  const logFile = path.join(TMP, "fake-" + ++seq + ".jsonl");
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, PORT: "0", OPEN_FLOOR_CLAUDE_BIN: FAKE, OPEN_FLOOR_FAKE_LOG: logFile, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", errOut = "";
  child.stderr.on("data", (d) => (errOut += d));
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { out += d; const m = /http:\/\/localhost:(\d+)\//.exec(out); if (m) resolve(Number(m[1])); });
    child.on("exit", (c) => reject(new Error("server exited early: " + c + " " + errOut)));
    setTimeout(() => reject(new Error("server did not start")), 8000);
  });
  const exited = new Promise((r) => child.on("exit", (c, s) => r({ c, s })));
  const srv = {
    port, child, stdout: () => out, serverLog: () => errOut,
    logLines: () => { try { return fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    starts: () => srv.logLines().filter((l) => l.event === "start"),
    prompts: () => srv.logLines().filter((l) => l.event === "prompt"),
    async stop(sig = "SIGTERM") { if (child.exitCode === null && child.signalCode === null) child.kill(sig); const r = await exited; for (const l of srv.logLines()) if (l.event === "start") await waitFor(() => !alive(l.pid), 5000, "child " + l.pid + " to die"); return r; },
  };
  return srv;
}

// A plain http request with full control of headers. Returns { status, headers, body, lines }.
function request(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      let ended = false;
      res.on("error", reject);
      res.on("close", () => { if (!ended) reject(new Error("connection closed before the response ended")); });
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        ended = true;
        const text = Buffer.concat(chunks).toString("utf8");
        const lines = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } });
        resolve({ status: res.statusCode, headers: res.headers, body: text, lines });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const ask = (port, payload, extra = {}) => request(port, { method: "POST", path: "/api/ask", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), ...extra });
const U = (content) => ({ role: "user", content });

// ------------------------------------------------------------------ health

test("health reports the program and image support", async () => {
  const s = await startServer();
  try {
    const r = await request(s.port, { path: "/api/health" });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /application\/json/);
    const j = JSON.parse(r.body);
    assert.deepEqual(j, { ok: true, claude: { found: true, version: "9.9.9" }, images: true });
  } finally { await s.stop(); }
});

test("health when the program is missing, and an ask maps to sampling_disabled", async () => {
  const s = await startServer({ OPEN_FLOOR_CLAUDE_BIN: path.join(TMP, "no-such-program") });
  try {
    const j = JSON.parse((await request(s.port, { path: "/api/health" })).body);
    assert.deepEqual(j, { ok: true, claude: { found: false, version: null }, images: false });
    const r = await ask(s.port, { messages: [U("hi")], tier: "quick" });
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].error.code, "sampling_disabled");
    assert.ok(r.lines[0].error.message.length > 10);
  } finally { await s.stop(); }
});

test("health with pre-starting off reports images false", async () => {
  const s = await startServer({ OPEN_FLOOR_PRESTART: "0" });
  try {
    const j = JSON.parse((await request(s.port, { path: "/api/health" })).body);
    assert.equal(j.claude.found, true);
    assert.equal(j.images, false);
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ static files

test("GET / wraps index.html with the shim in the head", async () => {
  const s = await startServer();
  try {
    const r = await request(s.port, { path: "/" });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /text\/html/);
    assert.match(r.body, /^<!doctype html>/i);
    const head = r.body.slice(0, r.body.indexOf("</head>"));
    assert.match(head, /<meta charset="utf-8">/);
    assert.match(head, /name="viewport"[^>]*viewport-fit=cover/);
    assert.match(head, /<script src="\/local\/shim\.js"><\/script>/);
    assert.match(head, /body\{margin:0;font:14px/);
    assert.match(head, /img\{max-width:100%\}/);
    assert.match(head, /\[hidden\]\{display:none!important\}/);
    const index = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    assert.ok(r.body.includes(index), "index.html content is in the page");
    assert.ok(r.body.indexOf("/local/shim.js") < r.body.indexOf(index.slice(0, 40)), "shim comes before the page");
    // index.html itself is not changed on disk by serving it
    assert.equal(fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), index);
    assert.ok(!/^\s*<!doctype/i.test(index), "index.html on disk stays a bare fragment");
  } finally { await s.stop(); }
});

test("the two script files are served byte for byte", async () => {
  const s = await startServer();
  try {
    for (const [url, file] of [["/floor.js", "floor.js"], ["/local/shim.js", "local/shim.js"]]) {
      const r = await request(s.port, { path: url });
      assert.equal(r.status, 200, url);
      assert.match(r.headers["content-type"], /javascript/);
      assert.equal(r.body, fs.readFileSync(path.join(ROOT, file), "utf8"));
    }
    const h = await request(s.port, { method: "HEAD", path: "/floor.js" });
    assert.equal(h.status, 200);
    assert.equal(h.body, "");
  } finally { await s.stop(); }
});

test("nothing else is served: no other files, listings or traversal", async () => {
  const s = await startServer();
  try {
    const paths = [
      "/index.html", "/server.js", "/package.json", "/README.md", "/test/server.test.js", "/test/fixtures/fake-claude.mjs",
      "/local", "/local/", "/test/", "/test", "/floor.js/", "/floor.js/x", "/Floor.js", "/local/shim.js/../../server.js",
      "/../server.js", "/..%2fserver.js", "/%2e%2e/server.js", "/%2e%2e%2fserver.js", "/local/..%2fserver.js", "/floor.js%00.png",
      "//etc/passwd", "/etc/passwd", "/.git/config", "/floor.js/..", "/./server.js", "/local/../server.js", "/%66loor.js%00",
    ];
    for (const p of paths) {
      const r = await request(s.port, { path: p });
      assert.equal(r.status, 404, p + " -> " + r.status);
      assert.ok(!r.body.includes("require("), p + " leaked source");
    }
    // query strings do not change what is served
    assert.equal((await request(s.port, { path: "/floor.js?x=1" })).status, 200);
    assert.equal((await request(s.port, { method: "POST", path: "/", body: "x" })).status, 405);
    assert.equal((await request(s.port, { method: "PUT", path: "/floor.js", body: "x" })).status, 405);
  } finally { await s.stop(); }
});

test("the server listens on loopback only", async () => {
  const s = await startServer();
  try {
    const others = [];
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal) others.push(a.address);
    for (const addr of others) {
      const refused = await new Promise((resolve) => {
        const sock = net.connect({ host: addr, port: s.port }, () => { sock.destroy(); resolve(false); });
        sock.on("error", () => resolve(true));
      });
      assert.ok(refused, "must refuse connections to " + addr);
    }
    const ok = await request(s.port, { path: "/api/health" });
    assert.equal(ok.status, 200);
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ origin and host

test("requests with a foreign Host or Origin are refused", async () => {
  const s = await startServer();
  try {
    const p = s.port;
    const bad = [
      { headers: { host: "evil.example" } },
      { headers: { host: `evil.example:${p}` } },
      { headers: { host: `localhost:${p + 1}` } },
      { headers: { host: "localhost" } },
      { headers: { origin: "http://evil.example" } },
      { headers: { origin: `http://evil.example:${p}` } },
      { headers: { origin: `http://localhost:${p + 1}` } },
      { headers: { origin: "http://localhost" } },
      { headers: { origin: "null" } },
      { headers: { origin: `https://localhost:${p}` } },
      { headers: { origin: `http://localhost.evil.example:${p}` } },
    ];
    for (const b of bad) {
      for (const [method, url, body] of [["GET", "/", undefined], ["GET", "/api/health", undefined], ["POST", "/api/ask", JSON.stringify({ messages: [U("hi")], tier: "quick" })]]) {
        const r = await request(p, { method, path: url, headers: { "content-type": "application/json", ...b.headers }, body });
        assert.equal(r.status, 403, `${method} ${url} ${JSON.stringify(b.headers)}`);
      }
    }
    assert.equal(s.prompts().length, 0, "no program was run for a refused request");
    for (const origin of [`http://localhost:${p}`, `http://127.0.0.1:${p}`]) {
      const r = await ask(p, { messages: [U("hi")], tier: "quick" }, { headers: { "content-type": "application/json", origin } });
      assert.equal(r.status, 200);
      assert.ok(r.lines.at(-1).done);
    }
    const h = await request(p, { path: "/api/health", headers: { host: `127.0.0.1:${p}` } });
    assert.equal(h.status, 200);
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ ask

test("an ask streams deltas then exactly one done line", async () => {
  const s = await startServer();
  try {
    const r = await ask(s.port, { messages: [U("Hello there friend")], tier: "quick" });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], /application\/x-ndjson/);
    const deltas = r.lines.filter((l) => "delta" in l);
    const last = r.lines.at(-1);
    assert.ok(deltas.length >= 2, "several deltas");
    assert.equal(r.lines.length, deltas.length + 1, "nothing but deltas and one final line");
    assert.equal(last.done, true);
    assert.equal(last.text, deltas.map((d) => d.delta).join(""));
    assert.match(last.text, /^Fake reply to: .*friend/);
  } finally { await s.stop(); }
});

test("the done line does not wait for the program's slow result line", async () => {
  const s = await startServer({ OPEN_FLOOR_FAKE_RESULT_LAG_MS: "3000" });
  try {
    const t0 = Date.now();
    const r = await ask(s.port, { messages: [U("Hello")], tier: "quick" });
    assert.ok(r.lines.at(-1).done);
    assert.ok(Date.now() - t0 < 2000, "took " + (Date.now() - t0));
  } finally { await s.stop(); }
});

test("tiers map to model aliases and the exact command line is as specified", async () => {
  const s = await startServer({ OPEN_FLOOR_PRESTART_MODELS: "" });
  try {
    for (const [tier, model] of [["quick", "haiku"], ["default", "sonnet"], ["complex", "opus"]]) {
      const before = s.prompts().length;
      const r = await ask(s.port, { messages: [U("secret-prompt-text " + tier)], tier });
      assert.ok(r.lines.at(-1).done, tier);
      const pr = s.prompts()[before];
      const start = s.starts().find((x) => x.pid === pr.pid);
      const a = start.args;
      assert.equal(a[a.indexOf("--model") + 1], model);
      for (const f of ["-p", "--verbose", "--include-partial-messages", "--no-session-persistence"]) assert.ok(a.includes(f), f);
      assert.equal(a[a.indexOf("--output-format") + 1], "stream-json");
      assert.equal(a[a.indexOf("--input-format") + 1], "stream-json");
      assert.equal(a[a.indexOf("--tools") + 1], "");
      assert.equal(a[a.indexOf("--permission-prompts") + 1], "none");
      assert.match(a[a.indexOf("--system-prompt") + 1], /^You are Claude\./);
      assert.ok(!a.includes("--bare"));
      assert.ok(!a.some((x) => x.includes("secret-prompt-text")), "the prompt is never an argument");
    }
    // no tier means default
    const before = s.prompts().length;
    await ask(s.port, { messages: [U("x")] });
    const a = s.starts().find((x) => x.pid === s.prompts()[before].pid).args;
    assert.equal(a[a.indexOf("--model") + 1], "sonnet");
  } finally { await s.stop(); }
});

test("the conversation is flattened into one prompt", async () => {
  const s = await startServer();
  try {
    await ask(s.port, { messages: [U("RULES: be brief"), { role: "assistant", content: "A1" }, U("U2"), { role: "assistant", content: "A2" }, U("FINAL question")], tier: "quick" });
    const p = s.prompts().at(-1).prompt;
    assert.ok(p.startsWith("RULES: be brief"));
    const iA1 = p.indexOf("Assistant: A1"), iU2 = p.indexOf("User: U2"), iA2 = p.indexOf("Assistant: A2"), iF = p.indexOf("FINAL question");
    assert.ok(iA1 > 0 && iU2 > iA1 && iA2 > iU2 && iF > iA2, p);
    assert.match(p.slice(iA2, iF), /latest message/i);
    assert.ok(p.trimEnd().endsWith("FINAL question"));
    await ask(s.port, { messages: [U("only one")], tier: "quick" });
    assert.equal(s.prompts().at(-1).prompt, "only one");
    await ask(s.port, { messages: [U("rules"), U("now")], tier: "quick" });
    const p2 = s.prompts().at(-1).prompt;
    assert.ok(p2.startsWith("rules") && p2.trimEnd().endsWith("now") && !p2.includes("conversation so far"));
  } finally { await s.stop(); }
});

test("images are sent to the program as image blocks", async () => {
  const s = await startServer();
  try {
    const png = fs.readFileSync(path.join(__dirname, "fixtures", "pixel.png"));
    const r = await ask(s.port, { messages: [U("what is this")], tier: "quick", images: [{ mediaType: "image/png", data: png.toString("base64") }] });
    assert.ok(r.lines.at(-1).done);
    assert.match(r.lines.at(-1).text, /\[1 image\]/);
    assert.deepEqual(s.prompts().at(-1).images, [{ media_type: "image/png", bytes: png.length }]);
    const bad = await ask(s.port, { messages: [U("x")], tier: "quick", images: [{ mediaType: "text/html", data: "AAAA" }] });
    assert.equal(bad.status, 400);
    const bad2 = await ask(s.port, { messages: [U("x")], tier: "quick", images: [{ mediaType: "image/png", data: "not base64 !!" }] });
    assert.equal(bad2.status, 400);
  } finally { await s.stop(); }
});

test("with pre-starting off each ask runs its own process with the prompt as plain text, and images are refused", async () => {
  const s = await startServer({ OPEN_FLOOR_PRESTART: "0" });
  try {
    assert.equal(s.starts().filter((x) => x.args[0] === "-p").length, 0, "nothing is started at boot");
    const r = await ask(s.port, { messages: [U("plain hello")], tier: "quick" });
    assert.ok(r.lines.at(-1).done);
    const start = s.starts().find((x) => x.args[0] === "-p");
    assert.ok(!start.args.includes("--input-format"));
    assert.equal(s.prompts().at(-1).prompt, "plain hello");
    const img = await ask(s.port, { messages: [U("x")], tier: "quick", images: [{ mediaType: "image/png", data: "AAAA" }] });
    assert.equal(img.status, 400);
  } finally { await s.stop(); }
});

test("bad requests are answered with an error line and run nothing", async () => {
  const s = await startServer();
  try {
    const cases = [
      ["not json", "{nope"],
      ["no messages", JSON.stringify({ tier: "quick" })],
      ["empty messages", JSON.stringify({ messages: [] })],
      ["last is assistant", JSON.stringify({ messages: [U("a"), { role: "assistant", content: "b" }] })],
      ["bad role", JSON.stringify({ messages: [{ role: "system", content: "a" }] })],
      ["bad tier", JSON.stringify({ messages: [U("a")], tier: "turbo" })],
      ["content not a string", JSON.stringify({ messages: [{ role: "user", content: ["a"] }] })],
    ];
    for (const [name, body] of cases) {
      const r = await request(s.port, { method: "POST", path: "/api/ask", headers: { "content-type": "application/json" }, body });
      assert.equal(r.status, 400, name);
      assert.ok(r.lines[0].error && r.lines[0].error.code, name);
    }
    assert.equal(s.prompts().length, 0);
    assert.equal((await request(s.port, { path: "/api/ask" })).status, 405);
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ body limit

test("a body over 12 MB is refused, one a little under is accepted", async () => {
  const s = await startServer();
  try {
    const big = Buffer.alloc(12 * 1024 * 1024 + 10, 97);
    const r = await request(s.port, { method: "POST", path: "/api/ask", headers: { "content-type": "application/json", "content-length": String(big.length) }, body: big }).catch((e) => ({ status: "reset", err: e }));
    // Either a clean 413 or the connection being cut; never an answer.
    assert.ok(r.status === 413 || r.status === "reset", "status " + r.status);
    if (r.status === 413) assert.equal(r.lines[0].error.code, "upstream_error");
    assert.equal(s.prompts().length, 0, "the program was not run");
    const under = JSON.stringify({ messages: [U("x".repeat(11 * 1024 * 1024))], tier: "quick" });
    const ok = await ask(s.port, JSON.parse(under));
    assert.equal(ok.status, 200);
    assert.ok(ok.lines.at(-1).done);
    // same limit when the length is not declared up front
    const chunked = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: "/api/ask", headers: { host: `localhost:${s.port}`, "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", () => resolve("reset"));
      const chunk = Buffer.alloc(1024 * 1024, 97);
      let i = 0;
      (function w() { while (i < 14) { i++; if (!req.write(chunk)) return req.once("drain", w); } req.end(); })();
    });
    assert.ok(chunked === 413 || chunked === "reset", "chunked: " + chunked);
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ failures

test("failures from the program map to the page's error codes and never leak stderr", async () => {
  const s = await startServer();
  try {
    const cases = [
      ["[[notloggedin]]", "not_granted"],
      ["[[stderrauth]]", "not_granted"],
      ["[[ratelimit]]", "rate_limited"],
      ["[[crash]]", "upstream_error"],
      ["[[garbage]]", "upstream_error"],
    ];
    for (const [magic, code] of cases) {
      const r = await ask(s.port, { messages: [U("please " + magic)], tier: "quick" });
      assert.equal(r.status, 200, magic);
      const last = r.lines.at(-1);
      assert.equal(last.error && last.error.code, code, magic + " -> " + JSON.stringify(last));
      assert.equal(r.lines.filter((l) => l.error || l.done).length, 1, magic + " exactly one final line");
      assert.ok(typeof last.error.message === "string" && last.error.message.length > 10);
      assert.ok(!/credentials|secret|\/home\/user|fake-claude|Invalid API key/.test(r.body.replace(/"delta":"[^"]*"/g, "")), magic + " leaked program output: " + r.body);
    }
    assert.match(s.serverLog(), /secret detail/, "the stderr was logged on the server");
    // the server is still healthy and answers the next ask
    const r = await ask(s.port, { messages: [U("fine now")], tier: "quick" });
    assert.ok(r.lines.at(-1).done);
  } finally { await s.stop(); }
});

test("a program that never answers is given up on", async () => {
  const s = await startServer({ OPEN_FLOOR_ASK_TIMEOUT_MS: "600" });
  try {
    const r = await ask(s.port, { messages: [U("[[hang]]")], tier: "quick" });
    assert.equal(r.lines.at(-1).error.code, "upstream_error");
    const pid = s.prompts().find((p) => p.prompt.includes("[[hang]]")).pid;
    await waitFor(() => !alive(pid), 4000, "hung child to be killed");
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ abort

test("when the client aborts, the child is killed at once", async () => {
  const s = await startServer();
  try {
    const body = JSON.stringify({ messages: [U("[[slow]] go")], tier: "quick" });
    const pid = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: "/api/ask", headers: { host: `localhost:${s.port}`, "content-type": "application/json" } }, (res) => {
        res.once("data", async () => {
          try {
            const p = (await waitFor(() => s.prompts().find((x) => x.prompt.includes("[[slow]]")), 2000, "prompt log")).pid;
            assert.ok(alive(p), "child is running while streaming");
            req.destroy();
            resolve(p);
          } catch (e) { reject(e); }
        });
      });
      req.on("error", () => {});
      req.end(body);
    });
    const t0 = Date.now();
    await waitFor(() => !alive(pid), 2500, "child to be killed");
    assert.ok(Date.now() - t0 < 2500);
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ pre-started processes

test("one idle process per model is waiting before any ask, and its replacement starts when it is used", async () => {
  const s = await startServer({ OPEN_FLOOR_PRESTART_MODELS: "haiku,sonnet" });
  try {
    const models = () => s.starts().map((x) => x.args[x.args.indexOf("--model") + 1]);
    await waitFor(() => s.starts().filter((x) => x.args[0] === "-p").length === 2, 5000, "two spares");
    assert.deepEqual(models().sort(), ["haiku", "sonnet"]);
    assert.equal(s.prompts().length, 0, "idle processes have been given nothing");
    const sparePid = s.starts().find((x) => x.args.includes("haiku")).pid;
    const r = await ask(s.port, { messages: [U("use the spare")], tier: "quick" });
    assert.ok(r.lines.at(-1).done);
    assert.equal(s.prompts()[0].pid, sparePid, "the ask used the pre-started process");
    await waitFor(() => models().filter((m) => m === "haiku").length === 2, 5000, "haiku replacement");
    const second = await ask(s.port, { messages: [U("again")], tier: "quick" });
    assert.ok(second.lines.at(-1).done);
    assert.notEqual(s.prompts()[1].pid, sparePid);
    await waitFor(() => !alive(sparePid), 3000, "used process to end");
  } finally { await s.stop(); }
});

test("a pre-started process that dies is replaced quietly, and an ask right after still works", async () => {
  const s = await startServer({ OPEN_FLOOR_PRESTART_MODELS: "haiku" });
  try {
    await waitFor(() => s.starts().some((x) => x.args[0] === "-p"), 5000, "spare");
    const pid = s.starts()[0].pid;
    process.kill(pid, "SIGKILL");
    // ask straight away: either the replacement is up or a fresh process is used; both must work
    const r = await ask(s.port, { messages: [U("after the death")], tier: "quick" });
    assert.ok(r.lines.at(-1).done, JSON.stringify(r.lines.at(-1)));
    assert.notEqual(s.prompts().at(-1).pid, pid);
    await waitFor(() => s.starts().length >= 2, 5000, "a replacement process");
  } finally { await s.stop(); }
});

test("a pre-started process that sits unused for too long is replaced", async () => {
  const s = await startServer({ OPEN_FLOOR_PRESTART_MODELS: "haiku", OPEN_FLOOR_IDLE_MS: "300" });
  try {
    await waitFor(() => s.starts().length >= 1, 5000, "first spare");
    const first = s.starts()[0].pid;
    await waitFor(() => s.starts().length >= 2, 5000, "replacement spare");
    await waitFor(() => !alive(first), 3000, "old spare to be killed");
    const r = await ask(s.port, { messages: [U("late ask")], tier: "quick" });
    assert.ok(r.lines.at(-1).done);
    const answered = s.prompts().at(-1).pid;
    assert.ok(s.starts().some((x) => x.pid === answered));
  } finally { await s.stop(); }
});

test("a program that keeps dying at start does not make the server spin", async () => {
  const s = await startServer({ OPEN_FLOOR_PRESTART_MODELS: "haiku", OPEN_FLOOR_FAKE_MODE: "dieidle" });
  try {
    await sleep(1500);
    assert.ok(s.starts().length <= 4, "restart attempts are backed off: " + s.starts().length);
    const h = await request(s.port, { path: "/api/health" });
    assert.equal(h.status, 200);
  } finally { await s.stop(); }
});

// ------------------------------------------------------------------ shutdown

test("SIGINT and SIGTERM kill every child", async () => {
  for (const sig of ["SIGINT", "SIGTERM"]) {
    const s = await startServer({ OPEN_FLOOR_PRESTART_MODELS: "haiku,sonnet,opus" });
    await waitFor(() => s.starts().filter((x) => x.args[0] === "-p").length === 3, 5000, "three spares");
    // one ask in flight as well
    const pending = ask(s.port, { messages: [U("[[slow]] shutdown")], tier: "quick" }).catch(() => null);
    await waitFor(() => s.prompts().length === 1, 3000, "ask to reach the program");
    const pids = s.starts().filter((x) => x.args[0] === "-p").map((x) => x.pid);
    const r = await s.stop(sig);
    assert.ok(r.c === 0 || r.s === sig, `exit ${JSON.stringify(r)}`);
    for (const pid of pids) assert.ok(!alive(pid), sig + ": child " + pid + " still running");
    await pending;
  }
});

// ------------------------------------------------------------------ no process left behind

test.after(() => {
  const ps = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).split("\n").filter((l) => l.includes("fake-claude.mjs") && !l.includes(" ps "));
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.deepEqual(ps, [], "no fake-claude process may be left behind:\n" + ps.join("\n"));
});


// ------------------------------------------------------------------ hardening

function rawAsk(port, payload) {
  const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/ask", headers: { host: "localhost:" + port, "content-type": "application/json" } });
  const p = new Promise((resolve) => { req.on("response", (res) => { res.resume(); res.on("error", () => {}); resolve(res.statusCode); }); req.on("error", () => {}); });
  req.end(JSON.stringify(payload));
  return { req, p };
}
const lastLine = (r) => r.lines[r.lines.length - 1];

test("children run in a private open-floor-* folder with mode 0700, removed on exit", async () => {
  const srv = await startServer({ OPEN_FLOOR_PRESTART: "0" });
  let cwd;
  try {
    const r = await ask(srv.port, { messages: [U("hello")] });
    assert.strictEqual(lastLine(r).done, true);
    cwd = srv.starts()[0].cwd;
    assert.ok(path.basename(cwd).startsWith("open-floor-"), cwd);
    assert.notStrictEqual(fs.realpathSync(cwd), fs.realpathSync(os.tmpdir()));
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(cwd).mode & 0o777, 0o700);
  } finally { await srv.stop(); }
  assert.strictEqual(fs.existsSync(cwd), false);
});

test("only --permission-prompts is dropped, and only as the quoted subject of the phrase", async () => {
  const srv = await startServer({ OPEN_FLOOR_PRESTART: "0", OPEN_FLOOR_FAKE_UNKNOWN_FLAG: "--permission-prompts", OPEN_FLOOR_FAKE_UNKNOWN: "error: unknown option '--permission-prompts' (see --strict-mcp-config)" });
  try {
    const r = await ask(srv.port, { messages: [U("hello")] });
    assert.strictEqual(lastLine(r).done, true);
    const s = srv.starts();
    assert.ok(s[0].args.includes("--permission-prompts"));
    const last = s[s.length - 1].args;
    assert.ok(!last.includes("--permission-prompts"));
    for (const f of ["--strict-mcp-config", "--disable-slash-commands", "--tools", "--no-session-persistence"]) assert.ok(last.includes(f), f);
  } finally { await srv.stop(); }
});

test("a rejected security flag fails the ask and is never dropped", async () => {
  const srv = await startServer({ OPEN_FLOOR_PRESTART: "0", OPEN_FLOOR_FAKE_UNKNOWN_FLAG: "--strict-mcp-config", OPEN_FLOOR_FAKE_UNKNOWN: "error: unknown option '--strict-mcp-config'" });
  try {
    const r = await ask(srv.port, { messages: [U("hello")] });
    assert.strictEqual(lastLine(r).error.code, "upstream_error");
    await sleep(200);
    const s = srv.starts();
    assert.strictEqual(s.length, 1);
    assert.ok(s.every((x) => x.args.includes("--strict-mcp-config")));
    assert.ok(srv.serverLog().includes("--strict-mcp-config"));
  } finally { await srv.stop(); }
});

test("asks in flight are capped; the extra one gets 429 and starts no child", async () => {
  const srv = await startServer({ OPEN_FLOOR_MAX_ASKS: "2", OPEN_FLOOR_PRESTART: "0" });
  const a = rawAsk(srv.port, { messages: [U("[[hang]] one")] });
  const b = rawAsk(srv.port, { messages: [U("[[hang]] two")] });
  try {
    assert.deepStrictEqual([await a.p, await b.p], [200, 200]);
    await waitFor(() => srv.starts().length === 2, 5000, "two children");
    const c = await ask(srv.port, { messages: [U("third")] });
    assert.strictEqual(c.status, 429);
    assert.deepStrictEqual(c.lines, [{ error: { code: "rate_limited", message: "Too many requests at once." } }]);
    await sleep(300);
    assert.strictEqual(srv.starts().length, 2);
    a.req.destroy();
    const d = await waitFor(async () => { const r = await ask(srv.port, { messages: [U("again")] }); return r.status === 200 ? r : null; }, 5000, "a free slot");
    assert.strictEqual(lastLine(d).done, true);
  } finally { b.req.destroy(); await srv.stop(); }
});

test("end_turn finishes without waiting for a late result line", async () => {
  const srv = await startServer({ OPEN_FLOOR_PRESTART: "0", OPEN_FLOOR_FAKE_RESULT_LAG_MS: "4000" });
  try {
    const t0 = Date.now();
    const r = await ask(srv.port, { messages: [U("hello")] });
    assert.strictEqual(lastLine(r).done, true);
    assert.strictEqual(lastLine(r).truncated, undefined);
    assert.ok(Date.now() - t0 < 3000, "waited for the result line");
  } finally { await srv.stop(); }
});

test("max_tokens gives truncated: true; a refusal with no text gives refused", async () => {
  const srv = await startServer({ OPEN_FLOOR_PRESTART: "0" });
  try {
    const r = await ask(srv.port, { messages: [U("[[maxtokens]] hello")] });
    assert.strictEqual(lastLine(r).done, true);
    assert.strictEqual(lastLine(r).truncated, true);
    assert.ok(lastLine(r).text.length > 0);
    const f = await ask(srv.port, { messages: [U("[[refusal]] hello")] });
    assert.strictEqual(lastLine(f).error.code, "refused");
  } finally { await srv.stop(); }
});

test("SIGTERM during a slow ask ends the stream with an error line", async () => {
  const srv = await startServer({ OPEN_FLOOR_PRESTART: "0" });
  const p = ask(srv.port, { messages: [U("[[slow]] hello")] });
  await waitFor(() => srv.prompts().length > 0, 5000, "the ask to start");
  srv.child.kill("SIGTERM");
  const r = await p;
  assert.deepStrictEqual(lastLine(r), { error: { code: "upstream_error", message: "The server is shutting down." } });
  await srv.stop();
});

test("SIGHUP shuts the server down like SIGTERM", async () => {
  const srv = await startServer({ OPEN_FLOOR_PRESTART: "0" });
  const r = await srv.stop("SIGHUP");
  assert.strictEqual(r.c, 0);
});

test("framing headers are on every response", async () => {
  const srv = await startServer({ OPEN_FLOOR_PRESTART: "0" });
  try {
    for (const p of ["/", "/api/health"]) {
      const r = await request(srv.port, { path: p });
      assert.strictEqual(r.headers["x-frame-options"], "DENY", p);
      assert.strictEqual(r.headers["content-security-policy"], "frame-ancestors 'none'", p);
    }
  } finally { await srv.stop(); }
});

test("POST /api/ask needs a JSON content type and a same-origin Sec-Fetch-Site", async () => {
  const srv = await startServer({ OPEN_FLOOR_PRESTART: "0" });
  const body = JSON.stringify({ messages: [U("hello")] });
  try {
    for (const ct of ["text/plain", undefined]) {
      const r = await request(srv.port, { method: "POST", path: "/api/ask", headers: ct ? { "content-type": ct } : {}, body });
      assert.strictEqual(r.status, 415);
      assert.ok(r.lines[0].error);
    }
    const ok = await request(srv.port, { method: "POST", path: "/api/ask", headers: { "content-type": "application/json; charset=utf-8" }, body });
    assert.strictEqual(ok.status, 200);
    for (const site of ["cross-site", "same-site"]) {
      const r = await ask(srv.port, { messages: [U("hello")] }, { headers: { "content-type": "application/json", "sec-fetch-site": site } });
      assert.strictEqual(r.status, 403, site);
      assert.ok(r.lines[0].error);
    }
    for (const site of ["same-origin", "none"]) {
      const r = await ask(srv.port, { messages: [U("hello")] }, { headers: { "content-type": "application/json", "sec-fetch-site": site } });
      assert.strictEqual(r.status, 200, site);
    }
  } finally { await srv.stop(); }
});

test("Host and Origin checks treat a missing port as 80", () => {
  const { hostOk, originOk } = require("../server.js");
  assert.ok(hostOk("localhost", 80));
  assert.ok(hostOk("localhost:80", 80));
  assert.ok(hostOk("127.0.0.1:3000", 3000));
  assert.ok(!hostOk("localhost", 3000));
  assert.ok(!hostOk("localhost:81", 80));
  assert.ok(!hostOk("evil.example", 80));
  assert.ok(originOk("http://localhost", 80));
  assert.ok(originOk("http://localhost:3000", 3000));
  assert.ok(!originOk("http://localhost", 3000));
  assert.ok(!originOk("http://localhost:81", 80));
  assert.ok(originOk(undefined, 80));
});
