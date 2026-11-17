// Smoke test for index.html. Run from the project folder: node test/smoke.mjs
// Fakes for window.claude are injected with page.addInitScript; nothing test-related lives in index.html.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = "/tmp/claude-0/-home-user/273c0c87-38b9-5800-970d-c86c6c4a3717/scratchpad/shots";
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- tiny static server (wraps index.html the way the publisher would) ----------
const WRAP_HEAD = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,sans-serif}[hidden]{display:none!important}
:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}</style></head><body>`;
const TYPES = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".pdf": "application/pdf", ".txt": "text/plain" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const body = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(WRAP_HEAD + body + "</body></html>");
    return;
  }
  const f = path.join(ROOT, path.normalize(url.pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// ---------- fakes, injected before page scripts ----------
function installFakes(opts) {
  const missing = new Set(opts.missing || []);
  const F = (window.__fake = {
    dictationStarts: 0, dictationStops: 0, noGesture: 0, dictationFail: null, sampleError: null,
    spoken: [], ttsStops: 0, calls: [], replies: [], autoFinish: true, speakMs: 30, blocked: false,
    script: { listen: [], strict: [], monitor: [] }, tones: 0, audioCtxs: 0,
    handlers: { partial: [], final: [], dstate: [], tstate: [], pos: [] },
  });
  // stub AudioContext: counts oscillators started, so the cut-in tone can be asserted
  window.AudioContext = class {
    constructor() { F.audioCtxs++; this.state = "running"; this.currentTime = 0; this.destination = {}; }
    createOscillator() { return { type: "", frequency: { value: 0 }, connect() {}, start() { F.tones++; }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    resume() { return Promise.resolve(); }
  };
  // a synchronous gesture window: true only while a click/keydown is being dispatched
  let g = false;
  for (const t of ["click", "keydown", "pointerdown"]) window.addEventListener(t, () => { g = true; setTimeout(() => { g = false; }, 0); }, true);

  // dictation
  let dstate = "idle";
  const setD = (s, reason) => { dstate = s; F.handlers.dstate.forEach((h) => h({ state: s, reason })); };
  const dictation = {
    start() {
      if (!g || !navigator.userActivation.isActive) { F.noGesture++; return Promise.reject({ code: "no_gesture", message: "DEVMSG no gesture" }); }
      F.dictationStarts++;
      if (F.dictationFail) { const e = F.dictationFail; F.dictationFail = null; return Promise.reject({ code: e, message: "DEVMSG mic failure" }); }
      stopAllSpeech("interrupted");
      if (dstate !== "idle") return Promise.resolve();
      setD("starting");
      return new Promise((r) => setTimeout(() => { setD("listening"); r(); }, 5));
    },
    stop() {
      F.dictationStops++;
      if (dstate === "idle") return Promise.resolve();
      setD("finishing");
      return new Promise((r) => setTimeout(() => { setD("idle", "stopped"); r(); }, 5));
    },
    active: () => dstate !== "idle",
    onPartial: (h) => { F.handlers.partial.push(h); return () => {}; },
    onFinal: (h) => { F.handlers.final.push(h); return () => {}; },
    onState: (h) => { F.handlers.dstate.push(h); return () => {}; },
  };
  F.say = {
    partial: (text) => F.handlers.partial.forEach((h) => h({ text })),
    final: (text) => { F.handlers.final.forEach((h) => h({ text })); F.handlers.partial.forEach((h) => h({ text: "" })); },
  };

  // tts: one reading made of queued calls; add() queues after the current reading, each call settles on its own lines
  const setT = (s, reason) => F.handlers.tstate.forEach((h) => h({ state: s, reason }));
  let queue = [], current = null, timer = null;
  const pump = () => {
    if (current || !queue.length) return;
    current = queue.shift();
    const lines = current.lines;
    lines.forEach((l, i) => { F.spoken.push(l.text); setTimeout(() => F.handlers.pos.forEach((h) => h({ ms: 1500, line: i, id: l.id })), 10); });
    setT("starting");
    setTimeout(() => { if (current) setT("speaking"); }, 5);
    if (F.autoFinish) timer = setTimeout(finish, F.speakMs);
  };
  const finish = () => {
    clearTimeout(timer);
    const c = current; current = null;
    if (!c) return;
    c.resolve({ playedMs: 2000 });
    if (!queue.length) setT("idle", "completed");
    pump();
  };
  F.finishSpeech = finish;
  const stopAllSpeech = (reason) => {
    clearTimeout(timer);
    const all = [current, ...queue].filter(Boolean);
    current = null; queue = [];
    if (all.length) { setT("idle", reason); all.forEach((c) => c.reject({ code: "stopped", message: "DEVMSG " + reason, reason })); }
  };
  F.platformStop = () => { F.blocked = true; stopAllSpeech("viewer_stopped"); };
  const enqueue = (what) => {
    const lines = typeof what === "string" ? [{ text: what }] : what;
    return new Promise((resolve, reject) => { queue.push({ lines, resolve, reject }); pump(); });
  };
  const gate = () => {
    if (!F.blocked) return null;
    if (g) { F.blocked = false; return null; }
    return Promise.reject({ code: "no_gesture", message: "DEVMSG speak needs a press" });
  };
  const tts = {
    speak(what) {
      if (dstate !== "idle") return Promise.reject({ code: "busy", message: "DEVMSG mic is on" });
      const blocked = gate(); if (blocked) return blocked;
      stopAllSpeech("replaced");
      return enqueue(what);
    },
    add(what) {
      if (!current && !queue.length) return tts.speak(what);
      return enqueue(what);
    },
    stop() { F.ttsStops++; stopAllSpeech("stopped"); return Promise.resolve(); },
    setRate: () => Promise.resolve(),
    voices: () => Promise.resolve(["buttery", "airy", "glassy", "rounded"]),
    active: () => !!current,
    onState: (h) => { F.handlers.tstate.push(h); return () => {}; },
    onPosition: (h) => { F.handlers.pos.push(h); return () => {}; },
    onLine: () => () => {},
  };

  // sample
  const sample = async (messages, o = {}) => {
    const images = [];
    const list = o.images ? (Array.isArray(o.images) ? o.images : [o.images]) : [];
    for (const b of list) images.push({ size: b.size, type: b.type });
    const last = messages[messages.length - 1].content || "";
    // tell the ask types apart by the literal markers in the final user message
    const kind = /\[LISTENING: STRICT CHECK\]/.test(last) ? "strict" : /\[LISTENING\]/.test(last) ? "listen" : /\[PAUSED: LISTEN MODE\]/.test(last) ? "monitor"
      : /\[REPLY NOW\]/.test(last) ? "forced" : /\[PAUSED\]/.test(last) ? "paused" : (images.length && /describ/i.test(last)) ? "describe" : "other";
    F.calls.push({ messages: JSON.parse(JSON.stringify(messages)), tier: o.modelTier, images, cache: o.cache, kind });
    if (F.sampleError) throw { code: F.sampleError, message: "DEVMSG sample " + F.sampleError };
    let reply;
    if (kind === "describe") reply = "A tiny test image.";
    else if (kind === "listen" || kind === "strict" || kind === "monitor") reply = F.script[kind].length ? F.script[kind].shift() : "<notes>default notes</notes>";
    else reply = F.replies.length ? F.replies.shift() : "Fair enough. Go on.";
    await new Promise((r, rej) => {
      let i = 0;
      const tick = () => {
        if (o.signal && o.signal.aborted) return rej({ code: "cancelled", message: "cancelled" });
        if (i >= reply.length) return r();
        const delta = reply.slice(i, i + 14); i += 14;
        if (o.onText) o.onText({ text: reply.slice(0, i), delta });
        setTimeout(tick, 4);
      };
      tick();
    });
    return { text: reply, truncated: false, modelTierApplied: o.modelTier || "quick" };
  };
  sample.limits = () => new Promise((r) => setTimeout(r, opts.limitsDelay || 0)).then(() => ({ maxPromptBytes: 1000000, images: { maxCount: opts.maxCount || 4, maxInputBytes: 5000000, mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"] } }));
  const all = { dictation, tts, sample };
  window.claude = { use: (n) => new Promise((r) => setTimeout(() => r(missing.has(n) ? null : all[n] || null), opts.delay || 0)) };
}

// ---------- harness ----------
const browser = await chromium.launch();
const results = [];
const record = (name, status, detail = "") => { results.push({ name, status, detail }); console.log(`${status.toUpperCase().padEnd(5)} ${name}${detail ? " :: " + detail : ""}`); };

const PDFJS_DIR = "/tmp/claude-0/-home-user/273c0c87-38b9-5800-970d-c86c6c4a3717/scratchpad/pdfjs";
const PDF_LOCAL = { "pdf.min.js": path.join(PDFJS_DIR, "pdf.min.js"), "pdf.worker.min.js": path.join(PDFJS_DIR, "pdf.worker.min.js") };
const havePdfjs = Object.values(PDF_LOCAL).every((f) => fs.existsSync(f));
const FX = (n) => path.join(ROOT, "test/fixtures", n);

async function newPage({ missing = [], width = 1280, height = 800, scheme = "light", delay = 0, maxCount, limitsDelay = 0, wait = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  if (havePdfjs) {
    await page.route(/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/3\.11\.174\/(pdf\.min\.js|pdf\.worker\.min\.js)$/, (r) => {
      const f = PDF_LOCAL[r.request().url().split("/").pop()];
      r.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(f) });
    });
  }
  await page.addInitScript(installFakes, { missing, delay, maxCount, limitsDelay });
  await page.goto(BASE);
  if (wait) await page.waitForFunction(() => document.getElementById("noteConnecting").hidden === true, null, { timeout: 8000 });
  page.__errors = errors; page.__ctx = ctx;
  return page;
}
const fake = (page, fn, arg) => page.evaluate(fn, arg);
const waitFor = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout });
async function check(name, fn) {
  try { const r = await fn(); if (r && r.skip) record(name, "skip", r.skip); else record(name, "pass", (r && r.note) || ""); }
  catch (e) { record(name, "fail", String((e && e.message) || e).split("\n")[0]); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const noErrors = (page) => assert(page.__errors.length === 0, "console/page errors: " + page.__errors.join(" | "));
const sendTyped = async (page, text) => { await page.fill("#msg", text); await page.press("#msg", "Enter"); };
const textOf = (page) => page.evaluate(() => document.getElementById("transcript").textContent);
const speaking = (page) => waitFor(page, () => /^Speaking/.test(document.getElementById("floorLabel").textContent), null, 10000);
const LONG = "Well, here is a long answer that keeps going for quite a while. And then some more words follow it.";
async function assertCalls(page) {
  const calls = await fake(page, () => window.__fake.calls);
  assert(calls.length > 0, "no model calls were made");
  for (const c of calls) {
    assert(c.cache === false, "a model call was not made with cache:false");
    const m = c.messages;
    assert(m[0].role === "user" && m[m.length - 1].role === "user", "messages do not start and end on a user turn");
  }
}
const cutOff = (page) => waitFor(page, () => !!document.querySelector(".turn.assistant .tag.cut"), null, 5000);

// 1
await check("1 loads with no console errors and shows the empty state", async () => {
  const page = await newPage();
  assert(await page.locator("#empty").isVisible(), "empty state not visible");
  assert((await page.locator("#empty li").count()) === 3, "empty state should have three lines");
  noErrors(page);
  await page.__ctx.close();
});

// 2
await check("2 floor click starts dictation; speech + pause gives spoken reply and both turns", async () => {
  const page = await newPage();
  await fake(page, () => { window.__fake.replies.push("Good point, I agree with you there."); });
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  assert((await fake(page, () => window.__fake.noGesture)) === 0, "dictation.start was called outside the gesture");
  await waitFor(page, () => document.getElementById("floorLabel").textContent === "Listening");
  await fake(page, () => window.__fake.say.partial("Coffee is better than"));
  assert((await page.locator("#partialLine").innerText()).includes("Coffee"), "partial line not shown");
  await fake(page, () => window.__fake.say.final("Coffee is better than tea"));
  await waitFor(page, () => window.__fake.spoken.length > 0, null, 10000);
  assert((await fake(page, () => window.__fake.spoken.join(" "))).includes("Good point"), "reply not spoken");
  assert((await page.locator(".turn.user .say").first().innerText()).includes("Coffee is better than tea"), "user turn missing");
  assert((await page.locator(".turn.assistant .say").first().innerText()).includes("Good point"), "assistant turn missing");
  await waitFor(page, () => /^Your turn/.test(document.getElementById("floorLabel").textContent));
  await assertCalls(page); noErrors(page);
  await page.__ctx.close();
});

// 3: real focus flows, no blur
async function startSpeakingByVoice(page) {
  await fake(page, (r) => { window.__fake.autoFinish = false; window.__fake.replies.push(r); }, LONG);
  await page.click("#floor"); // the click leaves the floor button focused in a naive page
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, () => window.__fake.say.final("Tell me something"));
  await speaking(page);
  await page.waitForTimeout(150);
}
await check("3a click floor, then Space while speaking cuts off", async () => {
  const page = await newPage();
  await startSpeakingByVoice(page);
  assert(await page.locator("#stopBtn").isVisible(), "Stop not visible while speaking");
  await page.keyboard.press("Space");
  await waitFor(page, () => window.__fake.dictationStarts === 2);
  await cutOff(page);
  assert((await fake(page, () => window.__fake.ttsStops)) >= 1, "voice was not stopped");
  noErrors(page); await page.__ctx.close();
});
await check("3b click Send, then Space while speaking cuts off", async () => {
  const page = await newPage();
  await fake(page, (r) => { window.__fake.autoFinish = false; window.__fake.replies.push(r); }, LONG);
  await page.fill("#msg", "typed question");
  await page.click("#sendBtn");
  await speaking(page); await page.waitForTimeout(150);
  await page.keyboard.press("Space");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await cutOff(page);
  noErrors(page); await page.__ctx.close();
});
await check("3c Enter in the text box, then Space while speaking cuts off", async () => {
  const page = await newPage();
  await fake(page, (r) => { window.__fake.autoFinish = false; window.__fake.replies.push(r); }, LONG);
  await sendTyped(page, "typed question");
  await speaking(page); await page.waitForTimeout(150);
  assert(!(await page.evaluate(() => document.activeElement && document.activeElement.id === "msg")), "text box kept focus after Enter");
  await page.keyboard.press("Space");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await cutOff(page);
  noErrors(page); await page.__ctx.close();
});
await check("3d Space with the New conversation confirm open does not clear the conversation", async () => {
  const page = await newPage();
  await sendTyped(page, "keep me");
  await waitFor(page, () => /Fair enough/.test(document.getElementById("transcript").textContent), null, 10000);
  await page.click("#newBtn");
  assert(await page.locator("#confirmRow").isVisible(), "confirm row not shown");
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  assert(/keep me/.test(await textOf(page)), "conversation was cleared by Space");
  noErrors(page); await page.__ctx.close();
});
await check("3e Space inside the text box types a space and does not take the floor; label does not promise Space there", async () => {
  const page = await newPage();
  await startSpeakingByVoice(page);
  await page.click("#msg");
  await page.keyboard.type("a b");
  assert((await page.inputValue("#msg")) === "a b", "space not typed");
  assert((await fake(page, () => window.__fake.dictationStarts)) === 1, "Space in the text box took the floor");
  await waitFor(page, () => /^Speaking/.test(document.getElementById("floorLabel").textContent) && !/Space/.test(document.getElementById("floorLabel").textContent), null, 3000)
    .catch(async () => { throw new Error("label promises Space while the box has focus: " + await page.locator("#floorLabel").innerText()); });
  noErrors(page); await page.__ctx.close();
});

// 4, 5
await check("4 <show> code renders on screen and is not spoken", async () => {
  const page = await newPage();
  await fake(page, () => { window.__fake.replies.push("Here is the snippet, it prints one word.\n<show>\n```js\nconsole.log(\"PINEAPPLE\");\n```\nUse `console.log` for output.\n</show>"); });
  await sendTyped(page, "show me code");
  await waitFor(page, () => { const p = document.querySelector(".codeblock pre"); return !!p && p.textContent.includes("PINEAPPLE"); }, null, 10000);
  await waitFor(page, () => !!document.querySelector(".show code.inline"), null, 10000);
  assert((await page.locator(".show code.inline").first().innerText()) === "console.log", "inline code not rendered");
  await waitFor(page, () => window.__fake.spoken.length > 0);
  const spoken = await fake(page, () => window.__fake.spoken.join(" "));
  assert(!spoken.includes("PINEAPPLE") && !/show>/.test(spoken), "code was spoken: " + spoken);
  assert(spoken.includes("Here is the snippet"), "spoken part missing");
  await assertCalls(page); noErrors(page);
  await page.__ctx.close();
});
await check("5 a typed message gets a reply and the box clears", async () => {
  const page = await newPage();
  await fake(page, () => { window.__fake.replies.push("Typed answer received."); });
  await sendTyped(page, "hello typed");
  await waitFor(page, () => /Typed answer received/.test(document.getElementById("transcript").textContent), null, 10000);
  assert((await page.locator(".turn.user .tag", { hasText: "typed" }).count()) === 1, "typed tag missing");
  assert((await page.inputValue("#msg")) === "", "box not cleared");
  assert((await fake(page, () => window.__fake.dictationStarts)) === 0, "typing started the mic");
  await assertCalls(page); noErrors(page);
  await page.__ctx.close();
});

