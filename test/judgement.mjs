// Judgement test: the real engine with real Claude in the loop.
//
// Starts server.js (which bridges to the real `claude` program), drives the real engine with a fake mic that
// speaks scripted sentences as growing live guesses at about 3 words a second, a fake voice and the real clock,
// and records for each turn when (if ever) Claude cut in, how fast, what its notes said and what it replied.
//
//   node test/judgement.mjs                  all turns
//   node test/judgement.mjs 1 5 12           only these turns
//   node test/judgement.mjs --wps=3          words per second (default 3)
//
// Real calls are counted in a file in the scratchpad so the budget (250) holds across runs.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { createFloor } = require(path.join(root, "floor.js"));

const SCRATCH = "/tmp/claude-0/-home-user/273c0c87-38b9-5800-970d-c86c6c4a3717/scratchpad/work";
mkdirSync(SCRATCH, { recursive: true });
const COUNT_FILE = path.join(SCRATCH, "judgement-calls.txt");
const BUDGET = 250;
const argv = process.argv.slice(2);
const WPS = Number((argv.find((a) => a.startsWith("--wps=")) || "--wps=3").split("=")[1]);
const only = argv.filter((a) => /^\d+$/.test(a)).map(Number);

let used = existsSync(COUNT_FILE) ? Number(readFileSync(COUNT_FILE, "utf8")) || 0 : 0;
const bump = () => { used++; writeFileSync(COUNT_FILE, String(used)); };

// '|' marks where the wrong claim is complete (removed before speaking).
const TURNS = [
  { name: "Fourier is useless", kind: "wrong", text: "Fourier transforms are useless and I don't use them anywhere | so honestly I think we should just remove that whole topic from the curriculum" },
  { name: "Great Wall from the Moon", kind: "wrong", text: "The Great Wall of China is visible from the Moon | so it must be the biggest thing humans ever built by a mile" },
  { name: "Nobody uses C", kind: "wrong", text: "Nobody uses C anymore | because everything is written in Python these days and that is why I never bothered learning it" },
  { name: "Correlation proves causation", kind: "wrong", text: "Correlation proves causation here because ice cream sales and drowning deaths both go up in the summer | so ice cream must be killing people at the beach" },
  { name: "Self-contradiction", kind: "wrong", text: "I have never eaten meat in my entire life and last night I had a great steak at my favourite restaurant | downtown with my brother and we both ordered the big one" },
  { name: "Boiling point", kind: "correct", text: "Water boils at one hundred degrees Celsius at sea level but it boils at a lower temperature on a high mountain because the air pressure is lower" },
  { name: "French Revolution", kind: "correct", text: "The French Revolution began in seventeen eighty nine and it ended up reshaping politics across Europe for the next century" },
  { name: "Python for beginners", kind: "correct", text: "Python is a good first language for beginners because the syntax is readable although it can be slower than compiled languages" },
  { name: "Sleep and memory", kind: "correct", text: "Sleeping enough matters for memory because the brain consolidates what you learned during sleep so I try to get about eight hours" },
  { name: "Trip, unfinished", kind: "harmless", text: "So I was thinking about maybe taking a trip somewhere next month but I haven't really decided where and" },
  { name: "Hard to explain, unfinished", kind: "harmless", text: "Well it's sort of hard to explain but basically I just feel like we should probably talk about it later when" },
  { name: "Pasta, unfinished", kind: "harmless", text: "I was reading something yesterday about cooking and I think you boil pasta in salted water and then" },
  { name: "Sweeping, then backed up", kind: "backed", text: "Most code comments are useless but I mean the ones that just repeat the code like increment i by one while comments that explain why a decision was made are genuinely valuable" },
  { name: "Direct question", kind: "question", text: "Can you explain how a hash table handles collisions in simple terms" },
  { name: "Long correct explanation", kind: "long", text: "Photosynthesis is the process plants use to turn light into chemical energy. Chlorophyll in the leaves absorbs sunlight, mostly red and blue wavelengths, and uses that energy to split water molecules, releasing oxygen as a by-product. The plant then combines carbon dioxide from the air with the hydrogen from the water to build glucose, which it stores as starch or uses to grow. So the oxygen we breathe really does come from the water." },
];

// ------------------------------------------------------------------ server

