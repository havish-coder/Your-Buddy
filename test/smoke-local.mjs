// Smoke test for the localhost version: node server.js (with the fake claude program) + local/shim.js on top of
// fake webkitSpeechRecognition / speechSynthesis classes injected with page.addInitScript.
// Run from the project folder: node test/smoke-local.mjs
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = "/tmp/claude-0/-home-user/273c0c87-38b9-5800-970d-c86c6c4a3717/scratchpad/shots";
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- start the real server with the fake claude program ----------
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  cwd: ROOT, stdio: ["ignore", "ignore", "ignore"],
  env: { ...process.env, PORT: String(port), OPEN_FLOOR_CLAUDE_BIN: path.join(ROOT, "test/fixtures/fake-claude.mjs") },
});
const BASE = `http://127.0.0.1:${port}/`;
for (let i = 0; ; i++) {
  try { const r = await fetch(BASE + "api/health"); if (r.ok) break; } catch { /* not up yet */ }
  if (i > 100) { console.log("FAIL server did not start"); server.kill(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 100));
}

// ---------- fake speech recognition and synthesis, installed before the shim runs ----------
function installFakes(opts) {
  const F = (window.__fake = { recStarts: 0, recStartThrows: 0, recs: [], spoken: [], rates: [], cancels: 0, msPerChar: opts.msPerChar || 12, labels: [] });
  class FakeRec {
    constructor() { this.finals = []; this.running = false; this.dead = false; F.recs.push(this); }
    start() {
      if (F.nextStartThrows) { F.nextStartThrows--; F.recStartThrows++; throw new Error("InvalidStateError"); }
      F.recStarts++; this.running = true;
      setTimeout(() => { if (!this.dead && this.onstart) this.onstart({}); }, 5);
    }
    _end() { if (this.dead) return; this.dead = true; this.running = false; setTimeout(() => this.onend && this.onend({}), 5); }
    stop() { this._end(); }
    abort() { this.dead = true; this.running = false; }
  }
  window.webkitSpeechRecognition = FakeRec;
  const live = () => F.recs.filter((r) => r.running && !r.dead).pop();
  F.liveRecs = () => F.recs.filter((r) => r.running && !r.dead).length;
  F.say = {
    partial(text) { const r = live(); if (!r) return; r.onresult({ resultIndex: r.finals.length, results: [...r.finals, { isFinal: false, 0: { transcript: text } }] }); },
    final(text) { const r = live(); if (!r) return; const item = { isFinal: true, 0: { transcript: text } }; r.onresult({ resultIndex: r.finals.length, results: [...r.finals, item] }); r.finals.push(item); },
  };
  F.chromeEndsSession = () => { const r = live(); if (r) r._end(); };

  class Utt { constructor(text) { this.text = text; this.rate = 1; this.voice = null; this.lang = ""; } }
  window.SpeechSynthesisUtterance = Utt;
  const synth = {
    queue: [], cur: null, timer: null,
    speak(u) { synth.queue.push(u); if (!synth.cur) synth.run(); },
    run() {
      const u = synth.queue.shift();
      if (!u) { synth.cur = null; return; }
      synth.cur = u; F.spoken.push(u.text); F.rates.push(u.rate);
      setTimeout(() => { if (synth.cur === u && u.onstart) u.onstart({}); }, 5);
      synth.timer = setTimeout(() => { if (synth.cur !== u) return; synth.cur = null; u.onend && u.onend({}); synth.run(); }, Math.max(60, u.text.length * F.msPerChar / Math.max(0.5, u.rate)));
    },
    // like Chrome at its worst: cancel() fires no event at all
    cancel() { clearTimeout(synth.timer); synth.queue = []; synth.cur = null; F.cancels++; },
    getVoices() { return [{ name: "Test Voice", lang: "en-US" }, { name: "Other Voice", lang: "fr-FR" }]; },
    pause() {}, resume() {},
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  // record every change of the floor label, so "never left listening" can be asserted
  document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("floorLabel");
    if (!el) return;
    F.labels.push(el.textContent);
    new MutationObserver(() => F.labels.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
}

const browser = await chromium.launch();
const results = [];
const record = (name, status, detail = "") => { results.push({ name, status, detail }); console.log(`${status.toUpperCase().padEnd(5)} ${name}${detail ? " :: " + detail : ""}`); };
async function newPage({ width = 1280, height = 800, scheme = "light", msPerChar = 12, preset } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.addInitScript(installFakes, { msPerChar });
  if (preset) await (Array.isArray(preset) ? page.addInitScript(preset[0], preset[1]) : page.addInitScript(preset));
  await page.goto(BASE);
  await page.waitForFunction(() => document.getElementById("noteConnecting").hidden === true, null, { timeout: 8000 });
  page.__errors = errors; page.__ctx = ctx;
  return page;
}
const choose = (headphones) => ({ h: headphones, key: "openfloor.settings.v2" });
const presetHp = (o) => { localStorage.setItem(o.key, JSON.stringify({ headphones: o.h, headphonesChosen: true })); };
async function newChosen(headphones, opts = {}) {
  const ctx0 = choose(headphones);
  return newPage({ ...opts, preset: [presetHp, ctx0] });
}
const fake = (page, fn, arg) => page.evaluate(fn, arg);
const waitFor = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, arg, { timeout });
async function check(name, fn) {
  try { const r = await fn(); if (r && r.skip) record(name, "skip", r.skip); else record(name, "pass", (r && r.note) || ""); }
  catch (e) { record(name, "fail", String((e && e.message) || e).split("\n")[0]); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const noErrors = (page) => assert(page.__errors.length === 0, "console/page errors: " + page.__errors.join(" | "));
const label = (page) => page.locator("#floorLabel").innerText();
const speaking = (page) => waitFor(page, () => /^Speaking/.test(document.getElementById("floorLabel").textContent), null, 10000);
const listening = (page) => waitFor(page, () => document.getElementById("floorLabel").textContent === "Listening", null, 10000);
const cutTag = (page) => waitFor(page, () => !!document.querySelector(".turn.assistant .tag.cut"), null, 5000);
async function startAndAsk(page, said = "Tell me about the weather today") {
  await page.click("#floor");
  await waitFor(page, () => window.__fake.recStarts >= 1);
  await listening(page);
  await fake(page, (t) => window.__fake.say.final(t), said);
  await speaking(page);
}

await check("1 local page loads with the shim and no console errors", async () => {
  const page = await newPage();
  assert(await page.evaluate(() => !!(window.OPEN_FLOOR_LOCAL && window.OPEN_FLOOR_LOCAL.duplex)), "OPEN_FLOOR_LOCAL missing");
  assert(await page.locator("#empty").isVisible(), "empty state not shown");
  assert(/press space/i.test(await page.locator("#emptyThird").innerText()), "local empty-state wording missing");
  assert(await page.locator("#fieldHeadphones").isVisible(), "headphones setting hidden in local mode");
  noErrors(page); await page.__ctx.close();
});

await check("2 one click starts listening; a pause gives a spoken reply and listening carries on", async () => {
  const page = await newPage();
  await page.click("#floor");
  await waitFor(page, () => window.__fake.recStarts === 1);
  await listening(page);
  await fake(page, () => window.__fake.say.partial("Tell me about"));
  assert(/Tell me about/.test(await page.locator("#partialLine").innerText()), "partial not shown");
  await fake(page, () => window.__fake.say.final("Tell me about the weather today"));
  await waitFor(page, () => window.__fake.spoken.length > 0, null, 10000);
  assert(/Fake reply/.test((await fake(page, () => window.__fake.spoken.join(" ")))), "reply not spoken through the synthesis");
  assert(/Fake reply/.test(await page.locator(".turn.assistant .say").first().innerText()), "assistant turn missing");
  await listening(page); // back to listening after the speech ends, with no tap
  assert((await fake(page, () => window.__fake.liveRecs())) === 1, "recognition not running");
  assert((await fake(page, () => window.__fake.recStarts)) === 1, "recognition was restarted needlessly");
  noErrors(page); await page.__ctx.close();
});

await check("3 headphones: real words spoken over the reply cut it off with no key press", async () => {
  const page = await newChosen(true, { msPerChar: 70 });
  await startAndAsk(page);
  await page.waitForTimeout(1300); // long enough that some words were heard, so the turn is kept and marked cut off
  await fake(page, () => window.__fake.say.final("purple elephants dance gracefully"));
  await cutTag(page);
  assert((await fake(page, () => window.__fake.cancels)) >= 1, "speech was not cancelled");
  await waitFor(page, () => document.getElementById("floorLabel").textContent === "Listening", null, 5000);
  noErrors(page); await page.__ctx.close();
});

await check("4 speakers: the reply's own words and other words during speech do not cut it off; Space does", async () => {
  const page = await newChosen(false, { msPerChar: 90 });
  await startAndAsk(page);
  assert((await label(page)) === "Speaking. Press Space to cut in", "speakers label: " + await label(page));
  const reply = await page.locator(".turn.assistant .say").first().innerText();
  await page.waitForTimeout(200);
  await fake(page, (t) => window.__fake.say.final(t), reply);
  await fake(page, () => window.__fake.say.final("purple elephants dance gracefully"));
  await page.waitForTimeout(700);
  assert((await page.locator(".turn.assistant .tag.cut").count()) === 0, "mic words cut the reply off");
  assert(/^Speaking/.test(await label(page)), "no longer speaking: " + await label(page));
  await page.keyboard.press("Space");
  await cutTag(page);
  await listening(page);
  noErrors(page); await page.__ctx.close();
});

await check("5 the headphones toggle reaches the engine and the label (echo words then cut in)", async () => {
  const page = await newChosen(false, { msPerChar: 120 });
  await page.check("#setHeadphones");
  await startAndAsk(page);
  assert((await label(page)) === "Speaking. Talk to cut in, or press Space", "headphones label: " + await label(page));
  const reply = await page.locator(".turn.assistant .say").first().innerText();
  await page.waitForTimeout(1300);
  await fake(page, (t) => window.__fake.say.final(t), reply);
  await cutTag(page);
  noErrors(page); await page.__ctx.close();
});

await check("6 a session ending on its own is restarted without leaving listening", async () => {
  const page = await newPage();
  await page.click("#floor");
  await waitFor(page, () => window.__fake.recStarts === 1);
  await listening(page);
  await fake(page, () => { window.__fake.labels.length = 0; window.__fake.chromeEndsSession(); });
  await waitFor(page, () => window.__fake.recStarts === 2, null, 3000);
  await page.waitForTimeout(300);
  const labels = await fake(page, () => window.__fake.labels);
  assert(labels.every((l) => l === "Listening"), "label left Listening: " + JSON.stringify(labels));
  assert((await fake(page, () => window.__fake.liveRecs())) === 1, "no live recognition after restart");
  // still works after the restart
  await fake(page, () => window.__fake.say.final("Say something after the restart"));
  await waitFor(page, () => window.__fake.spoken.length > 0, null, 10000);
  noErrors(page); await page.__ctx.close();
});

await check("7 a typed message gets a reply, spoken", async () => {
  const page = await newPage();
  await page.fill("#msg", "typed hello there");
  await page.press("#msg", "Enter");
  await waitFor(page, () => /Fake reply/.test(document.getElementById("transcript").textContent), null, 10000);
  await waitFor(page, () => window.__fake.spoken.length > 0, null, 5000);
  noErrors(page); await page.__ctx.close();
});

await check("8 the speed slider goes above 1.5 and the rate reaches the voice", async () => {
  const page = await newPage();
  assert((await page.locator("#setSpeed").getAttribute("max")) === "2.5", "slider max is not 2.5");
  await page.locator("#setSpeed").evaluate((el) => { el.value = "2"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  assert((await page.locator("#setSpeedVal").innerText()) === "2.00", "speed label not updated");
  await page.fill("#msg", "say something at speed");
  await page.press("#msg", "Enter");
  await waitFor(page, () => window.__fake.rates.length > 0, null, 10000);
  const rates = await fake(page, () => window.__fake.rates);
  assert(rates.every((r) => Math.abs(r - 2) < 0.01), "voice rate was not 2: " + JSON.stringify(rates));
  noErrors(page); await page.__ctx.close();
});

await check("9 taking the floor while Claude is still thinking aborts the ask promptly", async () => {
  const page = await newPage();
  await page.fill("#msg", "[[slow]] please take your time");
  await page.press("#msg", "Enter");
  await waitFor(page, () => /^Thinking/.test(document.getElementById("floorLabel").textContent), null, 5000);
  await page.click("#floor");
  await waitFor(page, () => window.__fake.recStarts === 1);
  await listening(page);
  await page.waitForTimeout(500);
  assert((await page.locator(".turn.assistant").count()) === 0, "a half answer was left on screen");
  assert((await fake(page, () => window.__fake.spoken.length)) === 0, "something was spoken after the abort");
  noErrors(page); await page.__ctx.close();
});

await check("11 first run: the headphones prompt appears once and each button works", async () => {
  const page = await newPage();
  assert(await page.locator("#hpPrompt").isVisible(), "prompt not shown on first run");
  assert(/Are you using headphones\?/.test(await page.locator("#hpPrompt").innerText()), "prompt text");
  assert((await page.locator("#hpYes").innerText()) === "Yes, headphones" && (await page.locator("#hpNo").innerText()) === "No, speakers", "button text");
  await page.click("#hpYes");
  assert(!(await page.locator("#hpPrompt").isVisible()), "prompt still shown");
  assert(await page.locator("#setHeadphones").isChecked(), "checkbox not set by Yes");
  await page.reload();
  await page.waitForFunction(() => document.getElementById("noteConnecting").hidden === true, null, { timeout: 8000 });
  assert(!(await page.locator("#hpPrompt").isVisible()), "prompt shown again after the choice");
  assert(await page.locator("#setHeadphones").isChecked(), "choice not remembered");
  await page.__ctx.close();
  const p2 = await newPage();
  await p2.check("#setHeadphones"); // using the checkbox also counts as a choice
  assert(!(await p2.locator("#hpPrompt").isVisible()), "prompt still shown after the checkbox");
  await p2.__ctx.close();
  const p3 = await newPage();
  await p3.click("#hpNo");
  assert(!(await p3.locator("#hpPrompt").isVisible()) && !(await p3.locator("#setHeadphones").isChecked()), "No did not set speakers");
  await startAndAsk(p3);
  assert((await label(p3)) === "Speaking. Press Space to cut in", "speakers label after No: " + await label(p3));
  noErrors(p3); await p3.__ctx.close();
});

await check("10 screenshots of the local page in light and dark", async () => {
  for (const scheme of ["light", "dark"]) {
    const page = await newPage({ scheme, msPerChar: 200 });
    await startAndAsk(page, "Is coffee better than tea");
    await fake(page, () => window.__fake.say.partial("and one more thing"));
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SHOTS, `local-${scheme}-1280.png`) });
    noErrors(page); await page.__ctx.close();
  }
});

await browser.close();
server.kill();
const failed = results.filter((r) => r.status === "fail").length;
const skipped = results.filter((r) => r.status === "skip").length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