// 6
await check("6 uploads: text, PDF, image reach the model; image sent in one reply ask", async () => {
  const missingFx = ["notes.txt", "sample.pdf", "pixel.png"].filter((n) => !fs.existsSync(FX(n)));
  if (missingFx.length) return { skip: "fixtures missing: " + missingFx.join(", ") };
  const page = await newPage();
  await page.setInputFiles("#fileInput", FX("notes.txt"));
  await waitFor(page, () => document.querySelectorAll(".chip").length === 1);
  await page.setInputFiles("#fileInput", FX("pixel.png"));
  await waitFor(page, () => document.querySelectorAll(".chip").length === 2);
  if (havePdfjs) {
    await page.setInputFiles("#fileInput", FX("sample.pdf"));
    await waitFor(page, () => document.querySelectorAll(".chip").length === 3, null, 20000);
  }
  await fake(page, () => { window.__fake.replies.push("Got your files."); window.__fake.replies.push("Second answer."); });
  await sendTyped(page, "what do the files say?");
  await waitFor(page, () => /Got your files/.test(document.getElementById("transcript").textContent), null, 10000);
  await waitFor(page, () => /^Your turn/.test(document.getElementById("floorLabel").textContent), null, 10000);
  await sendTyped(page, "and again?");
  await waitFor(page, () => /Second answer/.test(document.getElementById("transcript").textContent), null, 10000);
  const calls = await fake(page, () => window.__fake.calls);
  const prompts = JSON.stringify(calls.map((c) => c.messages));
  assert(prompts.includes("PELICAN-7421"), "PELICAN-7421 not sent");
  if (havePdfjs) assert(prompts.includes("HERON-3308"), "HERON-3308 from the PDF not sent");
  const isDescribe = (c) => /describ/i.test(c.messages[c.messages.length - 1].content);
  const replyWithImage = calls.filter((c) => c.images.length && !isDescribe(c));
  assert(calls.some((c) => c.images.length && isDescribe(c)), "no describe ask carried the image");
  assert(replyWithImage.length === 1 && replyWithImage[0].images[0].size > 0, "image blob must be in exactly one reply ask, got " + replyWithImage.length);
  await assertCalls(page); noErrors(page);
  await page.__ctx.close();
  if (!havePdfjs) return { skip: "text and image parts passed; PDF part skipped, local pdf.js files missing in " + PDFJS_DIR };
});