async function startServer() {
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env: { ...process.env, PORT: "0", OPEN_FLOOR_PRESTART_MODELS: "haiku,sonnet" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let port = null;
  let out = "";
  const ready = new Promise((resolve, reject) => {
    const onData = (b) => {
      out += b.toString();
      const m = /localhost:(\d+)/.exec(out);
      if (m && !port) { port = Number(m[1]); resolve(port); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (b) => { out += b.toString(); });
    child.on("exit", (c) => reject(new Error("server exited " + c + ": " + out)));
    setTimeout(() => reject(new Error("server did not start: " + out)), 15000);
  });
  await ready;
  await new Promise((r) => setTimeout(r, 4000)); // let the warm processes come up
  return { child, port };
}

class UsageLimit extends Error {}

function makeModel(port, log) {
  return {
    available: true,
    async ask(messages, opts) {
      if (used >= BUDGET) throw new UsageLimit("budget of " + BUDGET + " real calls used");
      bump();
      const last = messages[messages.length - 1].content;
      const type = /\[LISTENING: STRICT CHECK\]/.test(last) ? "strict" : /\[LISTENING\]/.test(last) ? "listen"
        : /\[PAUSED: LISTEN MODE\]/.test(last) ? "monitor" : /\[PAUSED\]/.test(last) ? "paused" : "reply";
      const entry = { type, t0: Date.now(), notesInPrompt: (/Your (?:private notes so far|listening notes)[:\s]*\n?([^\n]*)/.exec(last) || [])[1] || "" };
      log.push(entry);
      const res = await fetch(`http://127.0.0.1:${port}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages, tier: opts.tier }),
        signal: opts.signal,
      }).catch((e) => { if (e && e.name === "AbortError") throw { code: "cancelled", message: "cancelled" }; throw { code: "upstream_error", message: String(e) }; });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", text = "";
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch (e) { throw { code: "cancelled", message: "cancelled" }; }
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const j = JSON.parse(line);
          if (j.delta) { text += j.delta; if (entry.tFirst === undefined) entry.tFirst = Date.now(); opts.onText && opts.onText({ text, delta: j.delta }); }
          else if (j.done) { entry.t1 = Date.now(); entry.text = j.text; return { text: j.text }; }
          else if (j.error) {
            entry.t1 = Date.now(); entry.error = j.error;
            if (/limit|usage/i.test(j.error.message || "") || j.error.code === "rate_limited") throw Object.assign({ code: j.error.code, message: j.error.message }, { usage: true });
            throw { code: j.error.code, message: j.error.message };
          }
        }
      }
      throw { code: "upstream_error", message: "stream ended without a result" };
    },
  };
}

// ------------------------------------------------------------------ one turn

function makeMic() {
  const m = {
    available: true, isActive: false, words: 0, fns: { partial: [], final: [], state: [] },
    start() { m.isActive = true; return Promise.resolve(); },
    stop() { m.isActive = false; m.fns.state.forEach((f) => f({ state: "idle", reason: "stopped" })); return Promise.resolve(); },
    active: () => m.isActive,
    onPartial(f) { m.fns.partial.push(f); return () => {}; },
    onFinal(f) { m.fns.final.push(f); return () => {}; },
    onState(f) { m.fns.state.push(f); return () => {}; },
  };
  return m;
}

function makeVoice() {
  const v = {
    available: true, lines: [], stops: 0,
    speak(what) { return v._p(what, "speak"); },
    add(what) { return v._p(what, "add"); },
    _p(what, fn) {
      const lines = typeof what === "string" ? [{ text: what }] : what;
      lines.forEach((l) => v.lines.push({ fn, text: l.text, t: Date.now() }));
      return new Promise((r) => setTimeout(() => r({ playedMs: 100 }), 120));
    },
    stop() { v.stops++; return Promise.resolve(); },
    onState() { return () => {}; },
    onPosition() { return () => {}; },
  };
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(port, turn) {
  const log = [];
  const events = [];
  const mic = makeMic();
  const voice = makeVoice();
  const t0 = Date.now();
  const eng = createFloor({
    mic, voice, model: makeModel(port, log),
    clock: { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id) },
    config: {},
    onEvent: (e) => events.push({ e, t: Date.now(), words: mic.words }),
  });
  const claimMark = turn.text.indexOf("|");
  const clean = turn.text.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  const claimEnd = claimMark >= 0 ? turn.text.slice(0, claimMark).trim().split(/\s+/).length : null;
  eng.takeFloor();
  let tClaimEnd = null;
  for (let i = 1; i <= words.length; i++) {
    if (!mic.isActive) break; // Claude cut in and the engine closed the mic
    mic.words = i;
    mic.fns.partial.forEach((f) => f({ text: words.slice(0, i).join(" ") }));
    if (claimEnd === i) tClaimEnd = Date.now();
    await sleep(1000 / WPS);
  }
  const spokeAll = mic.isActive;
  if (spokeAll) {
    mic.fns.final.forEach((f) => f({ text: clean }));
    mic.fns.partial.forEach((f) => f({ text: "" }));
  }
  const tSpoken = Date.now();
  // wait for Claude's turn to finish
  const deadline = Date.now() + 45000;
  for (;;) {
    await sleep(250);
    const st = eng.getState();
    const hist = eng.getHistory();
    const hasAssistant = hist.some((h) => h.role === "assistant");
    if (hasAssistant && (st === "idle" || st === "listening")) break;
    if (Date.now() > deadline) break;
  }
  await sleep(300);
  const cut = events.find((x) => x.e.type === "cutIn");
  const hist = eng.getHistory();
  const assistant = hist.filter((h) => h.role === "assistant").pop();
  const steps = events.filter((x) => x.e.type === "decision" && ["listen", "strict", "monitor"].includes(x.e.kind))
    .map((x) => ({ kind: x.e.kind, result: x.e.result, ms: x.e.ms, wordsAt: x.words, detail: x.e.detail }));
  const notes = events.filter((x) => x.e.type === "notes").map((x) => ({ wordsAt: x.words, text: x.e.text }));
  const replyCall = log.filter((c) => c.type === "paused" || c.type === "reply").pop();
  eng.destroy();
  return {
    name: turn.name, kind: turn.kind, words: words.length, claimEnd, spokeAll,
    cutWords: cut ? cut.words : null,
    cutDelayMs: cut && tClaimEnd ? cut.t - tClaimEnd : null,
    steps, notes, assistant: assistant ? assistant.text : null,
    firstLine: voice.lines[0] ? voice.lines[0].text : null,
    interruptedTurn: hist.some((h) => h.interrupted),
    replyUsedNotes: replyCall ? !!replyCall.notesInPrompt && !/^\(none/.test(replyCall.notesInPrompt) : null,
    replyNotesInPrompt: replyCall ? replyCall.notesInPrompt : null,
    calls: log.length, errors: log.filter((c) => c.error).map((c) => c.error),
    elapsedMs: Date.now() - t0, tSpoken: tSpoken - t0,
  };
}

function verdict(r, turn) {
  const stopperOk = (line) => !!line && line.trim().split(/\s+/).length <= 4;
  if (turn.kind === "wrong") {
    if (r.cutWords == null) return "FAIL: never cut in";
    if (r.cutWords > r.claimEnd + 16) return `FAIL: cut in too late (word ${r.cutWords}, claim complete at ${r.claimEnd})`;
    if (!stopperOk(r.firstLine)) return "FAIL: no stopper";
    return "PASS";
  }
  if (turn.kind === "backed") return r.cutWords == null ? "PASS (held fire)" : `INFO: cut in at word ${r.cutWords}`;
  if (turn.kind === "question") return r.cutWords != null ? "FAIL: cut in on a question" : r.assistant ? "PASS" : "FAIL: no reply";
  return r.cutWords == null ? (r.assistant ? "PASS" : "PASS (no reply)") : `FAIL: cut in at word ${r.cutWords}`;
}

// -------------------------------------------------------------------- main

const { child, port } = await startServer();
console.log(`server on port ${port}; real calls used so far: ${used}/${BUDGET}`);
const results = [];
let stopped = null;
try {
  for (let i = 0; i < TURNS.length; i++) {
    if (only.length && !only.includes(i + 1)) continue;
    if (used >= BUDGET - 4) { stopped = "budget"; break; }
    let r;
    try { r = await runTurn(port, TURNS[i]); }
    catch (e) { stopped = e instanceof UsageLimit ? "budget" : "error: " + (e && e.message || e); break; }
    r.verdict = verdict(r, TURNS[i]);
    r.n = i + 1;
    results.push(r);
    console.log(`\n#${r.n} ${r.name} [${r.kind}] ${r.words} words -> ${r.verdict}`);
    console.log(`   cut-in: ${r.cutWords == null ? "none" : "word " + r.cutWords + (r.claimEnd ? ` (claim complete at ${r.claimEnd}, delay ${r.cutDelayMs} ms)` : "")}`);
    for (const n of r.notes) console.log(`   notes @${n.wordsAt}: ${n.text || "(cleared)"}`);
    for (const s of r.steps) console.log(`   step ${s.kind} @${s.wordsAt} words: ${s.result} ${s.ms}ms ${s.result === "notes" ? "" : String(s.detail || "").slice(0, 80)}`);
    console.log(`   reply used notes: ${r.replyUsedNotes} ${r.replyNotesInPrompt ? "(" + r.replyNotesInPrompt.slice(0, 100) + ")" : ""}`);
    console.log(`   reply: ${r.assistant}`);
    if (r.errors.length) { console.log("   ERRORS:", JSON.stringify(r.errors)); if (r.errors.some((e) => e.code === "rate_limited" || /limit/i.test(e.message || ""))) { stopped = "usage limit"; break; } }
  }
} finally {
  child.kill();
}
const out = path.join(SCRATCH, "judgement-results-" + Date.now() + ".json");
writeFileSync(out, JSON.stringify({ used, stopped, results }, null, 2));
console.log(`\n${"turn".padEnd(5)}${"name".padEnd(32)}${"kind".padEnd(10)}${"cut@".padEnd(7)}${"delay".padEnd(9)}verdict`);
for (const r of results) console.log(`${String(r.n).padEnd(5)}${r.name.padEnd(32)}${r.kind.padEnd(10)}${String(r.cutWords ?? "-").padEnd(7)}${String(r.cutDelayMs ?? "-").padEnd(9)}${r.verdict}`);
console.log(`\nreal calls used in total: ${used}/${BUDGET}${stopped ? "  (stopped: " + stopped + ")" : ""}\nresults: ${out}`);
process.exit(results.some((r) => r.verdict.startsWith("FAIL")) ? 1 : 0);