// 7
for (const cap of ["dictation", "tts", "sample"]) {
  await check(`7 ${cap} missing shows its fallback`, async () => {
    const page = await newPage({ missing: [cap] });
    if (cap === "dictation") {
      assert(await page.locator("#noteNoDict").isVisible(), "no-mic note missing");
      assert(!(await page.locator("#floor").isVisible()), "floor control should be hidden");
      await fake(page, () => { window.__fake.replies.push("Typing works."); });
      await sendTyped(page, "hi");
      await waitFor(page, () => /Typing works/.test(document.getElementById("transcript").textContent), null, 8000);
    } else if (cap === "tts") {
      assert(await page.locator("#noteNoTts").isVisible(), "no-voice note missing");
      await fake(page, () => { window.__fake.replies.push("Text only reply."); });
      await sendTyped(page, "hi");
      await waitFor(page, () => /Text only reply/.test(document.getElementById("transcript").textContent), null, 8000);
      assert((await fake(page, () => window.__fake.spoken.length)) === 0, "spoke without tts");
    } else {
      assert(await page.locator("#bannerNoSample").isVisible(), "no-sample banner missing");
      assert(await page.locator("#sendBtn").isDisabled() && await page.locator("#attachBtn").isDisabled() && await page.locator("#msg").isDisabled(), "Send/Attach/box should be blocked");
      assert(await page.locator("#floor").isDisabled(), "floor control should be disabled");
      await page.setInputFiles("#fileInput", FX("notes.txt")).catch(() => {});
      await page.waitForTimeout(200);
      assert((await page.locator(".chip").count()) === 0, "a file was attached without Claude");
    }
    noErrors(page);
    await page.__ctx.close();
  });
}

// 9 connecting phase
await check("9a message typed while connecting is sent once ready; files queued; notice removed", async () => {
  const page = await newPage({ delay: 700, wait: false });
  await fake(page, () => { window.__fake.replies.push("Connected answer."); });
  await page.fill("#msg", "early message");
  await page.click("#sendBtn");
  assert(/Still connecting/.test(await page.locator("#notices").innerText()), "no connecting notice");
  await page.setInputFiles("#fileInput", FX("notes.txt"));
  assert(!/unavailable|isn't available/.test(await page.locator("#notices").innerText()), "said attachments are unavailable while connecting");
  await waitFor(page, () => /Connected answer/.test(document.getElementById("transcript").textContent), null, 10000);
  assert((await page.inputValue("#msg")) === "", "box not cleared after the pending send");
  assert(!/Still connecting/.test(await page.locator("#notices").innerText()), "connecting notice not removed");
  await waitFor(page, () => document.querySelectorAll(".chip").length === 1);
  const calls = await fake(page, () => window.__fake.calls);
  const forMsg = calls.filter((c) => JSON.stringify(c.messages[c.messages.length - 1]).includes("early message"));
  assert(forMsg.length > 0, "no model call for the queued message");
  assert(forMsg.every((c) => JSON.stringify(c.messages).includes("PELICAN-7421")), "queued file's text was not in the call for the queued message");
  noErrors(page); await page.__ctx.close();
});
await check("9b message typed while connecting, then sample is null: text kept, banner shown", async () => {
  const page = await newPage({ delay: 500, wait: false, missing: ["sample"] });
  await page.fill("#msg", "early message");
  await page.click("#sendBtn");
  await waitFor(page, () => document.getElementById("bannerNoSample").hidden === false, null, 8000);
  assert(!/Still connecting/.test(await page.locator("#notices").innerText()), "connecting notice not removed");
  assert((await page.inputValue("#msg")) === "early message", "typed text was lost");
  noErrors(page); await page.__ctx.close();
});

// 10 blocked voice
await check("10 platform Stop then no_gesture shows Turn voice back on; clicking speaks the last reply", async () => {
  const page = await newPage();
  await fake(page, () => { window.__fake.autoFinish = false; window.__fake.replies.push("First long reply that goes on a while. More here."); window.__fake.replies.push("Second reply to be read again."); });
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, () => window.__fake.say.final("Say something"));
  await speaking(page); await page.waitForTimeout(150);
  await fake(page, () => window.__fake.platformStop());
  await waitFor(page, () => /^Your turn/.test(document.getElementById("floorLabel").textContent), null, 5000);
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 2);
  await fake(page, () => window.__fake.say.final("And another thing"));
  await waitFor(page, () => document.getElementById("resumeBox").hidden === false, null, 10000);
  assert(/Second reply/.test(await textOf(page)), "reply not shown as text while blocked");
  assert(/Turn voice back on/.test(await page.locator("#resumeBtn").innerText()), "button text");
  assert(/voice/i.test(await page.locator("#notices").innerText()), "no voice notice");
  assert(!/DEVMSG/.test(await page.locator("#notices").innerText()), "developer message shown");
  await page.screenshot({ path: path.join(SHOTS, "light-1280-voice-blocked.png") });
  const before = await fake(page, () => window.__fake.spoken.length);
  await page.click("#resumeBtn");
  await waitFor(page, (n) => window.__fake.spoken.length > n, before, 5000);
  assert((await fake(page, () => window.__fake.spoken.slice(-1)[0])).includes("Second reply"), "did not speak the last reply");
  await waitFor(page, () => document.getElementById("resumeBox").hidden === true, null, 5000);
  noErrors(page); await page.__ctx.close();
});

// 11 mic error
await check("11 dictation start rejecting upstream_error keeps the floor control and shows plain words", async () => {
  const page = await newPage();
  await fake(page, () => { window.__fake.dictationFail = "upstream_error"; });
  await page.click("#floor");
  await waitFor(page, () => /microphone/i.test(document.getElementById("notices").textContent), null, 5000);
  const n = await page.locator("#notices").innerText();
  assert(!/DEVMSG|upstream/i.test(n), "platform wording leaked: " + n);
  assert(await page.locator("#floor").isVisible() && !(await page.locator("#floor").isDisabled()), "floor control gone after a passing mic error");
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 2);
  await waitFor(page, () => document.getElementById("floorLabel").textContent === "Listening");
  noErrors(page); await page.__ctx.close();
});

// 12 not_granted
await check("12 sample rejecting not_granted: reload advice, no open-in-Chrome banner", async () => {
  const page = await newPage();
  await fake(page, () => { window.__fake.sampleError = "not_granted"; });
  await sendTyped(page, "hello");
  await waitFor(page, () => /Reload the page/i.test(document.getElementById("notices").textContent), null, 8000);
  const n = await page.locator("#notices").innerText();
  assert(/allowed/i.test(n) && !/DEVMSG/.test(n), "wrong notice: " + n);
  assert(await page.locator("#bannerNoSample").isHidden(), "open-in-Chrome banner shown for not_granted");
  assert(await page.locator("#sendBtn").isDisabled(), "Send should be disabled");
  noErrors(page); await page.__ctx.close();
});

// 13 images
await check("13 image maxCount is enforced and duplicates are refused", async () => {
  const page = await newPage({ maxCount: 1 });
  const buf = fs.readFileSync(FX("pixel.png"));
  await page.setInputFiles("#fileInput", [{ name: "a.png", mimeType: "image/png", buffer: buf }, { name: "b.png", mimeType: "image/png", buffer: buf }]);
  await waitFor(page, () => /up to 1 image/.test(document.getElementById("notices").textContent), null, 8000);
  assert((await page.locator(".chip").count()) === 1, "more images than maxCount were accepted");
  await page.setInputFiles("#fileInput", FX("notes.txt"));
  await waitFor(page, () => document.querySelectorAll(".chip").length === 2);
  await page.setInputFiles("#fileInput", FX("notes.txt"));
  await waitFor(page, () => /already attached/.test(document.getElementById("notices").textContent), null, 5000);
  assert((await page.locator(".chip").count()) === 2, "duplicate file was added");
  noErrors(page); await page.__ctx.close();
});

// 14 voice block + reset
await check("14 New conversation while the voice is blocked keeps the button, and it works", async () => {
  const page = await newPage();
  await fake(page, () => { window.__fake.blocked = true; window.__fake.replies.push("Reply one stays text."); });
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, () => window.__fake.say.final("Please answer"));
  await waitFor(page, () => document.getElementById("resumeBox").hidden === false, null, 10000);
  await waitFor(page, () => !document.getElementById("resumeBtn").disabled, null, 5000);
  await page.click("#newBtn"); await page.click("#confirmYes");
  await page.waitForTimeout(200);
  assert(await page.locator("#resumeBtn").isVisible(), "button vanished after New conversation");
  assert(!(await page.locator("#resumeBtn").isDisabled()), "button disabled after reset while idle");
  const before = await fake(page, () => window.__fake.spoken.length);
  await page.click("#resumeBtn");
  await waitFor(page, (n) => window.__fake.spoken.length > n, before, 5000);
  await waitFor(page, () => document.getElementById("resumeBox").hidden === true, null, 5000);
  noErrors(page); await page.__ctx.close();
});
await check("15 Turn voice back on is shown disabled with a note while listening", async () => {
  const page = await newPage({ width: 400, height: 820, scheme: "light" });
  await fake(page, () => { window.__fake.blocked = true; window.__fake.replies.push("Text only."); });
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, () => window.__fake.say.final("Answer me"));
  await waitFor(page, () => document.getElementById("resumeBox").hidden === false && !document.getElementById("resumeBtn").disabled, null, 10000);
  await page.click("#floor");
  await waitFor(page, () => document.getElementById("resumeBtn").disabled, null, 5000);
  assert(/your turn/i.test(await page.locator("#resumeNote").innerText()), "no explanatory line");
  await page.screenshot({ path: path.join(SHOTS, "light-400-voice-disabled.png") });
  noErrors(page); await page.__ctx.close();
});

// 16 settings overlay
await check("16 Settings at 400px leaves floor control and Stop reachable; Escape closes; focus returns", async () => {
  const page = await newPage({ width: 400, height: 820 });
  await fake(page, (r) => { window.__fake.autoFinish = false; window.__fake.replies.push(r); }, LONG);
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, () => window.__fake.say.final("Tell me something"));
  await speaking(page); await page.waitForTimeout(150);
  await page.click("#settingsBtn");
  assert(await page.evaluate(() => document.activeElement.id) === "closeSettings", "focus did not move into the panel");
  const top = await page.evaluate(() => {
    const hit = (id) => { const r = document.getElementById(id).getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!e && (e.id === id || document.getElementById(id).contains(e)); };
    return { floor: hit("floor"), stop: hit("stopBtn"), msg: hit("msg") };
  });
  assert(top.floor && top.stop, "panel covers the floor control or Stop: " + JSON.stringify(top));
  await page.screenshot({ path: path.join(SHOTS, "light-400-settings-speaking.png") });
  await page.keyboard.press("Escape");
  assert(await page.locator("#rail").isHidden(), "Escape did not close the panel");
  assert(await page.evaluate(() => document.activeElement.id) === "settingsBtn", "focus did not return to the Settings button");
  noErrors(page); await page.__ctx.close();
});

// 17 stale key-up
await check("17 a Space key-down with no key-up does not break a later Space on a Tab-focused Stop", async () => {
  const page = await newPage();
  await fake(page, (r) => { window.__fake.autoFinish = false; window.__fake.replies.push(r); }, LONG);
  await sendTyped(page, "question");
  await speaking(page); await page.waitForTimeout(150);
  await page.keyboard.down("Space"); // takes the floor; key-up never delivered
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  // Claude speaks again; reach Stop with Tab and press Space
  await fake(page, (r) => { window.__fake.replies.push(r); }, LONG);
  await sendTyped(page, "another");
  await speaking(page); await page.waitForTimeout(150);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement.id);
  let guard = 0, id = focused; const seq = [focused];
  while (id !== "stopBtn" && guard++ < 40) { await page.keyboard.press("Tab"); id = await page.evaluate(() => document.activeElement.id); seq.push(id); }
  assert(id === "stopBtn", "could not Tab to Stop (seq " + seq.join(">") + ", label " + await page.locator("#floorLabel").innerText() + ", stop visible " + await page.locator("#stopBtn").isVisible() + ")");
  const before = await fake(page, () => window.__fake.ttsStops);
  await page.keyboard.press("Space");
  await waitFor(page, (n) => window.__fake.ttsStops > n, before, 3000);
  noErrors(page); await page.__ctx.close();
});

// 18 label follows Space rule
await check("18 label does not promise Space when focus is in the Topic field", async () => {
  const page = await newPage();
  await page.click("#setTopic");
  await waitFor(page, () => !/Space/.test(document.getElementById("floorLabel").textContent), null, 3000)
    .catch(async () => { throw new Error("label promises Space in Topic field: " + await page.locator("#floorLabel").innerText()); });
  await page.evaluate(() => document.activeElement.blur());
  await waitFor(page, () => /Space/.test(document.getElementById("floorLabel").textContent), null, 3000)
    .catch(async () => { throw new Error("label lost the Space hint after blur: " + await page.locator("#floorLabel").innerText()); });
  await page.click("#setTopic");
  await page.keyboard.type("a b");
  assert((await page.inputValue("#setTopic")) === "a b", "space not typed in Topic");
  assert((await fake(page, () => window.__fake.dictationStarts)) === 0, "Space in Topic took the floor");
  noErrors(page); await page.__ctx.close();
});

// 19 prompt_trimmed wording
await check("19 a too-large prompt gets its own notice, not the reply-failed wording", async () => {
  const page = await newPage();
  await page.setInputFiles("#fileInput", { name: "big.txt", mimeType: "text/plain", buffer: Buffer.from("x".repeat(170000)) });
  await waitFor(page, () => document.querySelectorAll(".chip").length === 1);
  await page.fill("#msg", "y".repeat(120000));
  await page.press("#msg", "Enter");
  await waitFor(page, () => /too large to send in full/.test(document.getElementById("notices").textContent), null, 8000);
  const n = await page.locator("#notices").innerText();
  assert(!/Something went wrong getting Claude's reply/.test(n), "reply-failed wording used: " + n);
  assert(/some attached text was left out/.test(n), "wording missing: " + n);
  noErrors(page); await page.__ctx.close();
});

// 20 notice appearing while Settings is open
await check("20 a notice appearing while Settings is open at 400px is not covered by the panel", async () => {
  const page = await newPage({ width: 400, height: 820 });
  await page.click("#settingsBtn");
  await page.setInputFiles("#fileInput", { name: "x.bin", mimeType: "application/octet-stream", buffer: Buffer.from("abc") });
  await waitFor(page, () => !!document.querySelector(".notice"), null, 5000);
  await page.waitForTimeout(100);
  const ok = await page.evaluate(() => {
    const n = document.querySelector(".notice"); const r = n.getBoundingClientRect();
    const e = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(8, r.height / 2));
    const rail = document.getElementById("rail").getBoundingClientRect();
    return { hit: !!e && n.contains(e), overlap: rail.top < r.bottom - 1 };
  });
  assert(ok.hit && !ok.overlap, "panel covers the notice: " + JSON.stringify(ok));
  noErrors(page); await page.__ctx.close();
});

// 21 Enter twice while queued files attach
await check("21 Enter pressed twice while queued files are attaching sends one message, after the files", async () => {
  const page = await newPage({ delay: 300, limitsDelay: 900, wait: false });
  await fake(page, () => { window.__fake.replies.push("Both arrived."); });
  await page.fill("#msg", "queued message");
  await page.setInputFiles("#fileInput", [FX("pixel.png"), FX("notes.txt")]);
  await waitFor(page, () => document.getElementById("noteConnecting").hidden === true, null, 8000);
  await page.press("#msg", "Enter");
  await page.press("#msg", "Enter");
  await waitFor(page, () => /Both arrived/.test(document.getElementById("transcript").textContent), null, 10000);
  await page.waitForTimeout(300);
  const calls = await fake(page, () => window.__fake.calls);
  const msgCalls = calls.filter((c) => JSON.stringify(c.messages[c.messages.length - 1]).includes("queued message"));
  assert(msgCalls.length === 1, "expected exactly one call for the message, got " + msgCalls.length);
  assert(JSON.stringify(msgCalls[0].messages).includes("PELICAN-7421"), "file text missing from the message call");
  assert((await page.locator(".turn.user .say", { hasText: "queued message" }).count()) === 1, "message not shown exactly once");
  assert((await page.locator(".chip").count()) === 2, "both files should be attached");
  noErrors(page); await page.__ctx.close();
});

// 22 removing a chip forgets the duplicate key
await check("22 a removed file can be attached again", async () => {
  const page = await newPage();
  await page.setInputFiles("#fileInput", FX("notes.txt"));
  await waitFor(page, () => document.querySelectorAll(".chip").length === 1);
  await page.click(".chip button");
  await waitFor(page, () => document.querySelectorAll(".chip").length === 0);
  await page.setInputFiles("#fileInput", FX("notes.txt"));
  await waitFor(page, () => document.querySelectorAll(".chip").length === 1, null, 3000);
  assert(!/already attached/.test(await page.locator("#notices").innerText()), "refused as duplicate after removal");
  noErrors(page); await page.__ctx.close();
});

// 23-30 the listener rework
const listeningLabel = (page) => waitFor(page, () => document.getElementById("floorLabel").textContent === "Listening", null, 10000);
const W = (n, from = 1) => Array.from({ length: n }, (_, i) => "word" + (from + i)).join(" ");
const kinds = (page) => fake(page, () => window.__fake.calls.map((c) => c.kind));
await check("23 live guesses with no final start a listening step and the notes strip updates", async () => {
  const page = await newPage();
  assert((await page.locator("#notesStrip").isVisible()), "notes strip missing");
  await fake(page, () => { window.__fake.script.listen.push("<notes>He claims word1 equals word2.</notes>"); });
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await listeningLabel(page);
  assert(/Listening/.test(await page.locator("#notesText").innerText()), "empty notes state missing");
  await fake(page, (t) => window.__fake.say.partial(t), W(7));
  await page.waitForTimeout(400);
  assert(!(await kinds(page)).includes("listen"), "a step ran before 8 words");
  await fake(page, (t) => window.__fake.say.partial(t), W(8));
  await waitFor(page, () => window.__fake.calls.some((c) => c.kind === "listen"), null, 5000);
  await waitFor(page, () => /He claims/.test(document.getElementById("notesText").textContent), null, 5000);
  assert((await fake(page, () => window.__fake.spoken.length)) === 0, "a notes step was spoken");
  assert((await page.locator(".turn.assistant").count()) === 0, "a notes step added a turn");
  const call = (await fake(page, () => window.__fake.calls)).find((c) => c.kind === "listen");
  assert(call.tier === "quick", "listening step must use the quick tier");
  noErrors(page); await page.__ctx.close();
});

await check("24 a scripted cut-in stops the mic, plays the tone, marks the turn and speaks the stopper first", async () => {
  const page = await newPage();
  await fake(page, () => { window.__fake.script.listen.push("Stop. That's wrong. Fourier transforms power every phone call. Where do you think your music files come from?"); });
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await listeningLabel(page);
  await page.evaluate(() => { const el = document.getElementById("floorLabel"); window.__seen = []; new MutationObserver(() => window.__seen.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); });
  await fake(page, (t) => window.__fake.say.partial(t), W(10));
  await waitFor(page, () => window.__fake.dictationStops >= 1, null, 8000);
  await waitFor(page, () => window.__fake.spoken.length > 0, null, 8000);
  assert((await fake(page, () => window.__fake.tones)) >= 2, "the two-note tone was not played");
  assert((await fake(page, () => window.__fake.audioCtxs)) === 1, "AudioContext should be created once");
  assert(/^Stop\./.test(await fake(page, () => window.__fake.spoken[0])), "stopper not spoken first: " + await fake(page, () => window.__fake.spoken[0]));
  assert((await page.locator(".turn.user .tag", { hasText: "Claude cut in" }).count()) === 1, "user turn not marked as cut in");
  assert((await page.evaluate(() => window.__seen)).includes("Claude is cutting in"), "floor label never showed the cut-in state");
  noErrors(page); await page.__ctx.close();
});
await check("25 the cut-in sound can be turned off", async () => {
  const page = await newPage();
  await page.uncheck("#setSound");
  await fake(page, () => { window.__fake.script.listen.push("Stop. That is wrong. Here is why."); });
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, (t) => window.__fake.say.partial(t), W(9));
  await waitFor(page, () => window.__fake.spoken.length > 0, null, 8000);
  assert((await fake(page, () => window.__fake.tones)) === 0, "tone played with the setting off");
  noErrors(page); await page.__ctx.close();
});
await check("26 listen mode: no reply after a pause; Your take asks for one", async () => {
  const page = await newPage();
  await page.selectOption("#setMode", "listen");
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await listeningLabel(page);
  assert(/Your take/.test(await page.locator("#floorHint").innerText()), "listen-mode hint missing");
  await fake(page, () => window.__fake.say.final("just a short statement here"));
  await waitFor(page, () => window.__fake.calls.some((c) => c.kind === "monitor"), null, 8000);
  await page.waitForTimeout(800);
  assert((await page.locator(".turn.assistant").count()) === 0, "listen mode replied after a pause");
  assert((await page.locator(".turn.user").count()) >= 1, "the quiet utterance was not committed");
  await waitFor(page, () => !document.getElementById("takeBtn").hidden, null, 3000);
  await fake(page, () => { window.__fake.replies.push("Here is my view now."); });
  await page.click("#takeBtn");
  await waitFor(page, () => /Here is my view now/.test(document.getElementById("transcript").textContent), null, 8000);
  assert((await kinds(page)).includes("forced"), "Your take did not make a forced ask");
  noErrors(page); await page.__ctx.close();
});
await check("27b reply-after-silence setting: default, persistence, reaches the engine", async () => {
  let page = await newPage();
  assert((await page.inputValue("#setPause")) === "0.5", "default not 0.5");
  assert((await page.locator("#setPauseVal").innerText()) === "0.5 s", "label");
  assert(/How long you stay quiet before Claude answers/.test(await page.locator("#pauseHelp").innerText()), "help note");
  // default 0.5 s: a short utterance gets a paused ask well before 1.5 s
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, () => window.__fake.say.final("am I audible to you"));
  await waitFor(page, () => window.__fake.calls.some((c) => c.kind === "paused"), null, 1400);
  await page.__ctx.close();
  // 3 s: no ask after 1.5 s; the setting persists across a reload
  page = await newPage();
  await page.locator("#setPause").evaluate((el) => { el.value = "3"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  assert((await page.locator("#setPauseVal").innerText()) === "3 s", "label after change");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("noteConnecting").hidden === true, null, { timeout: 8000 });
  assert((await page.inputValue("#setPause")) === "3", "pause not remembered");
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, () => window.__fake.say.final("am I audible to you"));
  await page.waitForTimeout(1500);
  assert(!(await fake(page, () => window.__fake.calls.some((c) => c.kind === "paused"))), "asked before the longer pause");
  noErrors(page); await page.__ctx.close();
});
await check("27c listen mode: a one-time note appears after the first quiet monitor step", async () => {
  const page = await newPage();
  await page.selectOption("#setMode", "listen");
  assert(/checks whether to answer/.test(await page.locator("#pauseHelp").innerText()), "listen help note");
  assert(await page.locator("#listenNote").isHidden(), "note visible too early");
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, () => window.__fake.say.final("just a short statement here"));
  await waitFor(page, () => !document.getElementById("listenNote").hidden, null, 8000);
  assert(/^Listen and correct mode: Claude only speaks when you're wrong/.test(await page.locator("#listenNoteText").innerText()), "note text");
  await page.click("#listenNoteX");
  assert(await page.locator("#listenNote").isHidden(), "not dismissed");
  const n = await fake(page, () => window.__fake.calls.filter((c) => c.kind === "monitor").length);
  await fake(page, () => window.__fake.say.final("and another statement follows"));
  await waitFor(page, (k) => window.__fake.calls.filter((c) => c.kind === "monitor").length > k, n, 8000);
  await page.waitForTimeout(300);
  assert(await page.locator("#listenNote").isHidden(), "note came back");
  noErrors(page); await page.__ctx.close();
});
await check("27 each new setting reaches the engine", async () => {
  // listen every
  let page = await newPage();
  await page.locator("#setListen").evaluate((el) => { el.value = "4"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, (t) => window.__fake.say.partial(t), W(4));
  await waitFor(page, () => window.__fake.calls.some((c) => c.kind === "listen"), null, 5000);
  await page.__ctx.close();
  // strict every
  page = await newPage();
  await page.locator("#setStrict").evaluate((el) => { el.value = "10"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  assert((await page.locator("#setStrictVal").innerText()) === "10 words", "strict label");
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, (t) => window.__fake.say.partial(t), W(10));
  await waitFor(page, () => window.__fake.calls.some((c) => c.kind === "strict"), null, 5000);
  await page.__ctx.close();
  // tone: the standing rules differ between polite and rough
  const rules = [];
  for (const tone of ["polite", "rough"]) {
    page = await newPage();
    await page.selectOption("#setTone", tone);
    await page.click("#floor");
    await waitFor(page, () => window.__fake.dictationStarts === 1);
    await fake(page, (t) => window.__fake.say.partial(t), W(8));
    await waitFor(page, () => window.__fake.calls.some((c) => c.kind === "listen"), null, 5000);
    rules.push((await fake(page, () => window.__fake.calls.find((c) => c.kind === "listen").messages[0].content)));
    await page.__ctx.close();
  }
  assert(rules[0] !== rules[1], "tone did not change the standing rules");
  // mode and the notes toggle persist across a reload
  page = await newPage();
  await page.selectOption("#setMode", "listen");
  await page.click("#notesToggle");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("noteConnecting").hidden === true, null, { timeout: 8000 });
  assert((await page.inputValue("#setMode")) === "listen", "mode not remembered");
  assert(await page.locator("#notesText").isHidden(), "notes toggle not remembered");
  noErrors(page); await page.__ctx.close();
});
await check("28 the notes strip does not move the floor control as the text changes", async () => {
  for (const width of [1280, 400]) {
    const page = await newPage({ width, height: 820 });
    await fake(page, () => { window.__fake.script.listen.push("<notes>" + "He keeps repeating the same shaky claim about word1 and word2. ".repeat(12) + "</notes>"); });
    await page.click("#floor");
    await waitFor(page, () => window.__fake.dictationStarts === 1);
    await listeningLabel(page);
    const before = await page.evaluate(() => ({ f: document.getElementById("floor").getBoundingClientRect().top, c: document.getElementById("msg").getBoundingClientRect().top, n: document.getElementById("notesStrip").getBoundingClientRect().height }));
    await fake(page, (t) => window.__fake.say.partial(t), W(8));
    await waitFor(page, () => /shaky claim/.test(document.getElementById("notesText").textContent), null, 5000);
    const after = await page.evaluate(() => ({ f: document.getElementById("floor").getBoundingClientRect().top, c: document.getElementById("msg").getBoundingClientRect().top, n: document.getElementById("notesStrip").getBoundingClientRect().height }));
    assert(before.f === after.f && before.c === after.c && before.n === after.n, `layout moved at ${width}px: ${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "horizontal scroll at " + width);
    noErrors(page); await page.__ctx.close();
  }
});
await check("29 debug log shows listen steps with the notes", async () => {
  const page = await newPage();
  await fake(page, () => { window.__fake.script.listen.push("<notes>some private thinking about word1</notes>"); });
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, (t) => window.__fake.say.partial(t), W(8));
  await waitFor(page, () => /some private thinking/.test(document.getElementById("log").textContent), null, 5000);
  assert(/listen/.test(await page.locator("#log").evaluate((e) => e.textContent)), "no listen row");
  noErrors(page); await page.__ctx.close();
});

// 8 layout and screenshots
async function populate(page, { listening = true } = {}) {
  await fake(page, () => { window.__fake.replies.push("Short answer first. The code is below.\n<show>\n```js\nconst longLine = \"this line is deliberately long so the code box has to scroll sideways instead of the page\";\nconsole.log(longLine);\n```\n- first point\n- second point with `inline code`\n</show>"); });
  await page.setInputFiles("#fileInput", FX("notes.txt")).catch(() => {});
  await sendTyped(page, "Show me how to print a long line, and explain it in a list.");
  await waitFor(page, () => !!document.querySelector(".codeblock pre"), null, 10000);
  await waitFor(page, () => /^Your turn/.test(document.getElementById("floorLabel").textContent), null, 10000);
  if (listening) {
    await page.click("#floor");
    await waitFor(page, () => window.__fake.dictationStarts >= 1);
    await fake(page, () => window.__fake.say.partial("And one more thing about that"));
  }
}
await check("8 no horizontal scroll at 400px; screenshots in light and dark", async () => {
  for (const scheme of ["light", "dark"]) {
    for (const width of [1280, 400]) {
      const page = await newPage({ width, height: width === 400 ? 820 : 800, scheme });
      await populate(page);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
      assert(m.sw <= m.cw && m.bw <= m.cw, `horizontal scroll at ${width}px (${JSON.stringify(m)})`);
      await page.screenshot({ path: path.join(SHOTS, `${scheme}-${width}-listening.png`) });
      if (width === 400) {
        const h0 = await page.locator("#transcript").evaluate((e) => e.clientHeight);
        await page.click("#settingsBtn");
        assert(await page.locator("#closeSettings").isVisible(), "settings overlay has no Close button");
        await page.screenshot({ path: path.join(SHOTS, `${scheme}-${width}-settings.png`) });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "horizontal scroll with settings open");
        await page.click("#closeSettings");
        const h1 = await page.locator("#transcript").evaluate((e) => e.clientHeight);
        assert(h0 === h1, `transcript height changed by settings (${h0} vs ${h1})`);
      }
      noErrors(page);
      await page.__ctx.close();
    }
  }
  const page = await newPage({ width: 1280, scheme: "light" });
  await fake(page, () => { window.__fake.autoFinish = false; window.__fake.replies.push("Here is my take, and I will defend it."); });
  await page.click("#floor");
  await waitFor(page, () => window.__fake.dictationStarts === 1);
  await fake(page, () => window.__fake.say.final("What do you think about it"));
  await speaking(page);
  await page.screenshot({ path: path.join(SHOTS, "light-1280-speaking.png") });
  await page.__ctx.close();
  // voice-blocked state at 400px dark
  const p2 = await newPage({ width: 400, height: 820, scheme: "dark" });
  await fake(p2, () => { window.__fake.blocked = true; window.__fake.replies.push("A reply that stays text only."); });
  await p2.click("#floor");
  await waitFor(p2, () => window.__fake.dictationStarts === 1);
  await fake(p2, () => window.__fake.say.final("Please answer me"));
  await waitFor(p2, () => document.getElementById("resumeBox").hidden === false, null, 10000);
  await p2.screenshot({ path: path.join(SHOTS, "dark-400-voice-blocked.png") });
  noErrors(p2); await p2.__ctx.close();
  return { note: "screenshots in " + SHOTS };
});

await browser.close();
server.close();
const failed = results.filter((r) => r.status === "fail").length;
const skipped = results.filter((r) => r.status === "skip").length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
