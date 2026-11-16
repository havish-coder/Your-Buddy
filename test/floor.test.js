"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { createFloor, parseReply, DEFAULTS, classifyReply } = require("../floor.js");

// ------------------------------------------------------------------ fakes

function makeClock() {
  const c = { t: 0, timers: [], seq: 0 };
  c.now = () => c.t;
  c.setTimeout = (fn, ms) => { const id = ++c.seq; c.timers.push({ id, at: c.t + Math.max(0, ms), fn }); return id; };
  c.clearTimeout = (id) => { c.timers = c.timers.filter((x) => x.id !== id); };
  c.pending = () => c.timers.length;
  // Advance fake time, firing timers in order and letting promises settle between them.
  c.advance = async (ms) => {
    const target = c.t + ms;
    await flush();
    for (;;) {
      c.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = c.timers[0];
      if (!next || next.at > target) break;
      c.timers.shift();
      c.t = Math.max(c.t, next.at);
      next.fn();
      await flush();
    }
    c.t = target;
    await flush();
  };
  return c;
}

const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

function makeMic(available = true) {
  const m = {
    available, isActive: false, startCalls: 0, stopCalls: 0, startError: null, stopHook: null,
    idleTiming: "before", // "before": idle fires, then stop() resolves; "after": stop() resolves, idle fires later; "never"
    lateWords: [], stopReject: null,
    partialFns: [], finalFns: [], stateFns: [],
    emitState(state, reason) { m.stateFns.forEach((f) => f(reason ? { state, reason } : { state })); },
    start() {
      m.startCalls++;
      if (m.startError) {
        const err = m.startError;
        m.emitState("starting");
        m.emitState("idle", err.code);
        return Promise.reject(err);
      }
      m.isActive = true;
      m.emitState("starting");
      m.emitState("listening");
      return Promise.resolve();
    },
    stop() {
      m.stopCalls++;
      return new Promise((res, rej) => {
        const finish = () => {
          m.emitState("finishing");
          m.lateWords.splice(0).forEach((w) => m.final(w));
          if (m.stopReject) return rej(m.stopReject);
          const idle = () => { m.isActive = false; m.emitState("idle", "stopped"); };
          if (m.idleTiming === "before") { idle(); res(); }
          else if (m.idleTiming === "after") { res(); setImmediate(idle); }
          else res();
        };
        if (m.stopHook) m.stopHook(finish); else finish();
      });
    },
    active: () => m.isActive,
    onPartial(fn) { m.partialFns.push(fn); return () => { m.partialFns = m.partialFns.filter((x) => x !== fn); }; },
    onFinal(fn) { m.finalFns.push(fn); return () => { m.finalFns = m.finalFns.filter((x) => x !== fn); }; },
    onState(fn) { m.stateFns.push(fn); return () => { m.stateFns = m.stateFns.filter((x) => x !== fn); }; },
    // scripting
    partial(text) { m.partialFns.forEach((f) => f({ text })); },
    final(text) { m.finalFns.forEach((f) => f({ text })); },
    end(reason) { m.isActive = false; m.emitState("idle", reason); },
  };
  return m;
}

function makeVoice(mic, available = true) {
  const v = {
    available, calls: [], pend: [], stopCalls: 0, rates: [], stateFns: [], posFns: [], script: [], busyRejects: 0,
    emitState(state, reason) { v.stateFns.forEach((f) => f(reason ? { state, reason } : { state })); },
    _go(fn, what, opts) {
      const lines = typeof what === "string" ? [{ text: what }] : what;
      const call = { fn, lines, opts, micActive: mic.isActive };
      v.calls.push(call);
      if (mic.isActive && !v.ignoreMic) { v.busyRejects++; call.busy = true; return Promise.reject({ code: "busy", message: "mic is open" }); }
      const scripted = v.script.shift();
      if (scripted) { call.rejected = scripted; return Promise.reject(scripted); }
      v.emitState("starting");
      return new Promise((resolve, reject) => {
        call.resolve = () => resolve({ playedMs: 1 });
        call.reject = reject;
        v.pend.push(call);
      });
    },
    speak(what, opts) { return v._go("speak", what, opts); },
    add(what, opts) { return v._go("add", what, opts); },
    stop() {
      v.stopCalls++;
      const p = v.pend; v.pend = [];
      p.forEach((c) => c.reject({ code: "stopped", message: "stopped", reason: "stopped" }));
      v.emitState("idle", "stopped");
      return Promise.resolve();
    },
    setRate(r) { v.rates.push(r); return Promise.resolve(); },
    onState(fn) { v.stateFns.push(fn); return () => {}; },
    onPosition(fn) { v.posFns.push(fn); return () => {}; },
    // scripting
    rejectNext(err) { v.script.push(err); },
    position(ms, line, id) { v.stateFns.forEach((f) => f({ state: "speaking" })); v.posFns.forEach((f) => f({ ms, line, id })); },
    finishAll() { const p = v.pend; v.pend = []; p.forEach((c) => c.resolve()); },
    platformStop() { const p = v.pend; v.pend = []; p.forEach((c) => c.reject({ code: "stopped", message: "stopped", reason: "viewer_stopped" })); },
    spoken() { return v.calls.filter((c) => !c.busy && !c.rejected).flatMap((c) => c.lines.map((l) => l.text)); },
  };
  return v;
}

function makeModel(available = true) {
  const m = { available, calls: [] };
  m.ask = (messages, opts) => {
    const last = messages[messages.length - 1].content;
    const call = {
      messages, opts, tier: opts.tier, signal: opts.signal, settled: false, text: "",
      mode: /\[LISTENING: STRICT CHECK\]/.test(last) ? "strict" : /\[LISTENING\]/.test(last) ? "listen" : /\[PAUSED: LISTEN MODE\]/.test(last) ? "monitor"
        : /\[PAUSED\]/.test(last) ? "paused" : /Describe this image/.test(messages[0].content) ? "describe" : "forced",
      last,
    };
    call.promise = new Promise((res, rej) => {
      call.resolve = (text) => { if (call.settled) return; call.settled = true; res({ text }); };
      call.reject = (err) => { if (call.settled) return; call.settled = true; rej(err); };
    });
    opts.signal.addEventListener("abort", () => call.reject({ code: "cancelled", message: "cancelled" }));
    call.chunk = (text) => { const d = text.slice(call.text.length); call.text = text; opts.onText && opts.onText({ text, delta: d }); };
    m.calls.push(call);
    return call.promise;
  };
  m.byMode = (mode) => m.calls.filter((c) => c.mode === mode);
  m.last = () => m.calls[m.calls.length - 1];
  return m;
}

function setup(cfg = {}, caps = {}) {
  const clock = makeClock();
  const mic = makeMic(caps.mic !== false);
  const voice = makeVoice(mic, caps.voice !== false);
  const model = makeModel(caps.model !== false);
  const events = [];
  const eng = createFloor({ mic, voice, model, clock, config: Object.assign({ pauseMs: 600, forceReplyMs: 2500, listenEveryWords: 1e9 }, cfg), onEvent: (e) => events.push(e) });
  const ev = (type) => events.filter((e) => e.type === type);
  const states = () => ev("state").map((e) => e.state);
  const decisions = () => ev("decision").map((e) => `${e.kind}:${e.result}`);
  return { clock, mic, voice, model, events, eng, ev, states, decisions };
}

const LONG = "so I was thinking that the moon landing happened in nineteen eighty and that was a big deal";
const SENT = "That is not quite right, the date was different.";

// ----------------------------------------------------------- parseReply

test("parseReply: wait, speech, show, truncation and partial prefixes", () => {
  assert.deepStrictEqual(parseReply("<wait>"), { wait: true, say: "", show: "" });
  assert.deepStrictEqual(parseReply("  \n<wait>"), { wait: true, say: "", show: "" });
  assert.strictEqual(parseReply("<wait> and some stray text").wait, true);
  assert.strictEqual(parseReply("<wai").wait, true);
  assert.deepStrictEqual(parseReply("  Sure thing. <show>a\nb</show>"), { wait: false, say: "Sure thing.", show: "a\nb" });
  assert.deepStrictEqual(parseReply("Sure. <show>cut off"), { wait: false, say: "Sure.", show: "cut off" });
  assert.deepStrictEqual(parseReply("Plain."), { wait: false, say: "Plain.", show: "" });
  assert.strictEqual(classifyReply(""), "undecided");
  assert.strictEqual(classifyReply(" <"), "undecided");
  assert.strictEqual(classifyReply("<wa"), "undecided");
  assert.strictEqual(classifyReply("<wait>"), "wait");
  assert.strictEqual(classifyReply("<wait>x"), "wait");
  assert.strictEqual(classifyReply("<w"+"hat"), "speech");
  assert.strictEqual(classifyReply("No."), "speech");
  assert.strictEqual(DEFAULTS.pauseMs, 1500);
});

// -------------------------------------------------------------- 1. pause -> reply

test("1. a pause leads to a reply being spoken; history has both turns", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("I think the sky is green");
  await t.clock.advance(599);
  assert.strictEqual(t.model.calls.length, 0, "no ask before pauseMs");
  await t.clock.advance(1);
  assert.strictEqual(t.model.calls.length, 1);
  const call = t.model.calls[0];
  assert.strictEqual(call.mode, "paused");
  assert.strictEqual(call.tier, "quick");
  assert.strictEqual(t.eng.getState(), "listening", "speculative ask does not change state");
  assert.match(call.messages[0].content, /live voice conversation/);
  assert.match(call.last, /I think the sky is green/);
  assert.strictEqual(call.messages[0].role, "user");
  assert.strictEqual(call.messages[call.messages.length - 1].role, "user");

  call.resolve("No, it's blue. Rayleigh scattering does that.");
  await flush();
  assert.strictEqual(t.mic.stopCalls, 1);
  assert.strictEqual(t.voice.calls[0].fn, "speak");
  assert.strictEqual(t.voice.calls[0].micActive, false, "voice never speaks while the mic is open");
  assert.strictEqual(t.voice.calls[0].lines[0].text, "No, it's blue.");
  assert.strictEqual(t.voice.calls[0].opts.rate, 1.15);
  assert.strictEqual(t.voice.calls[0].opts.voice, "buttery");
  assert.strictEqual(t.voice.calls[1].fn, "add");
  assert.strictEqual(t.voice.calls[1].lines[0].text, "Rayleigh scattering does that.");
  assert.notStrictEqual(t.voice.calls[0].lines[0].id, t.voice.calls[1].lines[0].id);
  assert.strictEqual(t.eng.getState(), "speaking");
  t.voice.finishAll();
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  const last = t.ev("state").pop();
  assert.strictEqual(last.yourTurn, true);
  const h = t.eng.getHistory();
  assert.deepStrictEqual(h.map((x) => x.role), ["user", "assistant"]);
  assert.strictEqual(h[0].text, "I think the sky is green");
  assert.strictEqual(h[1].text, "No, it's blue. Rayleigh scattering does that.");
  assert.deepStrictEqual(t.decisions(), ["reply:speak"]);
  assert.strictEqual(t.ev("partial").pop().text, "", "utterance cleared");
  assert.strictEqual(t.mic.startCalls, 1);
});

// -------------------------------------------------------------- 2. wait then forced

test("2. a mid-thought pause returns <wait>; after forceReplyMs a forced ask runs", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("so what I really mean is");
  await t.clock.advance(600);
  t.model.calls[0].resolve("<wait>");
  await flush();
  assert.deepStrictEqual(t.decisions(), ["reply:wait"]);
  assert.strictEqual(t.voice.calls.length, 0);
  assert.strictEqual(t.eng.getState(), "listening");
  await t.clock.advance(1899);
  assert.strictEqual(t.model.calls.length, 1, "forced ask waits for 2500ms of silence in total");
  await t.clock.advance(1);
  assert.strictEqual(t.model.calls.length, 2);
  assert.strictEqual(t.model.calls[1].mode, "forced");
  assert.match(t.model.calls[1].last, /Never reply with <wait>/);
  t.model.calls[1].resolve("Go on, I'm listening, what do you mean?");
  await flush();
  assert.strictEqual(t.voice.calls.length >= 1, true);
  assert.deepStrictEqual(t.decisions(), ["reply:wait", "forced:speak"]);
});

test("2b. resuming after a wait cancels the forced ask timer and starts a fresh pause", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("so what I really mean is");
  await t.clock.advance(600);
  t.model.calls[0].resolve("<wait>");
  await flush();
  await t.clock.advance(1000);
  t.mic.final(" that cats are better");
  await t.clock.advance(1500);
  assert.strictEqual(t.model.calls.length, 2, "paused ask for the new version, no forced one yet");
  assert.strictEqual(t.model.calls[1].mode, "paused");
  assert.match(t.model.calls[1].last, /that cats are better/);
});

// -------------------------------------------------------------- 3. resume mid-ask

test("3. the user resumes while a reply ask is in flight: aborted, nothing spoken, mic open", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("I think the sky");
  await t.clock.advance(600);
  const call = t.model.calls[0];
  call.chunk("<wa");
  t.mic.partial("is green");
  await flush();
  assert.strictEqual(call.signal.aborted, true);
  assert.deepStrictEqual(t.decisions(), ["reply:dropped"]);
  call.chunk("Whatever. Sure."); // stale chunk after the abort
  await flush();
  assert.strictEqual(t.voice.calls.length, 0);
  assert.strictEqual(t.mic.stopCalls, 0);
  assert.strictEqual(t.mic.isActive, true);
  assert.strictEqual(t.eng.getState(), "listening");
  assert.strictEqual(t.eng.getHistory().length, 0);
  await t.clock.advance(600);
  assert.strictEqual(t.model.calls.length, 2, "pause timer restarted");
  assert.match(t.model.calls[1].last, /I think the sky is green/);
});

// -------------------------------------------------------------- 4. cut-in

test("7. words arriving during mic.stop() at a reply commit: first ask abandoned, forced ask carries everything", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("I like cats");
  await t.clock.advance(600);
  let release;
  t.mic.stopHook = (finish) => { release = () => { t.mic.final(" and also dogs"); finish(); }; };
  const first = t.model.calls[0];
  first.resolve("Cats are fine, honestly. Dogs are better.");
  await flush();
  assert.strictEqual(t.eng.getState(), "thinking");
  assert.strictEqual(t.voice.calls.length, 0, "nothing spoken while the mic is closing");
  release();
  await flush();
  assert.strictEqual(first.signal.aborted, true);
  assert.strictEqual(t.model.calls.length, 2);
  const second = t.model.calls[1];
  assert.strictEqual(second.mode, "forced");
  assert.match(second.last, /I like cats and also dogs/);
  assert.strictEqual(t.eng.getState(), "thinking");
  assert.strictEqual(t.voice.calls.length, 0);
  assert.strictEqual(t.mic.startCalls, 1, "mic is never restarted by the engine");
  assert.deepStrictEqual(t.eng.getHistory().map((x) => x.text), ["I like cats and also dogs"], "user turn committed once, with the late words");
  second.resolve("Dogs win, sorry. They show up.");
  await flush();
  assert.strictEqual(t.mic.stopCalls, 1, "already closed");
  assert.strictEqual(t.voice.calls[0].lines[0].text, "Dogs win, sorry.");
  const h = t.eng.getHistory();
  assert.strictEqual(h[0].text, "I like cats and also dogs");
  assert.strictEqual(h.length, 2);
  assert.deepStrictEqual(t.decisions(), ["reply:dropped", "forced:speak"]);
});

// -------------------------------------------------------------- 8. sync mic.start

test("8. takeFloor() calls mic.start() synchronously and nowhere else", async () => {
  const t = setup();
  assert.strictEqual(t.mic.startCalls, 0);
  t.eng.takeFloor();
  assert.strictEqual(t.mic.startCalls, 1, "called before takeFloor returned");
  assert.strictEqual(t.eng.getState(), "listening");
  t.eng.takeFloor(); // key repeat while listening: no second start
  assert.strictEqual(t.mic.startCalls, 1);
  // run a whole turn and confirm no further start without a tap
  t.mic.final("I think the sky is green");
  await t.clock.advance(600);
  t.model.calls[0].resolve("No, it's blue. Look up.");
  await flush();
  t.voice.finishAll();
  await flush();
  await t.clock.advance(10000);
  assert.strictEqual(t.mic.startCalls, 1);
  assert.strictEqual(t.eng.getState(), "idle");
  t.eng.takeFloor();
  assert.strictEqual(t.mic.startCalls, 2);
});

test("8b. takeFloor() while speaking starts the mic synchronously, not after the voice stops", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("I think the sky is green");
  await t.clock.advance(600);
  t.model.calls[0].resolve("No, it's blue. Look up.");
  await flush();
  const before = t.mic.startCalls;
  t.eng.takeFloor();
  assert.strictEqual(t.mic.startCalls, before + 1);
});

test("8c. a start rejected not_granted: notice, mic unavailable afterwards; dismissed: quiet idle", async () => {
  const t = setup();
  t.mic.startError = { code: "not_granted", message: "no" };
  t.eng.takeFloor();
  await flush();
  assert.strictEqual(t.ev("notice")[0].code, "mic_denied");
  assert.strictEqual(t.eng.getState(), "idle");
  t.eng.takeFloor();
  assert.strictEqual(t.mic.startCalls, 1, "no further start once denied");
  assert.strictEqual(t.ev("notice").pop().code, "mic_unavailable");

  const u = setup();
  u.mic.startError = { code: "dismissed", message: "closed" };
  u.eng.takeFloor();
  await flush();
  assert.strictEqual(u.ev("notice").length, 0);
  assert.strictEqual(u.eng.getState(), "idle");

  const w = setup();
  w.mic.startError = { code: "upstream_error", message: "boom" };
  w.eng.takeFloor();
  await flush();
  assert.strictEqual(w.ev("notice").length, 1);
  assert.strictEqual(w.eng.getState(), "idle");
});

test("8d. no mic: takeFloor emits a notice and leaves state unchanged", () => {
  const t = setup({}, { mic: false });
  t.eng.takeFloor();
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("notice")[0].code, "mic_unavailable");
  assert.strictEqual(t.mic.startCalls, 0);
});

// -------------------------------------------------------------- 9. cut-off while speaking

async function speakingScenario(t, text) {
  t.eng.takeFloor();
  t.mic.final("tell me about the sky");
  await t.clock.advance(600);
  t.model.calls[0].resolve(text);
  await flush();
}

test("9. takeFloor() while speaking: voice stopped, turn truncated by the estimate, marked cutOff", async () => {
  const t = setup({ rate: 1.0 });
  await speakingScenario(t, "Honestly that claim does not hold up at all. The sky is blue because of scattering.");
  assert.strictEqual(t.eng.getState(), "speaking");
  const id0 = t.voice.calls[0].lines[0].id;
  t.voice.position(0, 0, id0);
  t.voice.position(1090, 0, id0); // floor(1.09 * 165 / 60) = 2 words at rate 1.0
  t.eng.takeFloor();
  assert.strictEqual(t.voice.stopCalls, 1);
  assert.strictEqual(t.mic.startCalls, 2);
  assert.strictEqual(t.eng.getState(), "listening");
  await flush();
  const a = t.eng.getHistory()[1];
  assert.strictEqual(a.role, "assistant");
  assert.strictEqual(a.text, "Honestly that");
  assert.strictEqual(a.cutOff, true);
  assert.ok(t.ev("turnUpdate").some((e) => e.turn.id === a.id && e.turn.cutOff && e.turn.text === "Honestly that"));
  t.mic.final("wait that is wrong");
  await t.clock.advance(600);
  const next = t.model.calls[t.model.calls.length - 1];
  const asst = next.messages.filter((m) => m.role === "assistant");
  assert.strictEqual(asst.length, 1);
  assert.ok(asst[0].content.endsWith("Honestly that [cut off by user]"), asst[0].content);
  // the stale rejection of the stopped reading must not move the engine
  assert.strictEqual(t.eng.getState(), "listening");
});

test("9b. cut-off in a later line: finished lines plus words of the current one, show dropped while streaming", async () => {
  const t = setup({ rate: 1.0 });
  t.eng.takeFloor();
  t.mic.final("tell me about the sky");
  await t.clock.advance(600);
  const call = t.model.calls[0];
  call.chunk("Honestly that claim does not hold up. And here is");
  await flush();
  assert.strictEqual(t.voice.calls.length, 1, "first sentence spoken before the stream ends");
  call.resolve("Honestly that claim does not hold up. And here is why it fails. <show>detail</show>");
  await flush();
  assert.strictEqual(t.voice.calls[1].fn, "add");
  const id1 = t.voice.calls[1].lines[0].id;
  t.voice.position(0, 0, t.voice.calls[0].lines[0].id);
  t.voice.position(0, 1, id1);
  t.voice.position(1500, 1, id1); // 4 words at 165wpm: floor(1.5*165/60)=4
  t.eng.takeFloor();
  const a = t.eng.getHistory()[1];
  assert.strictEqual(a.text, "Honestly that claim does not hold up. And here is why");
  assert.strictEqual(a.show, "detail", "stream had finished: show kept");
});

test("9c. platform viewer_stopped on the voice: cut-off ending in idle with yourTurn", async () => {
  const t = setup({ rate: 1.0 });
  await speakingScenario(t, "Honestly that claim does not hold up at all. More words here.");
  t.voice.position(0, 0, t.voice.calls[0].lines[0].id);
  t.voice.position(2000, 0, t.voice.calls[0].lines[0].id);
  t.voice.platformStop();
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  const s = t.ev("state").pop();
  assert.strictEqual(s.state, "idle");
  assert.strictEqual(s.yourTurn, true);
  const a = t.eng.getHistory()[1];
  assert.strictEqual(a.cutOff, true);
  assert.strictEqual(a.text, "Honestly that claim does not", "floor(2.0 * 165 / 60) = 5 words at rate 1.0");
  assert.strictEqual(t.mic.startCalls, 1, "no mic restart without a tap");
});

// -------------------------------------------------------------- 10. cut-off while thinking

test("10a. takeFloor() while thinking (mic still closing): no assistant turn, user words stay in the utterance", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("tell me about the sky");
  await t.clock.advance(600);
  let release;
  t.mic.stopHook = (finish) => { release = finish; };
  t.model.calls[0].resolve("Sure thing, here you go. Blue.");
  await flush();
  assert.strictEqual(t.eng.getState(), "thinking");
  t.eng.takeFloor();
  assert.strictEqual(t.mic.startCalls, 2, "restarted synchronously");
  assert.strictEqual(t.eng.getState(), "listening");
  release();
  await flush();
  assert.strictEqual(t.voice.calls.length, 0);
  assert.strictEqual(t.eng.getHistory().filter((x) => x.role === "assistant").length, 0);
  assert.strictEqual(t.eng.getState(), "listening");
});

test("10b. takeFloor() after speak() but before any audio: assistant turn removed", async () => {
  const t = setup();
  await speakingScenario(t, "Sure thing, here you go. Blue.");
  const turn = t.eng.getHistory()[1];
  assert.strictEqual(t.eng.getState(), "speaking");
  t.eng.takeFloor();
  assert.strictEqual(t.voice.stopCalls, 1);
  assert.ok(t.ev("turnRemove").some((e) => e.id === turn.id));
  assert.deepStrictEqual(t.eng.getHistory().map((x) => x.role), ["user"]);
  assert.strictEqual(t.eng.getState(), "listening");
});

test("10c. takeFloor() while a forced ask streams: aborted, later chunks ignored, typed text kept", async () => {
  const t = setup();
  t.eng.submitText("Explain tides to me");
  await flush();
  const call = t.model.calls[0];
  assert.strictEqual(t.eng.getState(), "thinking");
  t.eng.takeFloor();
  assert.strictEqual(call.signal.aborted, true);
  call.chunk("Sure. Tides are the moon pulling on water.");
  call.resolve("Sure. Tides are the moon pulling on water.");
  await flush();
  assert.strictEqual(t.voice.calls.length, 0);
  assert.strictEqual(t.eng.getState(), "listening");
  t.mic.final(" and the sun too");
  await t.clock.advance(600);
  assert.match(t.model.calls[1].last, /and the sun too/);
  assert.deepStrictEqual(t.eng.getHistory().map((x) => [x.role, x.text, !!x.typed]), [["user", "Explain tides to me", true]]);
  assert.strictEqual(t.model.calls[1].messages.length, 1, "typed turn and new words merge into one user message");
  assert.match(t.model.calls[1].messages[0].content, /Explain tides to me[\s\S]*and the sun too/);
});

// -------------------------------------------------------------- 11. streaming

test("11a. <wait> split across chunks is recognised and never spoken", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("so what I mean is");
  await t.clock.advance(600);
  const call = t.model.calls[0];
  call.chunk("<wa");
  await flush();
  call.chunk("<wait>");
  await flush();
  assert.strictEqual(t.voice.calls.length, 0);
  assert.strictEqual(t.mic.stopCalls, 0);
  call.resolve("<wait>");
  await flush();
  assert.deepStrictEqual(t.decisions(), ["reply:wait"]);
  assert.strictEqual(t.eng.getState(), "listening");
});

test("11b. the first sentence is spoken before the stream ends; <show> never reaches the voice", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("write me a loop");
  await t.clock.advance(600);
  const call = t.model.calls[0];
  call.chunk("Sure, here is a ");
  await flush();
  assert.strictEqual(t.voice.calls.length, 0, "no complete sentence yet");
  call.chunk("Sure, here is a loop. It counts to t");
  await flush();
  assert.strictEqual(t.voice.calls.length, 1, "spoken mid-stream");
  assert.strictEqual(t.voice.calls[0].lines[0].text, "Sure, here is a loop.");
  assert.strictEqual(t.eng.getState(), "speaking");
  assert.strictEqual(t.mic.isActive, false);
  const full = "Sure, here is a loop. It counts to ten. <show>```js\nfor (let i=0;i<10;i++) {}\n```</show>";
  call.chunk("Sure, here is a loop. It counts to ten. <sh");
  await flush();
  assert.strictEqual(t.voice.calls.length, 1, "a dangling <sh is held back, not spoken");
  call.chunk(full);
  await flush();
  const turn = t.eng.getHistory()[1];
  assert.strictEqual(turn.show, "```js\nfor (let i=0;i<10;i++) {}\n```");
  assert.strictEqual(t.voice.calls.length, 1, "rest is only added once the stream ends");
  call.resolve(full);
  await flush();
  assert.strictEqual(t.voice.calls.length, 2);
  assert.strictEqual(t.voice.calls[1].fn, "add");
  assert.strictEqual(t.voice.calls[1].lines[0].text, "It counts to ten.");
  for (const s of t.voice.spoken()) assert.doesNotMatch(s, /show|for \(|```|</);
  assert.strictEqual(t.eng.getHistory()[1].text, "Sure, here is a loop. It counts to ten.");
  t.voice.finishAll();
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
});

test("11c. a stream that never completes a sentence is spoken whole when it ends; a show-only reply is silent", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("hello there");
  await t.clock.advance(600);
  t.model.calls[0].chunk("Short one");
  await flush();
  assert.strictEqual(t.voice.calls.length, 0);
  t.model.calls[0].resolve("Short one");
  await flush();
  assert.strictEqual(t.voice.calls.length, 1);
  assert.strictEqual(t.voice.calls[0].lines[0].text, "Short one");

  const u = setup();
  u.eng.takeFloor();
  u.mic.final("hello there");
  await u.clock.advance(600);
  u.model.calls[0].resolve("<show>only this</show>");
  await flush();
  assert.strictEqual(u.voice.calls.length, 0);
  assert.strictEqual(u.eng.getHistory()[1].show, "only this");
  assert.strictEqual(u.eng.getState(), "idle");
  assert.strictEqual(u.ev("state").pop().yourTurn, true);
});

test("11d. long spoken parts are split into lines under 1800 characters", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("tell me a lot");
  await t.clock.advance(600);
  const sentence = "This is a fairly long sentence about nothing in particular. ";
  const body = sentence.repeat(70).trim(); // ~4200 chars
  t.model.calls[0].resolve(body);
  await flush();
  assert.ok(t.voice.calls.length >= 3);
  t.voice.calls.forEach((c) => c.lines.forEach((l) => assert.ok(l.text.length <= 1800)));
  assert.strictEqual(t.voice.spoken().join(" ").replace(/\s+/g, " "), body);
});

// -------------------------------------------------------------- 12. voice unavailable

test("12. voice unavailable: mic never stopped, turns arrive as text, state returns to listening", async () => {
  const t = setup({}, { voice: false });
  t.eng.takeFloor();
  t.mic.final("I think the sky is green");
  await t.clock.advance(600);
  t.model.calls[0].resolve("No, it's blue. Look up. <show>proof</show>");
  await flush();
  assert.strictEqual(t.mic.stopCalls, 0);
  assert.strictEqual(t.voice.calls.length, 0);
  assert.strictEqual(t.mic.isActive, true);
  assert.strictEqual(t.eng.getState(), "listening");
  const h = t.eng.getHistory();
  assert.strictEqual(h[0].text, "I think the sky is green");
  assert.strictEqual(h[1].text, "No, it's blue. Look up.");
  assert.strictEqual(h[1].show, "proof");
  assert.strictEqual(t.voice.stopCalls, 0);
  // and the next utterance still works, with no tap
  t.mic.final("no it is green");
  await t.clock.advance(600);
  assert.strictEqual(t.model.calls.length, 2);
});

test("12b. voice unavailable and mic ends: finishes in idle with yourTurn", async () => {
  const t = setup({}, { voice: false });
  t.eng.submitText("hello");
  await flush();
  t.model.calls[0].resolve("Hi there, friend.");
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
});

test("12c. duplex true: mic stays open and voice may speak with it open", async () => {
  const t = setup({ duplex: true });
  t.voice.ignoreMic = true;
  t.eng.takeFloor();
  t.mic.final("I think the sky is green");
  await t.clock.advance(600);
  t.model.calls[0].resolve("No, it's blue. Look up.");
  await flush();
  assert.strictEqual(t.mic.stopCalls, 0);
  assert.strictEqual(t.voice.calls[0].micActive, true);
  t.voice.finishAll();
  await flush();
  assert.strictEqual(t.eng.getState(), "listening");
});

// -------------------------------------------------------------- 14 covered in 9c; mic ending on its own

test("14b. mic ends on its own: viewer_stopped with words asks forced; empty goes idle; hidden/time_limit idle; not_granted notice", async () => {
  let t = setup();
  t.eng.takeFloor();
  t.mic.final("I think the sky is green");
  t.mic.end("viewer_stopped");
  await flush();
  assert.strictEqual(t.model.calls.length, 1);
  assert.strictEqual(t.model.calls[0].mode, "forced");
  assert.strictEqual(t.eng.getState(), "thinking");
  t.model.calls[0].resolve("No, it's blue. Look up.");
  await flush();
  assert.strictEqual(t.mic.stopCalls, 0, "mic was already closed");
  assert.strictEqual(t.voice.calls[0].micActive, false);
  assert.strictEqual(t.mic.startCalls, 1);

  t = setup();
  t.eng.takeFloor();
  t.mic.end("viewer_stopped");
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.model.calls.length, 0);

  for (const reason of ["hidden", "time_limit"]) {
    t = setup();
    t.eng.takeFloor();
    t.mic.final("some words");
    t.mic.end(reason);
    await t.clock.advance(5000);
    assert.strictEqual(t.eng.getState(), "idle", reason);
    assert.strictEqual(t.model.calls.length, 0, reason);
  }

  t = setup();
  t.eng.takeFloor();
  t.mic.end("not_granted");
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("notice")[0].code, "mic_denied");
  t.eng.takeFloor();
  assert.strictEqual(t.mic.startCalls, 1);
});

// -------------------------------------------------------------- 15. submitText

test("15. submitText: forced ask, folds spoken words, no mic.start, cuts Claude off", async () => {
  const t = setup();
  t.eng.submitText("What is the capital of France?");
  await flush();
  assert.strictEqual(t.mic.startCalls, 0);
  assert.strictEqual(t.model.calls.length, 1);
  assert.strictEqual(t.model.calls[0].mode, "forced");
  assert.strictEqual(t.eng.getState(), "thinking");
  t.model.calls[0].resolve("Paris. Obviously.");
  await flush();
  assert.strictEqual(t.mic.stopCalls, 0, "mic was not active");
  assert.strictEqual(t.voice.calls[0].lines[0].text, "Paris. Obviously.", "under 12 chars in: no early first sentence");
  assert.strictEqual(t.mic.startCalls, 0);
  t.voice.finishAll();
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
  const h = t.eng.getHistory();
  assert.strictEqual(h[0].typed, true);
  assert.strictEqual(h[0].text, "What is the capital of France?");
  assert.deepStrictEqual(t.decisions(), ["typed:speak"]);
});

test("15b. submitText while listening folds the spoken words in front and aborts the pending ask", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("so about the thing");
  await t.clock.advance(600);
  const paused = t.model.calls[0];
  t.eng.submitText("which thing?");
  assert.strictEqual(paused.signal.aborted, true);
  await flush();
  const forced = t.model.calls[1];
  assert.strictEqual(forced.mode, "forced");
  assert.match(forced.last, /so about the thing which thing\?/);
  forced.resolve("The thing you said. Tell me more.");
  await flush();
  assert.strictEqual(t.mic.stopCalls, 1, "mic was active, so it is stopped before the voice speaks");
  assert.strictEqual(t.mic.startCalls, 1);
  assert.strictEqual(t.eng.getHistory()[0].text, "so about the thing which thing?");
});

test("15c. submitText while speaking cuts Claude off", async () => {
  const t = setup({ rate: 1.0 });
  await speakingScenario(t, "Honestly that claim does not hold up at all. More.");
  t.voice.position(0, 0, t.voice.calls[0].lines[0].id);
  t.voice.position(1000, 0, t.voice.calls[0].lines[0].id);
  t.eng.submitText("no it does");
  assert.strictEqual(t.voice.stopCalls, 1);
  assert.strictEqual(t.eng.getHistory()[1].cutOff, true);
  await flush();
  const msgs = t.model.calls[1].messages;
  assert.ok(msgs.some((m) => m.role === "assistant" && /\[cut off by user\]$/.test(m.content)));
});

// -------------------------------------------------------------- 16. attachments

test("16a. text attachments join the context turn; over-cap text is truncated and flagged", async () => {
  const t = setup({ maxContextBytes: 30 });
  const id = t.eng.addAttachment({ kind: "text", name: "notes.txt", text: "PELICAN-7421 is the word " });
  const id2 = t.eng.addAttachment({ kind: "text", name: "big.txt", text: "x".repeat(100) });
  assert.ok(id && id2 && id !== id2);
  const evs = t.ev("attachment");
  assert.strictEqual(evs[0].attachment.truncated, false);
  assert.strictEqual(evs[0].attachment.name, "notes.txt");
  assert.strictEqual(evs[1].attachment.truncated, true);
  assert.strictEqual(evs[1].attachment.chars, 100);
  t.eng.submitText("what does the file say");
  await flush();
  const ctx = t.model.calls[0].messages[0].content;
  assert.match(ctx, /--- file: notes\.txt ---\nPELICAN-7421 is the word /);
  assert.match(ctx, /--- file: big\.txt ---\nxxxxx\b/);
  assert.ok(!/x{6}/.test(ctx), "only 5 chars of the second file fit under the 30 char cap");
  t.eng.removeAttachment(id);
  assert.ok(t.ev("attachmentRemove").some((e) => e.id === id));
  // budget freed: the big file is re-flagged
  const last = t.ev("attachment").pop().attachment;
  assert.strictEqual(last.name, "big.txt");
  assert.strictEqual(last.truncated, true);
});

test("16b. an image triggers a describe ask; its blob goes with the next reply ask once", async () => {
  const t = setup();
  const blob = { fake: "blob" };
  const id = t.eng.addAttachment({ kind: "image", name: "pic.png", blob });
  await flush();
  assert.strictEqual(t.ev("attachment")[0].attachment.describing, true);
  const d = t.model.calls[0];
  assert.strictEqual(d.mode, "describe");
  assert.strictEqual(d.tier, "quick");
  assert.deepStrictEqual(d.opts.images, [blob]);
  d.resolve("A red heron standing in water with HERON-3308 written below.");
  await flush();
  const done = t.ev("attachment").pop().attachment;
  assert.strictEqual(done.id, id);
  assert.ok(!done.describing);
  assert.ok(done.chars > 10);
  assert.ok(t.decisions().includes("describe:speak"));

  t.eng.submitText("what is in the picture");
  await flush();
  const r1 = t.model.calls[1];
  assert.deepStrictEqual(r1.opts.images, [blob]);
  assert.match(r1.messages[0].content, /--- file: pic\.png ---\nA red heron/);
  r1.resolve("A heron. Nice bird.");
  await flush();
  t.voice.finishAll();
  await flush();
  t.eng.submitText("and now?");
  await flush();
  assert.strictEqual(t.model.calls[2].opts.images, undefined, "blob is sent once");
});

test("16c. a dropped reply ask does not consume the image blob; removing an attachment aborts its describe", async () => {
  const t = setup();
  const blob = { fake: "blob" };
  t.eng.addAttachment({ kind: "image", name: "pic.png", blob });
  t.model.calls[0].resolve("A heron.");
  await flush();
  t.eng.takeFloor();
  t.mic.final("what is this");
  await t.clock.advance(600);
  assert.deepStrictEqual(t.model.calls[1].opts.images, [blob]);
  t.mic.final(" picture here");
  await flush();
  assert.strictEqual(t.model.calls[1].signal.aborted, true);
  await t.clock.advance(600);
  assert.deepStrictEqual(t.model.calls[2].opts.images, [blob], "still pending");

  const u = setup();
  const id = u.eng.addAttachment({ kind: "image", name: "p.png", blob });
  u.eng.removeAttachment(id);
  assert.strictEqual(u.model.calls[0].signal.aborted, true);
});

// -------------------------------------------------------------- 17. errors after commit

test("17a. a forced ask that errors after the mic closed ends idle with yourTurn, never thinking", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("I think the sky is green");
  t.mic.end("viewer_stopped");
  await flush();
  assert.strictEqual(t.eng.getState(), "thinking");
  t.model.calls[0].reject({ code: "upstream_error", message: "connection dropped" });
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
  assert.strictEqual(t.ev("notice").pop().code, "error");
});

test("17b. an error mid-stream after speech began keeps what was said and finishes cleanly", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("tell me about tides");
  await t.clock.advance(600);
  const call = t.model.calls[0];
  call.chunk("Tides come from the moon. And the su");
  await flush();
  assert.strictEqual(t.eng.getState(), "speaking");
  call.reject({ code: "upstream_error", message: "dropped", text: "Tides come from the moon. And the su" });
  await flush();
  assert.strictEqual(t.eng.getState(), "speaking", "first line is still playing");
  t.voice.finishAll();
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
  assert.strictEqual(t.eng.getHistory()[1].text, "Tides come from the moon.");
  assert.strictEqual(t.voice.calls.length, 1, "no add of the broken remainder");
  assert.strictEqual(t.ev("notice").pop().code, "error");
});

test("17c. an error while the mic is closing, before anything speakable: idle with yourTurn", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("tell me about tides");
  await t.clock.advance(600);
  let release;
  t.mic.stopHook = (finish) => { release = finish; };
  const call = t.model.calls[0];
  call.chunk("Tides come from the moon. More.");
  await flush();
  assert.strictEqual(t.eng.getState(), "thinking");
  call.reject({ code: "refused", message: "no" });
  await flush();
  release();
  await flush();
  assert.strictEqual(t.ev("notice").pop().code, "refused");
  t.voice.finishAll();
  await flush();
  assert.notStrictEqual(t.eng.getState(), "thinking");
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.eng.getHistory().find((x) => x.role === "assistant"), undefined, "withdrawn reply is not kept");
  assert.deepStrictEqual(t.voice.spoken(), [], "nothing was spoken");
  assert.strictEqual(t.voice.calls.length, 0);
  assert.deepStrictEqual(t.decisions(), ["reply:error"]);
});

test("17d. refused before any commit with an empty utterance reply: idle; show is dropped on refusal", async () => {
  const t = setup();
  t.eng.submitText("do a bad thing");
  await flush();
  t.model.calls[0].reject({ code: "refused", message: "no" });
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("notice").pop().code, "refused");
});

test("17e. the voice failing is not fatal: notice, text stays, state is not stuck", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("tell me about tides");
  await t.clock.advance(600);
  t.model.calls[0].resolve("Tides come from the moon. And the sun too.");
  await flush();
  t.voice.pend[0].reject({ code: "upstream_error", message: "tts down" });
  await flush();
  assert.strictEqual(t.ev("notice").pop().code, "voice_failed");
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.eng.getHistory()[1].text, "Tides come from the moon. And the sun too.");
});

test("17f. model unavailable codes: notice, model marked unavailable, no more asks", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("I think the sky is green");
  await t.clock.advance(600);
  t.model.calls[0].reject({ code: "sampling_disabled", message: "off" });
  await flush();
  assert.strictEqual(t.ev("notice")[0].code, "model_unavailable");
  t.mic.final(" really it is");
  await t.clock.advance(5000);
  assert.strictEqual(t.model.calls.length, 1);
  t.eng.submitText("hello?");
  assert.strictEqual(t.model.calls.length, 1);
  assert.strictEqual(t.ev("notice").pop().code, "model_unavailable");
});

test("17g. a cancelled error is silent", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("hello there my friend");
  await t.clock.advance(600);
  t.model.calls[0].reject({ code: "cancelled", message: "x" });
  await flush();
  assert.strictEqual(t.ev("notice").length, 0);
  assert.strictEqual(t.eng.getState(), "listening");
});

// -------------------------------------------------------------- stale work

test("stale: voice rejections and chunks after the engine moved on are ignored", async () => {
  const t = setup();
  await speakingScenario(t, "Honestly that claim does not hold up at all. More words.");
  const pend = t.voice.calls.slice();
  t.eng.takeFloor(); // stops the voice, which rejects the pending promises with 'stopped'
  await flush();
  pend.forEach((c) => c.reject({ code: "stopped", message: "late", reason: "viewer_stopped" })); // even a late viewer_stopped
  await flush();
  assert.strictEqual(t.eng.getState(), "listening");
  assert.strictEqual(t.ev("state").pop().state, "listening");
});

test("stale: a voice rejection after stop() does not resurrect state", async () => {
  const t = setup();
  await speakingScenario(t, "Honestly that claim does not hold up at all. More words.");
  await t.eng.stop();
  assert.strictEqual(t.eng.getState(), "idle");
  const n = t.events.length;
  t.voice.calls.forEach((c) => c.reject({ code: "stopped", message: "late", reason: "viewer_stopped" }));
  await flush();
  assert.strictEqual(t.events.length, n, "no events after stop");
  assert.strictEqual(t.eng.getState(), "idle");
});

test("stop() aborts asks, stops voice and mic, ends idle; reset clears history and attachments", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("I think the sky is green");
  await t.clock.advance(600);
  const call = t.model.calls[0];
  t.eng.addAttachment({ kind: "text", name: "a.txt", text: "hi" });
  await t.eng.stop();
  assert.strictEqual(call.signal.aborted, true);
  assert.strictEqual(t.mic.stopCalls, 1);
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.mic.isActive, false);
  t.eng.submitText("hello");
  await flush();
  t.model.calls[1].resolve("Hi there, friend.");
  await flush();
  t.voice.finishAll();
  await flush();
  assert.strictEqual(t.eng.getHistory().length, 2);
  await t.eng.reset();
  assert.strictEqual(t.eng.getHistory().length, 0);
  assert.strictEqual(t.ev("turnRemove").length, 2);
  assert.strictEqual(t.ev("attachmentRemove").length, 1);
  t.eng.submitText("again");
  await flush();
  assert.doesNotMatch(t.model.calls[2].messages[0].content, /a\.txt/);
  assert.strictEqual(t.model.calls[2].messages.length, 1, "history cleared: one merged user turn");
});

test("setConfig: rate change while speaking calls voice.setRate; topic and history caps in the prompt", async () => {
  const t = setup();
  await speakingScenario(t, "Honestly that claim does not hold up at all. More words.");
  t.eng.setConfig({ rate: 1.3 });
  assert.deepStrictEqual(t.voice.rates, [1.3]);
  t.voice.finishAll();
  await flush();
  t.eng.setConfig({ topic: "whether the moon is cheese" });
  t.eng.submitText("so?");
  await flush();
  assert.match(t.model.calls[1].messages[0].content, /whether the moon is cheese/);

  const u = setup();
  for (let i = 0; i < 30; i++) {
    u.eng.submitText("message " + i);
    await flush();
    u.model.last().resolve("Reply number " + i + " is here.");
    await flush();
    u.voice.finishAll();
    await flush();
  }
  u.eng.submitText("final");
  await flush();
  const msgs = u.model.last().messages;
  assert.ok(msgs.length <= 1 + 40 + 1, "history capped to 40 turns");
  assert.strictEqual(msgs[0].role, "user");
  assert.strictEqual(msgs[msgs.length - 1].role, "user");
  for (let i = 1; i < msgs.length; i++) assert.notStrictEqual(msgs[i].role, msgs[i - 1].role, "roles alternate");
});

test("destroy unsubscribes and silences the engine", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("hello there friend");
  t.eng.destroy();
  const n = t.events.length;
  t.mic.final(" more");
  await t.clock.advance(5000);
  assert.strictEqual(t.events.length, n);
  assert.strictEqual(t.model.calls.length, 0);
  assert.strictEqual(t.mic.finalFns.length, 0);
});

test("unavailable adapters are never called", async () => {
  const t = setup({}, { mic: false, voice: false, model: false });
  t.eng.takeFloor();
  t.eng.submitText("hi");
  t.eng.addAttachment({ kind: "image", name: "x", blob: {} });
  await t.eng.stop();
  assert.strictEqual(t.mic.startCalls + t.mic.stopCalls, 0);
  assert.strictEqual(t.voice.calls.length + t.voice.stopCalls, 0);
  assert.strictEqual(t.model.calls.length, 0);
});

// =====================================================================
// Review round 1: one test (or more) per finding
// =====================================================================

async function listenAndAsk(t, words = "I think the sky is green") {
  t.eng.takeFloor();
  t.mic.final(words);
  await t.clock.advance(600);
  return t.model.last();
}

// ---- 1. rejected images
test("R1.1 describe rejected with image_rejected: one notice naming the image; later asks carry no blob", async () => {
  const t = setup();
  t.eng.addAttachment({ kind: "image", name: "huge.png", blob: { b: 1 } });
  t.model.calls[0].reject({ code: "image_rejected", message: "developer text too large" });
  await flush();
  const n = t.ev("notice");
  assert.strictEqual(n.length, 1);
  assert.strictEqual(n[0].code, "image_rejected");
  assert.strictEqual(n[0].detail.name, "huge.png");
  assert.strictEqual(n[0].detail.reason, "image_rejected");
  assert.doesNotMatch(n[0].message, /developer text/);
  for (let i = 0; i < 3; i++) {
    t.eng.submitText("message " + i);
    await flush();
    assert.strictEqual(t.model.last().opts.images, undefined, "no poisoned blob on ask " + i);
    t.model.last().resolve("Fine, noted. Moving on.");
    await flush();
    t.voice.finishAll();
    await flush();
  }
  assert.strictEqual(t.ev("notice").length, 1, "told once");
});

test("R1.1b a reply ask rejected with images_unavailable drops the blob; the next ask works", async () => {
  const t = setup();
  t.eng.addAttachment({ kind: "image", name: "p.png", blob: { b: 1 } });
  t.model.calls[0].resolve("A picture of a bird.");
  await flush();
  t.eng.submitText("look");
  await flush();
  assert.ok(t.model.last().opts.images);
  t.model.last().reject({ code: "images_unavailable", message: "no" });
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  assert.deepStrictEqual(t.ev("notice").map((x) => x.code), ["image_rejected"]);
  t.eng.submitText("again");
  await flush();
  assert.strictEqual(t.model.last().opts.images, undefined);
});

// ---- 2. refused after commit
test("R1.2 refused after commit but before the first speak: nothing spoken, no turn kept, decision is error", async () => {
  const t = setup();
  const c = await listenAndAsk(t, "tell me about tides");
  let release;
  t.mic.stopHook = (f) => { release = f; };
  c.chunk("Tides come from the moon. More.");
  await flush();
  c.reject({ code: "refused", message: "no" });
  await flush();
  release();
  await flush();
  assert.deepStrictEqual(t.voice.calls, []);
  assert.deepStrictEqual(t.eng.getHistory().map((x) => x.role), ["user"]);
  assert.deepStrictEqual(t.decisions(), ["reply:error"]);
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
});

test("R1.2b refused after audio began: voice stopped, only what was heard is kept, show dropped", async () => {
  const t = setup({ rate: 1.0 });
  const c = await listenAndAsk(t, "tell me about tides");
  c.chunk("Honestly that claim does not hold up at all. And");
  await flush();
  assert.strictEqual(t.eng.getState(), "speaking");
  t.voice.position(0, 0, t.voice.calls[0].lines[0].id);
  t.voice.position(1000, 0, t.voice.calls[0].lines[0].id);
  c.reject({ code: "refused", message: "no" });
  await flush();
  assert.strictEqual(t.voice.stopCalls, 1);
  const a = t.eng.getHistory()[1];
  assert.strictEqual(a.text, "Honestly that");
  assert.strictEqual(a.show, "");
  assert.strictEqual(t.eng.getState(), "idle");
  assert.deepStrictEqual(t.decisions(), ["reply:error"]);
});

test("R1.2c an error after speech began is recorded as an error decision, not speak", async () => {
  const t = setup();
  const c = await listenAndAsk(t, "tell me about tides");
  c.chunk("Tides come from the moon. And the su");
  await flush();
  c.reject({ code: "upstream_error", message: "dropped" });
  await flush();
  assert.deepStrictEqual(t.decisions(), ["reply:error"]);
});

// ---- 3. stuck in thinking
test("R1.3 re-ask after late words cannot start (model just became unavailable): idle with yourTurn", async () => {
  const t = setup();
  t.eng.addAttachment({ kind: "image", name: "p.png", blob: {} });
  const describe = t.model.calls[0];
  const c = await listenAndAsk(t, "I like cats");
  t.mic.lateWords = [" and dogs"];
  let rel;
  t.mic.stopHook = (f) => { rel = f; };
  c.resolve("Cats are fine, honestly. Dogs too.");
  await flush();
  describe.reject({ code: "not_granted", message: "declined" });
  await flush();
  rel();
  await t.clock.advance(60000);
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
  assert.deepStrictEqual(t.eng.getHistory().map((x) => x.text), ["I like cats and dogs"]);
  const mu = t.ev("notice").find((x) => x.code === "model_unavailable");
  assert.strictEqual(mu.detail.reason, "not_granted");
});

test("R1.3b viewer_stopped with words while the model is unavailable: idle with yourTurn", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("I like cats");
  t.eng.addAttachment({ kind: "image", name: "p.png", blob: {} });
  t.model.calls[0].reject({ code: "sampling_disabled", message: "off" });
  await flush();
  t.mic.end("viewer_stopped");
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
  assert.deepStrictEqual(t.eng.getHistory().map((x) => x.role), ["user"]);
});

test("R1.3c an error during the abandon-and-re-ask path ends idle with yourTurn, user turn kept", async () => {
  const t = setup();
  const c = await listenAndAsk(t, "I like cats");
  t.mic.lateWords = [" and dogs"];
  c.resolve("Cats are fine, honestly. Dogs too.");
  await flush();
  assert.strictEqual(t.model.calls.length, 2);
  t.model.calls[1].reject({ code: "upstream_error", message: "x" });
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
  assert.deepStrictEqual(t.eng.getHistory().map((x) => [x.role, x.text]), [["user", "I like cats and dogs"]]);
  assert.strictEqual(t.mic.startCalls, 1);
  assert.strictEqual(t.ev("notice").pop().code, "error");
});

// ---- 4. late idle(stopped)
test("R1.4 a late idle(stopped) from the previous session cannot knock a new listening session into idle", async () => {
  const t = setup();
  t.mic.idleTiming = "after";
  const c = await listenAndAsk(t, "tell me about the sky");
  let rel;
  t.mic.stopHook = (f) => { rel = f; };
  c.resolve("Sure thing, here you go. Blue.");
  await flush();
  t.eng.takeFloor(); // tap while the mic is still finishing
  assert.strictEqual(t.mic.startCalls, 2);
  t.mic.stopHook = null;
  rel(); // stop() resolves, the old session's idle(stopped) arrives afterwards
  await flush();
  await flush();
  assert.strictEqual(t.eng.getState(), "listening");
  t.mic.final(" and more words now");
  await t.clock.advance(600);
  assert.strictEqual(t.model.calls.length, 2, "the user keeps talking and gets a reply check");
  assert.strictEqual(t.model.last().mode, "paused");
});

test("R1.4b idle(stopped) is never the mic ending on its own", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("hello there");
  t.mic.emitState("idle", "stopped");
  await flush();
  assert.strictEqual(t.eng.getState(), "listening");
});

// ---- 5/6. no timer-driven re-asks of typed content
test("R1.5 a typed ask that returns <wait> with the mic open: user turn stays, no re-ask, back to listening", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("hello");
  assert.strictEqual(t.eng.submitText("what do you think"), true);
  assert.deepStrictEqual(t.eng.getHistory().map((x) => [x.text, !!x.typed]), [["hello what do you think", true]]);
  assert.strictEqual(t.ev("turn").length, 1, "turn emitted at once");
  await flush();
  t.model.calls[0].resolve("<wait>");
  await flush();
  await t.clock.advance(10000);
  assert.strictEqual(t.model.calls.length, 1);
  assert.strictEqual(t.eng.getState(), "listening");
  assert.strictEqual(t.eng.getHistory().length, 1);
  assert.deepStrictEqual(t.decisions(), ["typed:wait"]);
});

test("R1.6 a typed ask that errors with the mic open: user turn stays, no re-ask; rate_limited not retried", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.eng.submitText("what do you think");
  await flush();
  t.model.calls[0].reject({ code: "rate_limited", message: "slow", retryAfterMs: 5000 });
  await flush();
  await t.clock.advance(60000);
  assert.strictEqual(t.model.calls.length, 1);
  assert.strictEqual(t.eng.getState(), "listening");
  const n = t.ev("notice")[0];
  assert.strictEqual(n.code, "rate_limited");
  assert.strictEqual(n.detail.retryAfterMs, 5000);
  assert.strictEqual(t.eng.getHistory().length, 1);

  const u = setup();
  u.eng.takeFloor();
  u.eng.submitText("again");
  await flush();
  u.model.calls[0].reject({ code: "upstream_error", message: "boom" });
  await flush();
  await u.clock.advance(60000);
  assert.strictEqual(u.model.calls.length, 1);
  assert.strictEqual(u.eng.getState(), "listening");
});

test("R1.6b a paused-mode rate_limited is not followed by an automatic re-ask", async () => {
  const t = setup();
  const c = await listenAndAsk(t, "I like cats");
  c.reject({ code: "rate_limited", message: "slow" });
  await flush();
  await t.clock.advance(60000);
  assert.strictEqual(t.model.calls.length, 1);
  assert.strictEqual(t.eng.getState(), "listening");
});

test("R1.5b submitText returns false for empty text or an unavailable model", () => {
  const t = setup();
  assert.strictEqual(t.eng.submitText("   "), false);
  assert.strictEqual(t.model.calls.length, 0);
  const u = setup({}, { model: false });
  assert.strictEqual(u.eng.submitText("hi"), false);
  assert.strictEqual(u.eng.getHistory().length, 0);
  assert.strictEqual(u.ev("notice")[0].code, "model_unavailable");
});

// ---- 7. words from before stop/reset
test("R1.7 stop(): words delivered while the mic finishes never reach the next turn", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.partial("forget all of this");
  t.mic.lateWords = [" forget all of this"];
  t.mic.idleTiming = "after";
  await t.eng.stop();
  t.eng.takeFloor();
  t.mic.final(" new topic please");
  await t.clock.advance(600);
  assert.doesNotMatch(t.model.last().last, /forget/);
  assert.match(t.model.last().last, /new topic please/);
});

test("R1.7b reset(): same, and while the mic is still finishing the words are ignored", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.partial("secret old words");
  let rel;
  t.mic.stopHook = (f) => { rel = f; };
  const p = t.eng.reset();
  t.mic.final(" secret old words"); // delivered mid-finish
  rel();
  await p;
  assert.strictEqual(t.eng.getInfo().utterance, "");
  t.eng.submitText("fresh start");
  await flush();
  assert.doesNotMatch(t.model.last().last, /secret/);
});

test("R1.7c stop() while the mic is finishing, then a quick tap: new words are kept", async () => {
  const t = setup();
  t.eng.takeFloor();
  let rel;
  t.mic.stopHook = (f) => { rel = f; };
  const p = t.eng.stop();
  t.eng.takeFloor();
  t.mic.stopHook = null;
  t.mic.lateWords = [" old session words"];
  t.mic.final("old session words");
  rel();
  await p;
  assert.strictEqual(t.eng.getInfo().utterance, "", "the stopped session's words stay muted until its close finished");
  t.mic.final("hello again my friend");
  assert.strictEqual(t.eng.getInfo().utterance, "hello again my friend", "the new session's words after the close are kept");
});

// ---- 8. voice blocked
test("R1.8 no_gesture: one voice_needs_tap notice, voiceBlocked event, text replies ending idle with yourTurn; resumeVoice lifts it", async () => {
  const t = setup();
  t.voice.rejectNext({ code: "no_gesture", message: "needs a press" });
  const c = await listenAndAsk(t, "tell me about tides");
  c.resolve("Tides come from the moon. And the sun.");
  await flush();
  assert.deepStrictEqual(t.ev("notice").map((n) => n.code), ["voice_needs_tap"]);
  assert.deepStrictEqual(t.ev("voiceBlocked").map((e) => `${e.blocked}:${e.canResume}`), ["true:false", "true:true"]);
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
  assert.strictEqual(t.eng.getHistory()[1].text, "Tides come from the moon. And the sun.");
  const speakCalls = t.voice.calls.length;

  // another voice turn: mic is still closed at commit, no voice call, text reply, idle yourTurn
  t.eng.takeFloor();
  t.mic.final("and the sun?");
  await t.clock.advance(600);
  t.model.last().resolve("The sun matters less. Half as much.");
  await flush();
  assert.strictEqual(t.mic.stopCalls, 2, "mic still closed at commit");
  assert.strictEqual(t.voice.calls.length, speakCalls, "no speak/add while blocked");
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
  assert.strictEqual(t.ev("notice").length, 1, "no repeated notices");

  // resumeVoice: synchronous speak of the last assistant text
  const ok = t.eng.resumeVoice();
  assert.strictEqual(ok, true);
  assert.strictEqual(t.voice.calls.length, speakCalls + 1, "speak called before resumeVoice returned");
  const last = t.voice.calls[t.voice.calls.length - 1];
  assert.strictEqual(last.fn, "speak");
  assert.strictEqual(last.lines[0].text, "The sun matters less. Half as much.");
  assert.strictEqual(t.eng.getState(), "speaking");
  t.voice.position(0, 0, last.lines[0].id);
    assert.deepStrictEqual(t.ev("voiceBlocked").map((e) => `${e.blocked}:${e.canResume}`).slice(-2), ["true:false", "false:false"]);
  t.voice.finishAll();
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  // not blocked any more: replies speak again
  t.eng.submitText("ok");
  await flush();
  t.model.last().resolve("Good, glad that helps. Bye.");
  await flush();
  assert.ok(t.voice.spoken().includes("Good, glad that helps."));
  assert.strictEqual(t.eng.resumeVoice(), false, "not blocked: does nothing");
});

test("R1.8b resumeVoice rejected no_gesture again: block stays, a notice asks to wait", async () => {
  const t = setup();
  t.voice.rejectNext({ code: "no_gesture", message: "x" });
  t.eng.submitText("hi");
  await flush();
  t.model.last().resolve("Hello there, friend. Welcome.");
  await flush();
  t.voice.rejectNext({ code: "no_gesture", message: "x" });
  assert.strictEqual(t.eng.resumeVoice(), true);
  await flush();
  assert.deepStrictEqual(t.ev("voiceBlocked").map((e) => `${e.blocked}:${e.canResume}`), ["true:false", "true:true", "true:false", "true:true"]);
  assert.strictEqual(t.eng.getInfo().voiceBlocked, true);
  const n = t.ev("notice");
  assert.strictEqual(n.length, 2);
  assert.strictEqual(n[1].code, "voice_needs_tap");
  assert.match(n[1].message, /wait/i);
  assert.strictEqual(t.eng.getState(), "idle");
});

test("R1.8c resumeVoice does nothing while the mic is open or the state is not idle", async () => {
  const t = setup();
  t.voice.rejectNext({ code: "no_gesture", message: "x" });
  t.eng.submitText("hi");
  await flush();
  t.model.last().resolve("Hello there, friend. Welcome.");
  await flush();
  t.eng.takeFloor();
  assert.strictEqual(t.eng.resumeVoice(), false);
});

// ---- 9. text-only cut-off
test("R1.9 voice off: a cut-off keeps the text shown so far with cutOff", async () => {
  const t = setup({}, { voice: false });
  const c = await listenAndAsk(t, "explain tides");
  c.chunk("Tides come from the moon pulling the oceans. The sun adds a bit. And");
  await flush();
  t.eng.takeFloor();
  assert.strictEqual(t.ev("turnRemove").length, 0);
  const a = t.eng.getHistory()[1];
  assert.strictEqual(a.cutOff, true);
  assert.strictEqual(a.text, "Tides come from the moon pulling the oceans. The sun adds a bit. And");
  assert.strictEqual(a.show, "");
  assert.strictEqual(t.eng.getState(), "listening");
});

test("R1.9b blocked voice: a cut-off during the text reply keeps the text", async () => {
  const t = setup();
  t.voice.rejectNext({ code: "no_gesture", message: "x" });
  const c = await listenAndAsk(t, "tell me about tides");
  c.chunk("Tides come from the moon. And the sun adds");
  await flush();
  assert.strictEqual(t.eng.getState(), "speaking");
  t.eng.takeFloor();
  assert.strictEqual(t.eng.getHistory()[1].cutOff, true);
  assert.strictEqual(t.eng.getHistory()[1].text, "Tides come from the moon. And the sun adds");
});

// ---- 10. loose activity key
test("R1.10 the recogniser settling a phrase (case, punctuation, empty partial first) is not activity", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.partial("i like cats");
  await t.clock.advance(600);
  const c = t.model.calls[0];
  t.mic.partial("");
  t.mic.final("I like cats.");
  await flush();
  assert.strictEqual(c.signal.aborted, false, "ask not dropped by a settle");
  assert.ok(t.ev("partial").some((e) => e.text === "I like cats."), "display text still updates");
  // and at commit: settle during mic.stop does not force a re-ask
  t.mic.stopHook = (finish) => { t.mic.final(" "); t.mic.partial(""); finish(); };
  c.resolve("Cats are fine, honestly. Dogs are better.");
  await flush();
  assert.strictEqual(t.model.calls.length, 1);
  assert.strictEqual(t.voice.calls[0].lines[0].text, "Cats are fine, honestly.");
  assert.deepStrictEqual(t.decisions(), ["reply:speak"]);
});

test("R1.10c non-Latin speech counts as activity", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.partial("日本語");
  await t.clock.advance(600);
  const c = t.model.calls[0];
  t.mic.partial("日本語です");
  await flush();
  assert.strictEqual(c.signal.aborted, true);
});

test("R1.11 attachment caps are in UTF-8 bytes and never split a character", async () => {
  const t = setup({ maxContextBytes: 25 });
  t.eng.addAttachment({ kind: "text", name: "e.txt", text: "é".repeat(20) }); // 40 bytes
  const a = t.ev("attachment")[0].attachment;
  assert.strictEqual(a.truncated, true);
  assert.strictEqual(a.included, 24);
  assert.strictEqual(a.bytes, 40);
  t.eng.submitText("what is in it");
  await flush();
  const ctx = t.model.calls[0].messages[0].content;
  assert.match(ctx, /--- file: e\.txt ---\né{12}(\n|$)/);
  assert.ok(!/é{13}/.test(ctx));
  assert.strictEqual(DEFAULTS.maxContextBytes, 180000);
  assert.strictEqual(DEFAULTS.maxPromptBytes, 245000);
  assert.strictEqual(DEFAULTS.maxContextChars, undefined);
});

test("R1.11b maxPromptBytes drops the oldest history first, keeping the rules turn and the final turn", async () => {
  const t = setup({ maxPromptBytes: 2600 });
  for (let i = 0; i < 6; i++) {
    t.eng.submitText("message " + i + " " + "x".repeat(300));
    await flush();
    t.model.last().resolve("Reply " + i + " " + "y".repeat(300) + ".");
    await flush();
    t.voice.finishAll();
    await flush();
  }
  t.eng.submitText("the final question");
  await flush();
  const msgs = t.model.last().messages;
  const all = msgs.map((m) => m.content).join("\n");
  assert.match(msgs[0].content, /live voice conversation/);
  assert.match(msgs[msgs.length - 1].content, /the final question/);
  assert.doesNotMatch(all, /message 0 /);
  assert.match(all, /Reply 5 /);
  const bytes = msgs.reduce((n, m) => n + Buffer.byteLength(m.content), 0);
  assert.ok(bytes <= 2600 + 40, "prompt within the cap (merge separators aside): " + bytes);
  // oldest dropped first: whatever survives is a suffix of the history
  const kept = [0, 1, 2, 3, 4, 5].filter((i) => all.includes("message " + i + " "));
  assert.deepStrictEqual(kept, kept.slice().sort().filter((_, idx, arr) => idx === arr.length - kept.length + idx));
  assert.ok(kept.length < 6 && kept.length >= 1);
  assert.strictEqual(kept[kept.length - 1], 5);
});

test("R1.11c strict history cap: exactly the most recent 40 turns are sent", async () => {
  const u = setup();
  for (let i = 0; i < 30; i++) {
    u.eng.submitText("message " + i);
    await flush();
    u.model.last().resolve("Reply number " + i + " is here.");
    await flush();
    u.voice.finishAll();
    await flush();
  }
  assert.strictEqual(u.eng.getHistory().length, 60);
  u.eng.submitText("final");
  await flush();
  const all = u.model.last().messages.map((m) => m.content).join("\n");
  const users = [...all.matchAll(/message (\d+)(?!\d)/g)].map((m) => Number(m[1]));
  const replies = [...all.matchAll(/Reply number (\d+) is here/g)].map((m) => Number(m[1]));
  assert.deepStrictEqual(users, Array.from({ length: 20 }, (_, i) => i + 10));
  assert.deepStrictEqual(replies, Array.from({ length: 20 }, (_, i) => i + 10));
});

// ---- 12. mic really closed before speaking
test("R1.12 mic.stop() resolved but still active: wait for idle before speaking", async () => {
  const t = setup();
  t.mic.idleTiming = "never";
  const c = await listenAndAsk(t, "tell me about tides");
  c.resolve("Tides come from the moon. And the sun.");
  await flush();
  assert.strictEqual(t.voice.calls.length, 0, "mic still active, not speaking yet");
  assert.strictEqual(t.eng.getState(), "thinking");
  t.mic.end("stopped"); // idle arrives
  await flush();
  assert.strictEqual(t.voice.calls[0].micActive, false);
  assert.strictEqual(t.voice.busyRejects, 0);
  assert.strictEqual(t.eng.getState(), "speaking");
});

test("R1.12b idle never arrives: after ~1500ms the reply shows as text, voice_failed, and the still-active mic means listening", async () => {
  const t = setup();
  t.mic.idleTiming = "never";
  const c = await listenAndAsk(t, "tell me about tides");
  c.resolve("Tides come from the moon. And the sun.");
  await flush();
  await t.clock.advance(1499);
  assert.strictEqual(t.eng.getState(), "thinking");
  await t.clock.advance(1);
  assert.strictEqual(t.voice.calls.length, 0);
  assert.strictEqual(t.mic.isActive, true);
  assert.strictEqual(t.eng.getState(), "listening", "the mic really is open");
  assert.strictEqual(t.ev("notice").pop().code, "voice_failed");
  assert.strictEqual(t.eng.getHistory()[1].text, "Tides come from the moon. And the sun.");
  // once the mic really closes the engine is idle-capable again: a tap restarts it
  t.mic.end("stopped");
});

test("R1.12c mic.stop() rejecting: no speech, text reply, and no stop-and-re-ask cycle on later commits", async () => {
  const t = setup();
  t.mic.stopReject = { code: "upstream_error", message: "boom" };
  t.mic.lateWords = [" and something more"];
  const c = await listenAndAsk(t, "tell me about tides");
  c.resolve("Tides come from the moon. And the sun.");
  await flush();
  assert.strictEqual(t.voice.calls.length, 0);
  assert.strictEqual(t.model.calls.length, 1, "late words do not trigger a re-ask");
  assert.strictEqual(t.eng.getState(), "listening", "stop failed and the mic is still active");
  assert.strictEqual(t.ev("notice").pop().code, "voice_failed");
  assert.deepStrictEqual(t.eng.getHistory().map((x) => x.text), ["tell me about tides and something more", "Tides come from the moon. And the sun."]);
  // later commit: mic is still treated as open, still no speech, still no re-ask
  t.eng.takeFloor();
  t.mic.final("and the sun?");
  await t.clock.advance(600);
  t.mic.lateWords = [" more late words"];
  const before = t.model.calls.length;
  t.model.last().resolve("The sun matters less. Half as much.");
  await flush();
  assert.strictEqual(t.voice.calls.length, 0);
  assert.strictEqual(t.model.calls.length, before, "no re-ask after the failed close");
  assert.ok(t.model.calls.every((c) => c.mode !== "forced"));
  assert.strictEqual(t.eng.getHistory().filter((x) => x.role === "assistant").length, 2);
});

test("R1.12d a busy rejection from the voice is the same fallback and does not mark the voice unavailable", async () => {
  const t = setup();
  t.voice.rejectNext({ code: "busy", message: "mic open" });
  const c = await listenAndAsk(t, "tell me about tides");
  c.resolve("Tides come from the moon. And the sun.");
  await flush();
  assert.strictEqual(t.ev("notice").pop().code, "voice_failed");
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.eng.getInfo().voiceAvailable, true);
  assert.strictEqual(t.eng.getInfo().voiceBlocked, false);
  t.eng.submitText("again");
  await flush();
  t.model.last().resolve("Fine, noted. Moving on.");
  await flush();
  assert.ok(t.voice.spoken().includes("Fine, noted."));
});

// ---- 13. marker position
test("R1.13 the cut-off marker is the very last thing, after the show block", async () => {
  const t = setup({ rate: 1.0 });
  const c = await listenAndAsk(t, "tell me about the sky");
  c.resolve("Honestly that claim does not hold up. And here is why it fails. <show>detail</show>");
  await flush();
  t.voice.position(1500, 0, t.voice.calls[0].lines[0].id);
  t.eng.takeFloor();
  t.mic.final("no");
  await t.clock.advance(600);
  const a = t.model.last().messages.find((m) => m.role === "assistant").content;
  assert.ok(a.endsWith(" [cut off by user]"), a);
  assert.ok(a.indexOf("<show>detail</show>") < a.indexOf("[cut off by user]"));
});

// ---- 14. long first sentence
test("R1.14 no line handed to the voice exceeds 1800 characters, even the first sentence", async () => {
  const t = setup();
  t.eng.submitText("go");
  await flush();
  const long = "word, ".repeat(500).trim() + ". Next bit.";
  t.model.last().chunk(long);
  await flush();
  assert.strictEqual(t.voice.calls[0].fn, "speak");
  t.model.last().resolve(long);
  await flush();
  assert.ok(t.voice.calls.length >= 3);
  t.voice.calls.forEach((c) => c.lines.forEach((l) => assert.ok(l.text.length <= 1800, l.text.length)));
  assert.strictEqual(t.voice.calls.slice(1).every((c) => c.fn === "add"), true);
  assert.strictEqual(t.voice.spoken().join(" ").replace(/\s+/g, " "), long);
  const ids = t.voice.calls.map((c) => c.lines[0].id);
  assert.strictEqual(new Set(ids).size, ids.length);

  const u = setup();
  u.eng.submitText("go");
  await flush();
  u.model.last().resolve("x".repeat(4000)); // no boundary at all: hard split
  await flush();
  u.voice.calls.forEach((c) => c.lines.forEach((l) => assert.ok(l.text.length <= 1800)));
});

// ---- 15. mic errors
test("R1.15 a failed start() also emits idle(same reason): exactly one notice", async () => {
  for (const [code, notice, stillAvailable] of [
    ["upstream_error", "mic_error", true], ["rate_limited", "mic_error", true], ["weird_new_code", "mic_error", true],
    ["unavailable", "mic_unavailable", false], ["not_granted", "mic_denied", false],
  ]) {
    const t = setup();
    t.mic.startError = { code, message: "developer text " + code };
    t.eng.takeFloor();
    await flush();
    const n = t.ev("notice");
    assert.strictEqual(n.length, 1, code);
    assert.strictEqual(n[0].code, notice, code);
    assert.strictEqual(n[0].detail.reason, code);
    assert.doesNotMatch(n[0].message, /developer text/);
    assert.strictEqual(t.eng.getState(), "idle");
    t.mic.startError = null;
    t.eng.takeFloor();
    assert.strictEqual(t.mic.startCalls, stillAvailable ? 2 : 1, code);
    if (!stillAvailable) assert.strictEqual(t.eng.getInfo().micAvailable, false);
  }
});

test("R1.15b the mic ending mid-session with upstream_error or rate_limited: one mic_error notice, mic stays available", async () => {
  for (const reason of ["upstream_error", "rate_limited"]) {
    const t = setup();
    t.eng.takeFloor();
    t.mic.end(reason);
    await flush();
    assert.deepStrictEqual(t.ev("notice").map((n) => n.code), ["mic_error"]);
    assert.strictEqual(t.eng.getState(), "idle");
    t.eng.takeFloor();
    assert.strictEqual(t.mic.startCalls, 2);
  }
  const u = setup();
  u.eng.takeFloor();
  u.mic.end("unavailable");
  assert.deepStrictEqual(u.ev("notice").map((n) => n.code), ["mic_unavailable"]);
  u.eng.takeFloor();
  assert.strictEqual(u.mic.startCalls, 1);
});

// ---- 16. describe decisions
test("R1.16 removing an attachment whose describe is in flight still emits a dropped decision", async () => {
  const t = setup();
  const id = t.eng.addAttachment({ kind: "image", name: "p.png", blob: {} });
  t.eng.removeAttachment(id);
  await flush();
  assert.deepStrictEqual(t.decisions(), ["describe:dropped"]);
});

test("R1.16b a describe ask that fails: decision error, notice names the file, blob still sent with the next ask", async () => {
  const t = setup();
  t.eng.addAttachment({ kind: "image", name: "p.png", blob: { b: 1 } });
  t.model.calls[0].reject({ code: "upstream_error", message: "dev text" });
  await flush();
  assert.deepStrictEqual(t.decisions(), ["describe:error"]);
  const n = t.ev("notice")[0];
  assert.strictEqual(n.code, "error");
  assert.strictEqual(n.detail.name, "p.png");
  assert.strictEqual(t.ev("attachment").pop().attachment.describing, undefined);
  t.eng.submitText("look");
  await flush();
  assert.deepStrictEqual(t.model.last().opts.images, [{ b: 1 }]);
});

// ---- also: takeFloor with no mic, image note, notice detail, voice not_granted, submit during close
test("R1.A takeFloor() with no mic cuts Claude off and goes idle with yourTurn; notice only when nothing to cut", async () => {
  const t = setup({ rate: 1.0 }, { mic: false });
  t.eng.submitText("tell me about tides");
  await flush();
  t.model.last().resolve("Honestly that claim does not hold up at all. More words.");
  await flush();
  assert.strictEqual(t.eng.getState(), "speaking");
  t.voice.position(0, 0, t.voice.calls[0].lines[0].id);
  t.voice.position(1000, 0, t.voice.calls[0].lines[0].id);
  t.eng.takeFloor();
  assert.strictEqual(t.voice.stopCalls, 1);
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
  assert.strictEqual(t.ev("notice").length, 0);
  assert.strictEqual(t.eng.getHistory()[1].cutOff, true);
  t.eng.takeFloor();
  assert.strictEqual(t.ev("notice").pop().code, "mic_unavailable");
});

test("R1.B a reply ask that carries an image says so in the final user turn", async () => {
  const t = setup();
  t.eng.addAttachment({ kind: "image", name: "pic.png", blob: { b: 1 } });
  t.model.calls[0].resolve("A heron.");
  await flush();
  t.eng.submitText("what is it");
  await flush();
  const msgs = t.model.last().messages;
  assert.match(msgs[msgs.length - 1].content, /An image named pic\.png is attached to this message\./);
});

test("R1.C notices carry a detail object and a plain message, never the platform's own text", async () => {
  const t = setup();
  t.eng.submitText("hello");
  await flush();
  t.model.last().reject({ code: "not_granted", message: "DEV: consent declined" });
  await flush();
  const n = t.ev("notice")[0];
  assert.strictEqual(n.code, "model_unavailable");
  assert.strictEqual(n.detail.reason, "not_granted");
  assert.doesNotMatch(n.message, /DEV/);
  const u = setup();
  u.eng.submitText("hello");
  await flush();
  u.model.last().reject({ code: "sampling_disabled", message: "DEV: off" });
  await flush();
  assert.strictEqual(u.ev("notice")[0].detail.reason, "sampling_disabled");
  const w = setup();
  w.eng.submitText("hello");
  await flush();
  w.model.last().reject({ code: "weird", message: "DEV: boom" });
  await flush();
  assert.strictEqual(w.ev("notice")[0].code, "error");
  assert.doesNotMatch(w.ev("notice")[0].message, /DEV/);
  for (const e of [...t.ev("notice"), ...u.ev("notice"), ...w.ev("notice")]) assert.strictEqual(typeof e.detail, "object");
});

test("R1.D voice rejecting not_granted mid-conversation: notice, text replies, mic stays open afterwards", async () => {
  const t = setup();
  t.voice.rejectNext({ code: "not_granted", message: "dev" });
  const c = await listenAndAsk(t, "tell me about tides");
  c.resolve("Tides come from the moon. And the sun.");
  await flush();
  assert.strictEqual(t.ev("notice").pop().code, "voice_failed");
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.eng.getInfo().voiceAvailable, false);
  t.eng.takeFloor();
  t.mic.final("and the sun?");
  await t.clock.advance(600);
  const stops = t.mic.stopCalls;
  t.model.last().resolve("The sun matters less. Half as much.");
  await flush();
  assert.strictEqual(t.mic.stopCalls, stops, "voice unavailable: the mic is not closed");
  assert.strictEqual(t.eng.getState(), "listening");
  assert.strictEqual(t.eng.getHistory()[3].text, "The sun matters less. Half as much.");
});

test("R1.E submitText while a commit is closing the mic: old commit abandoned, typed turn folds the spoken words", async () => {
  const t = setup();
  const c = await listenAndAsk(t, "so about the thing");
  let rel;
  t.mic.stopHook = (f) => { rel = f; };
  c.resolve("The thing is fine. Next.");
  await flush();
  assert.strictEqual(t.eng.getState(), "thinking");
  assert.strictEqual(t.eng.submitText("which thing?"), true);
  t.mic.stopHook = null;
  rel();
  await flush();
  assert.strictEqual(t.voice.calls.length, 0, "the abandoned reply is never spoken");
  assert.deepStrictEqual(t.eng.getHistory().map((x) => [x.role, x.text, !!x.typed]), [["user", "so about the thing which thing?", true]]);
  const second = t.model.last();
  assert.match(second.last, /so about the thing which thing\?/);
  second.resolve("The thing you said. Tell me more.");
  await flush();
  assert.strictEqual(t.voice.calls[0].micActive, false);
  assert.strictEqual(t.voice.calls[0].lines[0].text, "The thing you said.");
  assert.strictEqual(t.eng.getHistory().length, 2);
});

test("R1.F the voice onState events and a clean full conversation never reach busy", async () => {
  const t = setup();
  for (let i = 0; i < 3; i++) {
    t.eng.takeFloor();
    t.mic.final("turn number " + i + " is about cats");
    await t.clock.advance(600);
    t.model.last().resolve("Cats are great. Truly so.");
    await flush();
    t.voice.finishAll();
    await flush();
    assert.strictEqual(t.eng.getState(), "idle");
  }
  assert.strictEqual(t.voice.busyRejects, 0);
  assert.strictEqual(t.mic.startCalls, 3);
});

// =====================================================================
// Review round 2
// =====================================================================

async function blockedReply(t, rate) {
  t.eng.takeFloor();
  t.mic.final("write me a loop");
  await t.clock.advance(600);
  t.voice.rejectNext({ code: "no_gesture", message: "press first" });
  t.model.last().resolve("Here is a loop that counts. It is short. <show>for(;;){}</show>");
  await flush();
  await flush();
}
const snap = (t) => JSON.stringify(t.eng.getHistory());

test("R2.1 a replay never writes to a turn: show survives, no turnUpdate/turnRemove/cutOff", async () => {
  const t = setup({ rate: 1 });
  await blockedReply(t);
  const before = snap(t);
  const n = t.events.length;
  assert.strictEqual(t.eng.resumeVoice(), true);
  assert.strictEqual(t.eng.getState(), "speaking");
  t.voice.finishAll();
  await flush();
  assert.strictEqual(snap(t), before);
  assert.strictEqual(t.eng.getHistory()[1].show, "for(;;){}");
  const added = t.events.slice(n);
  assert.deepStrictEqual(added.filter((e) => ["turn", "turnUpdate", "turnRemove", "decision"].includes(e.type)), []);
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
});

test("R2.1b cutting a replay off (tap, typed message, Stop) before or after audio leaves history untouched", async () => {
  for (const how of ["tap", "type", "stop", "stopAfterAudio", "platform"]) {
    const t = setup({ rate: 1 });
    await blockedReply(t);
    const before = snap(t);
    t.eng.resumeVoice();
    const call = t.voice.calls[t.voice.calls.length - 1];
    if (how === "stopAfterAudio" || how === "platform") t.voice.position(1100, 0, call.lines[0].id);
    const n = t.events.length;
    if (how === "tap") t.eng.takeFloor();
    else if (how === "type") { t.eng.submitText("hello"); }
    else if (how === "platform") { t.voice.platformStop(); await flush(); }
    else await t.eng.stop();
    await flush();
    const evs = t.events.slice(n);
    assert.deepStrictEqual(evs.filter((e) => e.type === "turnRemove" || e.type === "turnUpdate"), [], how);
    const h = t.eng.getHistory();
    assert.strictEqual(h[1].cutOff, undefined, how);
    assert.strictEqual(h[1].text, "Here is a loop that counts. It is short.", how);
    assert.strictEqual(h[1].show, "for(;;){}", how);
    if (how !== "type") assert.strictEqual(JSON.stringify(h), before, how);
    assert.ok(t.voice.stopCalls >= 1, how);
  }
});

test("R2.1c with no assistant turn to replay, resumeVoice speaks 'Voice is back on.' and lifts the block", async () => {
  const t = setup();
  t.voice.rejectNext({ code: "no_gesture", message: "x" });
  t.eng.submitText("hi");
  await flush();
  t.model.last().reject({ code: "upstream_error", message: "x" }); // no assistant turn at all
  await flush();
  t.eng.resumeVoice(); // not blocked yet: the voice was never tried
  assert.strictEqual(t.eng.getInfo().voiceBlocked, false);
  // now block it for real, with an empty history of assistant turns
  const u = setup();
  u.eng.takeFloor();
  u.mic.final("hello there");
  await u.clock.advance(600);
  u.voice.rejectNext({ code: "no_gesture", message: "x" });
  u.model.last().resolve("<show>only a block</show>");
  await flush();
  u.eng.submitText("again");
  await flush();
  u.voice.rejectNext({ code: "no_gesture", message: "x" });
  u.model.last().resolve("Hello back, friend. Welcome.");
  await flush();
  assert.strictEqual(u.eng.getInfo().voiceBlocked, true);
  const v = setup();
  v.eng.takeFloor();
  v.mic.final("hello there");
  await v.clock.advance(600);
  v.voice.rejectNext({ code: "no_gesture", message: "x" });
  v.model.last().resolve("Hi there, friend. Welcome.");
  await flush();
  v.eng.reset(); // history cleared, block stays
  await flush();
  assert.strictEqual(v.eng.getInfo().voiceBlocked, true);
  assert.strictEqual(v.eng.resumeVoice(), true);
  assert.strictEqual(v.voice.calls[v.voice.calls.length - 1].lines[0].text, "Voice is back on.");
  v.voice.position(0, 0, v.voice.calls[v.voice.calls.length - 1].lines[0].id);
  assert.strictEqual(v.eng.getInfo().voiceBlocked, false);
  assert.strictEqual(v.eng.getHistory().length, 0);
});

test("R2.1d resumeVoice returns false only when not blocked, not idle, or the mic is active", async () => {
  const t = setup();
  assert.strictEqual(t.eng.resumeVoice(), false);
  await blockedReply(t);
  t.eng.takeFloor();
  assert.strictEqual(t.eng.resumeVoice(), false);
});

test("R2.3 an errored commit with late words: user turn kept, idle with yourTurn, no new ask", async () => {
  const t = setup();
  const c = await listenAndAsk(t, "I like cats");
  let rel;
  t.mic.stopHook = (f) => { rel = f; };
  t.mic.lateWords = [" and dogs"];
  c.chunk("Cats are fine, honestly. Dogs");
  await flush();
  c.reject({ code: "rate_limited", message: "slow" });
  await flush();
  rel();
  await t.clock.advance(60000);
  assert.strictEqual(t.model.calls.length, 1);
  assert.deepStrictEqual(t.eng.getHistory().map((x) => [x.role, x.text]), [["user", "I like cats and dogs"]]);
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
  assert.deepStrictEqual(t.voice.calls, []);
});

test("R2.4 tapping during stop()'s mic close: the stopped session's late words never reach the new turn", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.partial("forget all of this");
  let rel;
  t.mic.stopHook = (f) => { rel = f; };
  t.mic.lateWords = [" forget all of this"];
  const p = t.eng.stop();
  t.eng.takeFloor();
  assert.strictEqual(t.mic.startCalls, 2);
  t.mic.stopHook = null;
  rel();
  await p;
  t.mic.final(" new topic");
  await t.clock.advance(600);
  assert.doesNotMatch(t.model.last().last, /forget/);
  assert.match(t.model.last().last, /new topic/);
  // reset() behaves the same
  const u = setup();
  u.eng.takeFloor();
  let rel2;
  u.mic.stopHook = (f) => { rel2 = f; };
  u.mic.lateWords = [" secret"];
  const p2 = u.eng.reset();
  u.eng.takeFloor();
  u.mic.stopHook = null;
  rel2();
  await p2;
  u.mic.final("fresh words here");
  await u.clock.advance(600);
  assert.doesNotMatch(u.model.last().last, /secret/);
});

test("R2.5 a live guess withdrawn with \"\" and never settled is not part of the user's turn", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("tell me about tides");
  t.mic.partial("uh");
  t.mic.partial("");
  await t.clock.advance(600);
  assert.doesNotMatch(t.model.last().last, /uh/);
  t.model.last().resolve("Sure. The moon does most of it.");
  await flush();
  assert.strictEqual(t.eng.getHistory()[0].text, "tell me about tides");
  assert.strictEqual(t.ev("partial").some((e) => e.text === "tell me about tides uh") && t.ev("partial").pop().text, "");
  // a final that follows is used as usual
  const u = setup();
  u.eng.takeFloor();
  u.mic.final("tell me");
  u.mic.partial("about tides");
  u.mic.partial("");
  u.mic.final(" about tides");
  await u.clock.advance(600);
  assert.match(u.model.last().last, /tell me about tides/);
  // only a withdrawn guess: nothing to reply to
  const w = setup();
  w.eng.takeFloor();
  w.mic.partial("uh");
  w.mic.partial("");
  await w.clock.advance(5000);
  assert.strictEqual(w.model.calls.length, 0);
});

test("R2.6 maxPromptBytes also covers attachments and the final message", async () => {
  const t = setup();
  t.eng.addAttachment({ kind: "text", name: "big.txt", text: "x".repeat(180000) });
  t.eng.submitText("y".repeat(90000));
  await flush();
  const msgs = t.model.last().messages;
  const bytes = msgs.reduce((n, m) => n + Buffer.byteLength(m.content), 0);
  assert.ok(bytes <= 245000, "prompt bytes " + bytes);
  assert.match(msgs[0].content, /live voice conversation/);
  const n = t.ev("notice").filter((e) => e.detail.reason === "prompt_trimmed");
  assert.strictEqual(n.length, 1);
  assert.strictEqual(n[0].code, "error");
  assert.strictEqual(t.eng.getHistory()[0].text.length, 90000, "history keeps the full message");

  // when attachments cannot help, the middle of the final message is cut with a marker
  const u = setup({ maxPromptBytes: 5000 });
  u.eng.submitText("HEAD" + "z".repeat(20000) + "TAIL");
  await flush();
  const last = u.model.last().messages.slice(-1)[0].content;
  assert.match(last, /\nHEAD/);
  assert.match(last, /TAIL\n\nReply now/);
  assert.match(last, /\[\.\.\. \d+ characters left out \.\.\.\]/);
  assert.ok(u.model.last().messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0) <= 5000);
  u.model.last().resolve("Okay, noted. Moving on.");
  await flush();
  u.voice.finishAll();
  await flush();
  u.eng.submitText("q".repeat(20000));
  await flush();
  assert.strictEqual(u.ev("notice").filter((e) => e.detail.reason === "prompt_trimmed").length, 1, "once per conversation");
  await u.eng.reset();
  u.eng.submitText("w".repeat(20000));
  await flush();
  assert.strictEqual(u.ev("notice").filter((e) => e.detail.reason === "prompt_trimmed").length, 2, "reset re-arms the notice");
});

test("R2.7 failed mic close ends in listening while mic.active() is true; idle only when really closed", async () => {
  const t = setup();
  t.mic.stopReject = { code: "x", message: "boom" };
  const c = await listenAndAsk(t, "tell me about tides");
  c.resolve("Tides come from the moon. And the sun.");
  await flush();
  assert.strictEqual(t.mic.isActive, true);
  assert.strictEqual(t.eng.getState(), "listening");
  // stop() rejects but the mic is in fact inactive: that counts as closed, so the voice may speak
  const u = setup();
  u.mic.stop = function () { u.mic.stopCalls++; u.mic.isActive = false; return Promise.reject({ code: "x", message: "boom" }); };
  const c2 = await listenAndAsk(u, "tell me about tides");
  c2.resolve("Tides come from the moon. And the sun.");
  await flush();
  assert.strictEqual(u.voice.calls[0].micActive, false);
  assert.strictEqual(u.eng.getState(), "speaking");
});

test("R2.8 voiceBlocked carries canResume and is re-emitted when it changes; reset re-emits without lifting the block", async () => {
  const t = setup();
  await blockedReply(t);
  const seq = () => t.ev("voiceBlocked").map((e) => `${e.blocked}:${e.canResume}`);
  assert.deepStrictEqual(seq(), ["true:false", "true:true"]);
  t.eng.takeFloor(); // mic opens: a tap would not work
  assert.deepStrictEqual(seq().slice(-1), ["true:false"]);
  await t.eng.stop();
  await flush();
  assert.deepStrictEqual(seq().slice(-1), ["true:true"], "idle with the mic closed: resumable again");
  assert.strictEqual(t.eng.getInfo().voiceBlocked, true, "stop() does not lift the block");
  const n = seq().length;
  await t.eng.reset();
  const ev = t.ev("voiceBlocked").slice(n);
  assert.ok(ev.length >= 1);
  assert.deepStrictEqual([ev[ev.length - 1].blocked, ev[ev.length - 1].canResume], [true, true]);
  assert.strictEqual(t.eng.getInfo().voiceBlocked, true, "reset() does not lift the block");
  // reset when not blocked re-emits the (false, false) values too
  const u = setup();
  await u.eng.reset();
  assert.deepStrictEqual(u.ev("voiceBlocked").map((e) => `${e.blocked}:${e.canResume}`), ["false:false"]);
});

// =====================================================================
// Review round 3
// =====================================================================

test("R3.T1 a final that follows a withdrawn guess after the pause check ran is new input: the reply still happens", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.partial("hello there how are you");
  t.mic.partial("");
  await t.clock.advance(650); // pause timer fires in the gap and finds nothing to ask about
  assert.strictEqual(t.model.calls.length, 0);
  t.mic.final("hello there how are you");
  await t.clock.advance(600);
  assert.strictEqual(t.model.calls.length, 1);
  assert.match(t.model.calls[0].last, /hello there how are you/);
});

test("R3.T1b a final after a withdrawn guess drops a reply ask that went out without the last phrase", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.final("I think the moon");
  t.mic.partial("is made of cheese");
  t.mic.partial("");
  await t.clock.advance(650);
  const first = t.model.calls[0];
  assert.doesNotMatch(first.last, /cheese/);
  t.mic.final(" is made of cheese");
  await flush();
  assert.strictEqual(first.signal.aborted, true);
  await t.clock.advance(600);
  assert.match(t.model.last().last, /I think the moon is made of cheese/);
});

test("R3.T1c a guess settling straight into a final with no pause check in between is not activity", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.partial("i like cats");
  await t.clock.advance(600);
  const c = t.model.calls[0];
  t.mic.partial("");
  t.mic.final("I like cats.");
  await flush();
  assert.strictEqual(c.signal.aborted, false);
});

test("R3.T2 after Stop and a quick tap, the new session's words are accepted as soon as the old one is idle", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.partial("forget this");
  let rel;
  t.mic.stopHook = (f) => { rel = f; };
  const p = t.eng.stop();
  t.eng.takeFloor();
  t.mic.stopHook = null;
  rel();
  t.mic.isActive = true; // the new session is active
  await flush();
  t.mic.final("new words right away");
  assert.strictEqual(t.eng.getInfo().utterance, "new words right away");
  await t.clock.advance(1500); // the stop() promise itself may wait for the active/idle check
  await p;
});

test("R3.T4 a mic.stop() that never settles cannot keep the engine deaf", async () => {
  const t = setup();
  t.eng.takeFloor();
  t.mic.partial("x");
  t.mic.stop = () => new Promise(() => {});
  t.eng.stop();
  t.mic.isActive = false;
  t.eng.takeFloor();
  t.mic.isActive = true;
  t.mic.final("ignored while the old session is closing");
  assert.strictEqual(t.eng.getInfo().utterance, "");
  await t.clock.advance(3000);
  t.mic.final("can you hear me");
  assert.strictEqual(t.eng.getInfo().utterance, "can you hear me");
  await t.clock.advance(600);
  assert.strictEqual(t.model.calls.length, 1);
});

test("R3.T4b a commit whose mic.stop() never settles falls back to text instead of hanging", async () => {
  const t = setup();
  const c = await listenAndAsk(t, "tell me about tides");
  t.mic.stop = () => new Promise(() => {});
  c.resolve("Tides come from the moon. And the sun.");
  await flush();
  assert.strictEqual(t.eng.getState(), "thinking");
  await t.clock.advance(3000);
  assert.strictEqual(t.voice.calls.length, 0);
  assert.notStrictEqual(t.eng.getState(), "thinking");
  assert.strictEqual(t.ev("notice").pop().code, "voice_failed");
  assert.strictEqual(t.eng.getHistory()[1].text, "Tides come from the moon. And the sun.");
});

test("R3.T3 canResume needs a usable voice; marking the voice unavailable clears the block", async () => {
  const t = setup();
  await blockedReply(t);
  assert.strictEqual(t.ev("voiceBlocked").pop().canResume, true);
  t.voice.rejectNext({ code: "not_granted", message: "off" });
  assert.strictEqual(t.eng.resumeVoice(), true);
  await flush();
  const vb = t.ev("voiceBlocked").pop();
  assert.deepStrictEqual([vb.blocked, vb.canResume], [false, false]);
  assert.strictEqual(t.eng.getInfo().voiceBlocked, false);
  assert.strictEqual(t.eng.resumeVoice(), false);
});

test("R3.replay cutting a replay off lifts the block, unless the speak was rejected no_gesture", async () => {
  for (const how of ["tap", "type", "stop"]) {
    const t = setup();
    await blockedReply(t);
    assert.strictEqual(t.eng.resumeVoice(), true);
    if (how === "tap") t.eng.takeFloor();
    else if (how === "type") t.eng.submitText("hello");
    else await t.eng.stop();
    await flush();
    assert.strictEqual(t.eng.getInfo().voiceBlocked, false, how);
    assert.strictEqual(t.ev("voiceBlocked").pop().blocked, false, how);
  }
  const u = setup();
  await blockedReply(u);
  u.voice.rejectNext({ code: "no_gesture", message: "x" });
  assert.strictEqual(u.eng.resumeVoice(), true);
  await flush();
  assert.strictEqual(u.eng.getInfo().voiceBlocked, true);
});

// =====================================================================
// Phase 2: full duplex
// =====================================================================

function dup(cfg = {}, caps = {}) {
  const t = setup(Object.assign({ duplex: true, rate: 1.0 }, cfg), caps);
  t.voice.ignoreMic = true; // the local voice never rejects busy
  return t;
}
const REPLY = "Tides come from the moon. And the sun adds a bit.";
async function dupSpeaking(t, words = "tell me about tides") {
  t.eng.takeFloor();
  t.mic.final(words);
  await t.clock.advance(600);
  t.model.last().resolve(REPLY);
  await flush();
  assert.strictEqual(t.eng.getState(), "speaking");
}
const bi = (t) => t.events.filter((e) => e.type === "decision" && e.kind === "bargeIn").map((e) => `${e.result}:${e.detail}`);

test("D1 duplex: the mic stays open through commit and speech; a finished reply returns to listening", async () => {
  const t = dup();
  await dupSpeaking(t);
  assert.strictEqual(t.mic.stopCalls, 0);
  assert.strictEqual(t.mic.isActive, true);
  assert.strictEqual(t.voice.calls[0].micActive, true);
  t.voice.finishAll();
  await flush();
  assert.strictEqual(t.eng.getState(), "listening");
  assert.deepStrictEqual(t.ev("state").filter((e) => e.state === "idle" && e.yourTurn), []);
  assert.strictEqual(t.mic.startCalls, 1);
});

test("D2 two real words while speaking cut Claude off; they (and the rest of the phrase) start the next utterance", async () => {
  const t = dup();
  await dupSpeaking(t);
  const id0 = t.voice.calls[0].lines[0].id;
  t.voice.position(0, 0, id0);
  t.voice.position(1000, 0, id0);
  t.mic.partial("no that");
  await flush();
  assert.strictEqual(t.voice.stopCalls, 1);
  assert.strictEqual(t.eng.getState(), "listening");
  assert.strictEqual(t.eng.getHistory()[1].cutOff, true);
  assert.strictEqual(t.eng.getInfo().utterance, "no that");
  t.mic.partial("no that is wrong");
  t.mic.partial("no that is wrong because");
  t.mic.final("no that is wrong because of gravity");
  assert.strictEqual(t.eng.getInfo().utterance, "no that is wrong because of gravity");
  assert.deepStrictEqual(bi(t), ["cut:no that"], "exactly one cut for the phrase");
  assert.strictEqual(t.mic.startCalls, 1, "no mic.start without a tap");
  await t.clock.advance(600);
  assert.strictEqual(t.model.last().mode, "paused");
  assert.match(t.model.last().last, /no that is wrong because of gravity/);
});

test("D3 a lone backchannel does not stop Claude; one decision per phrase", async () => {
  const t = dup();
  await dupSpeaking(t);
  t.mic.partial("yeah");
  t.mic.final("yeah");
  await flush();
  assert.strictEqual(t.eng.getState(), "speaking");
  assert.strictEqual(t.voice.stopCalls, 0);
  assert.deepStrictEqual(bi(t), ["ignored:backchannel"]);
  t.mic.final("mm-hm");
  t.mic.final(" I see");
  assert.deepStrictEqual(bi(t), ["ignored:backchannel", "ignored:backchannel", "ignored:backchannel"]);
  assert.strictEqual(t.eng.getInfo().utterance, "");
  assert.strictEqual(t.eng.getState(), "speaking");
});

test("D4 a lone stop word stops Claude", async () => {
  const t = dup();
  await dupSpeaking(t);
  t.mic.partial("stop");
  await flush();
  assert.strictEqual(t.eng.getState(), "listening");
  assert.strictEqual(t.voice.stopCalls, 1);
  assert.deepStrictEqual(bi(t), ["cut:stop"]);
  const u = dup();
  await dupSpeaking(u);
  u.mic.final("hold on");
  assert.strictEqual(u.eng.getState(), "listening");
  const w = dup();
  await dupSpeaking(w);
  w.mic.partial("cats");
  assert.strictEqual(w.eng.getState(), "speaking", "one ordinary word is under bargeInMinWords");
});

test("D5 pure echo of the reply is ignored during speech and for the tail after it", async () => {
  const t = dup();
  await dupSpeaking(t);
  t.mic.partial("tides");
  t.mic.partial("tides come from");
  t.mic.partial("tides come from the moon");
  t.mic.final("tides come from the moon");
  await flush();
  assert.strictEqual(t.eng.getState(), "speaking");
  assert.strictEqual(t.voice.stopCalls, 0);
  assert.deepStrictEqual(bi(t), ["ignored:echo"], "once per phrase");
  t.voice.finishAll();
  await flush();
  assert.strictEqual(t.eng.getState(), "listening");
  await t.clock.advance(500);
  t.mic.partial("and the sun adds");
  t.mic.final(" and the sun adds a bit");
  await t.clock.advance(5000);
  assert.strictEqual(t.eng.getInfo().utterance, "", "Claude's own voice is not an utterance");
  assert.strictEqual(t.model.calls.length, 1, "Claude never answers its own voice");
  // after the tail the same words are the user's
  await t.clock.advance(1500);
  t.mic.final(" and the sun adds a bit");
  assert.strictEqual(t.eng.getInfo().utterance, "and the sun adds a bit");
});

test("D6 echo plus real words is a barge-in and only the real words are kept, through the rest of the phrase", async () => {
  const t = dup();
  await dupSpeaking(t);
  t.mic.partial("tides come from the moon I really");
  assert.strictEqual(t.eng.getState(), "speaking", "two leftover words next to an echo span are probably misheard");
  t.mic.partial("tides come from the moon I really disagree with that");
  assert.strictEqual(t.eng.getState(), "listening");
  assert.strictEqual(t.eng.getInfo().utterance, "I really disagree with that");
  t.mic.final("tides come from the moon I really disagree with that point");
  assert.strictEqual(t.eng.getInfo().utterance, "I really disagree with that point");
  assert.deepStrictEqual(bi(t), ["ignored:mishearing", "cut:I really disagree with that"]);
  await t.clock.advance(600);
  assert.doesNotMatch(t.model.last().last.split("\n\n").slice(-2, -1)[0], /tides/);
});

test("D7 with echoGuard off the same echo words cut in", async () => {
  const t = dup({ echoGuard: false });
  await dupSpeaking(t);
  t.mic.partial("tides come from");
  assert.strictEqual(t.eng.getState(), "listening");
  assert.strictEqual(t.eng.getInfo().utterance, "tides come from");
  assert.deepStrictEqual(bi(t), ["cut:tides come from"]);
});

test("D8 a cut-in followed by the user continuing: the committed words are not repeated", async () => {
  const u = dup();
  u.eng.takeFloor();
  u.mic.partial("tell me about tides");
  await u.clock.advance(600);
  u.model.last().resolve("Sure, here you go. Water moves.");
  await flush();
  assert.strictEqual(u.eng.getHistory()[0].text, "tell me about tides");
  u.mic.partial("tell me about tides and the moon");
  assert.strictEqual(u.eng.getState(), "listening");
  assert.strictEqual(u.eng.getInfo().utterance, "and the moon");
  u.mic.final("tell me about tides and the moon too");
  assert.strictEqual(u.eng.getInfo().utterance, "and the moon too");
});

test("D9 barge-in before any audio: the assistant turn is removed; during a typed ask the ask is aborted", async () => {
  const t = dup();
  t.eng.takeFloor();
  t.mic.final("tell me about tides");
  await t.clock.advance(600);
  t.model.last().resolve(REPLY);
  await flush();
  assert.strictEqual(t.voice.calls.length >= 1, true);
  const turn = t.eng.getHistory()[1];
  t.mic.partial("no wait actually");
  assert.ok(t.ev("turnRemove").some((e) => e.id === turn.id));
  assert.deepStrictEqual(t.eng.getHistory().map((x) => x.role), ["user"]);
  assert.strictEqual(t.eng.getState(), "listening");

  const u = dup();
  u.eng.takeFloor();
  u.eng.submitText("explain tides");
  await flush();
  const c = u.model.last();
  assert.strictEqual(u.eng.getState(), "thinking");
  u.mic.partial("hang on a second");
  assert.strictEqual(c.signal.aborted, true);
  assert.strictEqual(u.eng.getState(), "listening");
  assert.deepStrictEqual(u.eng.getHistory().map((x) => x.role), ["user"]);
  c.chunk("Late chunk. Never spoken.");
  await flush();
  assert.strictEqual(u.voice.calls.length, 0);
});

test("D10 minRate / maxRate bound the speech rate", async () => {
  const t = dup({ rate: 2.2, maxRate: 2.5 });
  await dupSpeaking(t);
  assert.strictEqual(t.voice.calls[0].opts.rate, 2.2);
  const u = dup({ rate: 2.2 });
  await dupSpeaking(u);
  assert.strictEqual(u.voice.calls[0].opts.rate, 1.5, "default maxRate");
  const v = dup({ rate: 0.3, minRate: 0.5 });
  await dupSpeaking(v);
  assert.strictEqual(v.voice.calls[0].opts.rate, 0.5);
  assert.strictEqual(DEFAULTS.minRate, 0.7);
  assert.strictEqual(DEFAULTS.maxRate, 1.5);
  assert.strictEqual(DEFAULTS.bargeInMinWords, 2);
  assert.strictEqual(DEFAULTS.echoGuard, true);
  assert.strictEqual(DEFAULTS.echoTailMs, 1500);
});

test("D11 takeFloor() during duplex speech cuts off without restarting the mic", async () => {
  const t = dup();
  await dupSpeaking(t);
  t.voice.position(0, 0, t.voice.calls[0].lines[0].id);
  t.voice.position(1000, 0, t.voice.calls[0].lines[0].id);
  t.eng.takeFloor();
  assert.strictEqual(t.mic.startCalls, 1);
  assert.strictEqual(t.voice.stopCalls, 1);
  assert.strictEqual(t.eng.getState(), "listening");
  assert.strictEqual(t.eng.getHistory()[1].cutOff, true);
  // the echo of what was cut is still filtered
  t.mic.final(" and the sun adds");
  assert.strictEqual(t.eng.getInfo().utterance, "");
});

test("D12 stop() and reset() in duplex close the mic, silence the voice and forget the echo tail", async () => {
  const t = dup();
  await dupSpeaking(t);
  await t.eng.stop();
  assert.strictEqual(t.mic.stopCalls, 1);
  assert.strictEqual(t.voice.stopCalls, 1);
  assert.strictEqual(t.eng.getState(), "idle");
  t.eng.takeFloor();
  assert.strictEqual(t.mic.startCalls, 2);
  t.mic.final("tides come from the moon today");
  assert.strictEqual(t.eng.getInfo().utterance, "tides come from the moon today", "no stale echo tail after stop()");
  const u = dup();
  await dupSpeaking(u);
  await u.eng.reset();
  assert.strictEqual(u.eng.getHistory().length, 0);
  assert.strictEqual(u.eng.getState(), "idle");
});

test("D13 the mic ending on its own while Claude speaks in duplex: speech finishes, then idle with yourTurn", async () => {
  const t = dup();
  await dupSpeaking(t);
  t.mic.end("hidden");
  await flush();
  assert.strictEqual(t.eng.getState(), "speaking");
  t.voice.finishAll();
  await flush();
  assert.strictEqual(t.eng.getState(), "idle");
  assert.strictEqual(t.ev("state").pop().yourTurn, true);
  assert.strictEqual(t.mic.startCalls, 1);
});

test("D14 the user starting to speak as Claude finishes: no words are lost", async () => {
  const t = dup();
  await dupSpeaking(t);
  t.mic.partial("cats");
  assert.strictEqual(t.eng.getState(), "speaking");
  t.voice.finishAll();
  await flush();
  t.mic.partial("cats are great");
  assert.strictEqual(t.eng.getInfo().utterance, "cats are great");
  await t.clock.advance(600);
  assert.match(t.model.last().last, /cats are great/);
  // a lone final word that arrives after the reply finished is a normal utterance
  const u = dup();
  await dupSpeaking(u);
  u.mic.partial("cats");
  u.voice.finishAll();
  await flush();
  await u.clock.advance(2000);
  u.mic.final("cats");
  assert.strictEqual(u.eng.getInfo().utterance, "cats");
});

test("D15 echo in the tail is dropped from partials too, so no reply ask is triggered", async () => {
  const t = dup();
  await dupSpeaking(t);
  t.voice.finishAll();
  await flush();
  t.mic.partial("the moon");
  await t.clock.advance(3000);
  assert.strictEqual(t.model.calls.length, 1);
  assert.strictEqual(t.eng.getInfo().utterance, "");
});

test("D16 duplex off: nothing is filtered and speech does not barge in", async () => {
  const t = setup({ rate: 1.0 });
  t.eng.takeFloor();
  t.mic.final("tell me about tides");
  await t.clock.advance(600);
  t.model.last().resolve(REPLY);
  await flush();
  assert.strictEqual(t.mic.stopCalls, 1);
  assert.deepStrictEqual(bi(t), []);
});

// ---- echo is matched as runs of the spoken text, not as a bag of words
const REPLY2 = "The moon pulls the oceans. Light from sun reaches us. This end is near.";
async function dupSpeaking2(t) {
  t.eng.takeFloor();
  t.mic.final("tell me about tides");
  await t.clock.advance(600);
  t.model.last().resolve(REPLY2);
  await flush();
  assert.strictEqual(t.eng.getState(), "speaking");
}

test("E1 the user's words that merely occur in the reply are kept: 'the sun is actually a star' is a barge-in with all words", async () => {
  const t = dup();
  await dupSpeaking2(t);
  t.mic.partial("the sun is actually a star");
  assert.strictEqual(t.eng.getState(), "listening");
  assert.strictEqual(t.eng.getInfo().utterance, "the sun is actually a star");
  assert.deepStrictEqual(bi(t), ["cut:the sun is actually a star"]);
});

test("E2 four consecutive words of the reply are pure echo and ignored, also a single or scattered spoken word", async () => {
  const t = dup();
  await dupSpeaking2(t);
  t.mic.partial("moon pulls the oceans");
  t.mic.final("moon pulls the oceans");
  t.mic.final("oceans");
  t.mic.final("the sun");
  await flush();
  assert.strictEqual(t.eng.getState(), "speaking");
  assert.strictEqual(t.voice.stopCalls, 0);
  assert.strictEqual(t.eng.getInfo().utterance, "");
  assert.ok(bi(t).every((x) => x === "ignored:echo"), bi(t).join());
});

test("E3 an echo run followed by real words keeps only the real words", async () => {
  const t = dup();
  await dupSpeaking2(t);
  t.mic.partial("pulls the oceans no that's wrong");
  assert.strictEqual(t.eng.getState(), "listening");
  assert.strictEqual(t.eng.getInfo().utterance, "no that's wrong");
  t.mic.final("pulls the oceans no that's wrong at all");
  assert.strictEqual(t.eng.getInfo().utterance, "no that's wrong at all");
});

test("E4 a lone ordinary-word final while Claude speaks is kept for the next utterance, not lost", async () => {
  const t = dup();
  await dupSpeaking2(t);
  t.mic.final("cats");
  assert.strictEqual(t.eng.getState(), "speaking");
  assert.deepStrictEqual(bi(t), ["ignored:short"]);
  assert.strictEqual(t.eng.getInfo().utterance, "");
  t.voice.finishAll();
  await flush();
  assert.strictEqual(t.eng.getInfo().utterance, "cats");
  await t.clock.advance(600);
  assert.strictEqual(t.model.last().mode, "paused");
  assert.match(t.model.last().last, /cats/);

  // cut off by a tap: the word starts the new utterance
  const u = dup();
  await dupSpeaking2(u);
  u.mic.final("cats");
  u.eng.takeFloor();
  assert.strictEqual(u.eng.getInfo().utterance, "cats");

  // followed by a barge-in: it is in front of the barge-in words
  const v = dup();
  await dupSpeaking2(v);
  v.mic.final("cats");
  v.mic.partial("tell me more");
  assert.strictEqual(v.eng.getInfo().utterance, "cats tell me more");

  // a backchannel or an echo word is not kept
  const w = dup();
  await dupSpeaking2(w);
  w.mic.final("yeah");
  w.mic.final("moon");
  w.voice.finishAll();
  await flush();
  assert.strictEqual(w.eng.getInfo().utterance, "");
  // stop() forgets it
  const x = dup();
  await dupSpeaking2(x);
  x.mic.final("cats");
  await x.eng.stop();
  assert.strictEqual(x.eng.getInfo().utterance, "");
});

test("E5 the same rules apply inside the tail after the voice stops", async () => {
  const mk = async () => { const t = dup(); await dupSpeaking2(t); t.voice.finishAll(); await flush(); await t.clock.advance(300); return t; };
  let t = await mk();
  t.mic.final(" the sun is actually a star");
  assert.strictEqual(t.eng.getInfo().utterance, "the sun is actually a star", "scattered reply words are the user's");
  t = await mk();
  t.mic.partial("moon pulls the oceans");
  t.mic.final(" moon pulls the oceans");
  t.mic.final(" oceans");
  t.mic.final(" the sun");
  assert.strictEqual(t.eng.getInfo().utterance, "", "pure echo dropped");
  await t.clock.advance(5000);
  assert.strictEqual(t.model.calls.length, 1);
  t = await mk();
  t.mic.final(" pulls the oceans no that's wrong");
  assert.strictEqual(t.eng.getInfo().utterance, "no that's wrong");
  t = await mk();
  t.mic.final(" cats");
  assert.strictEqual(t.eng.getInfo().utterance, "cats");
  await t.clock.advance(600);
  assert.match(t.model.last().last, /cats/);
});

// =====================================================================
// Rework: a listener that keeps notes and interrupts mid-sentence
// =====================================================================

function lis(cfg = {}, caps = {}) {
  return setup(Object.assign({ listenEveryWords: 8, listenMinGapMs: 1500, strictEveryWords: 20, cutInCooldownMs: 5000, pauseMs: 100000, forceReplyMs: 200000 }, cfg), caps);
}
function feed(t, text, from = 1) {
  const w = text.split(" ");
  for (let i = from; i <= w.length; i++) t.mic.partial(w.slice(0, i).join(" "));
}
const FOURIER = "Fourier transforms are useless and I don't use them anywhere";
const W20 = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
const nw = (n) => Array.from({ length: n }, (_, i) => "w" + (i + 1)).join(" ");

test("L1 live guesses with no final: a step starts at 8 words and the next at 16, none before 8", async () => {
  const t = lis();
  t.eng.takeFloor();
  feed(t, nw(7));
  assert.strictEqual(t.model.calls.length, 0);
  feed(t, nw(8), 8);
  assert.strictEqual(t.model.calls.length, 1);
  const c = t.model.calls[0];
  assert.strictEqual(c.mode, "listen");
  assert.strictEqual(c.tier, "quick");
  assert.match(c.last, /\[LISTENING\]/);
  assert.strictEqual(t.eng.getState(), "listening");
  feed(t, nw(15), 9);
  assert.strictEqual(t.model.calls.length, 1, "one step in flight at a time");
  c.resolve("<notes>nothing wrong yet</notes>");
  await t.clock.advance(2000);
  assert.strictEqual(t.model.calls.length, 1, "15 words: 7 new since the step began");
  feed(t, nw(16), 16);
  assert.strictEqual(t.model.calls.length, 2);
  assert.match(t.model.calls[1].last, /w16/);
  assert.deepStrictEqual(t.decisions(), ["listen:notes"]);
});

test("L2 a step returning <notes> speaks nothing, adds no turn, emits notes; later prompts carry them", async () => {
  const t = lis({ pauseMs: 3000 });
  t.eng.takeFloor();
  feed(t, nw(8));
  t.model.calls[0].resolve("<notes>Claims w1 is useless; shaky, wait and see.</notes>");
  await flush();
  assert.deepStrictEqual(t.ev("notes").map((e) => e.text), ["Claims w1 is useless; shaky, wait and see."]);
  assert.strictEqual(t.voice.calls.length, 0);
  assert.strictEqual(t.eng.getHistory().length, 0);
  assert.strictEqual(t.eng.getInfo().notes, "Claims w1 is useless; shaky, wait and see.");
  assert.strictEqual(t.eng.getState(), "listening");
  await t.clock.advance(1600);
  feed(t, nw(16), 9);
  const second = t.model.calls[1];
  assert.match(second.last, /Claims w1 is useless; shaky/);
  second.resolve("<notes>Still ok.</notes>");
  await flush();
  await t.clock.advance(3100); // pause
  const paused = t.model.calls.find((c) => c.mode === "paused");
  assert.ok(paused);
  assert.match(paused.last, /Your listening notes:\nStill ok\./);
  paused.resolve("Fine. Carry on, then.");
  await flush();
  assert.strictEqual(t.eng.getInfo().notes, "", "cleared once Claude's turn is committed");
  assert.deepStrictEqual(t.ev("notes").map((e) => e.text).slice(-1), [""]);
});

test("L3 the Fourier line as live guesses: Stop. cuts in before any final", async () => {
  const t = lis();
  t.eng.takeFloor();
  feed(t, FOURIER.split(" ").slice(0, 8).join(" "));
  assert.strictEqual(t.model.calls.length, 1);
  assert.match(t.model.calls[0].last, /Fourier transforms are useless and I don't use/);
  feed(t, FOURIER, 9); // the user keeps talking while the step runs
  t.model.calls[0].resolve("Stop. That's wrong. Your phone's compression and every MP3 run on Fourier transforms. Where do you think the audio comes from?");
  await flush();
  const types = t.events.map((e) => e.type + (e.type === "state" ? ":" + e.state : ""));
  assert.ok(types.indexOf("cutIn") >= 0);
  assert.ok(types.indexOf("cutIn") < types.indexOf("state:thinking"), "cutIn before the state change");
  assert.strictEqual(t.mic.stopCalls, 1);
  const h = t.eng.getHistory();
  assert.strictEqual(h[0].role, "user");
  assert.strictEqual(h[0].interrupted, true);
  assert.strictEqual(h[0].text, FOURIER, "everything heard up to the close");
  assert.strictEqual(t.voice.calls[0].fn, "speak");
  assert.strictEqual(t.voice.calls[0].lines[0].text, "Stop.", "the stopper is the first line");
  assert.strictEqual(t.voice.calls[0].micActive, false);
  assert.strictEqual(t.eng.getState(), "speaking");
  t.voice.finishAll();
  await flush();
  assert.ok(t.decisions().includes("listen:speak"));
  assert.strictEqual(t.model.byMode("paused").length, 0);
});

test("L4 stream forms: <notes> split across chunks, <wait> and empty are quiet, 'Stop.' commits alone", async () => {
  const t = lis();
  t.eng.takeFloor();
  feed(t, nw(8));
  const c = t.model.calls[0];
  c.chunk("<no");
  await flush();
  c.chunk("<notes>thinking");
  await flush();
  assert.strictEqual(t.mic.stopCalls, 0);
  assert.strictEqual(t.ev("cutIn").length, 0);
  c.resolve("<notes>thinking</notes>");
  await flush();
  assert.strictEqual(t.eng.getInfo().notes, "thinking");

  const w = lis();
  w.eng.takeFloor();
  feed(w, nw(8));
  w.model.calls[0].resolve("<wait>");
  await flush();
  assert.deepStrictEqual(w.decisions(), ["listen:wait"]);
  assert.strictEqual(w.eng.getInfo().notes, "");

  const e = lis();
  e.eng.takeFloor();
  feed(e, nw(8));
  e.eng.getInfo();
  e.model.calls[0].resolve("");
  await flush();
  assert.deepStrictEqual(e.decisions(), ["listen:wait"]);
  assert.strictEqual(e.eng.getState(), "listening");

  const s = lis();
  s.eng.takeFloor();
  feed(s, nw(8));
  s.model.calls[0].chunk("Stop.");
  await flush();
  assert.strictEqual(s.ev("cutIn").length, 1, "committed without waiting for more text");
  assert.strictEqual(s.mic.stopCalls, 1);
  assert.strictEqual(s.voice.calls[0].lines[0].text, "Stop.");
  s.model.calls[0].resolve("Stop. Wrong, and here is why.");
  await flush();
  assert.strictEqual(s.voice.calls[1].fn, "add");
  assert.strictEqual(s.voice.calls[1].lines[0].text, "Wrong, and here is why.");
});

test("L5 words arriving while the mic closes join the interrupted turn; no re-ask", async () => {
  const t = lis();
  t.eng.takeFloor();
  feed(t, nw(8));
  t.mic.lateWords = [nw(10)]; // the recogniser settles the whole phrase while the mic closes
  t.model.calls[0].resolve("No, wait. That is wrong because of reasons.");
  await flush();
  assert.strictEqual(t.model.calls.length, 1);
  assert.strictEqual(t.eng.getHistory()[0].text, nw(10));
  assert.strictEqual(t.eng.getHistory()[0].interrupted, true);
  assert.strictEqual(t.voice.calls[0].lines[0].text, "No, wait.");
  assert.strictEqual(t.eng.getState(), "speaking");
});

test("L6 strict steps: the step crossing each multiple of 20 carries the strict marker, once", async () => {
  const t = lis({ cutInCooldownMs: 0 });
  t.eng.takeFloor();
  const modes = [];
  for (let n = 8; n <= 41; n += 8) {
    await t.clock.advance(1600);
    feed(t, nw(n), n - 7);
    const c = t.model.last();
    modes.push(c.mode);
    c.resolve("<notes>ok</notes>");
    await flush();
  }
  assert.deepStrictEqual(modes, ["listen", "listen", "strict", "listen", "strict"]);
  assert.match(t.model.calls[2].last, /\[LISTENING: STRICT CHECK\]/);
  const u = lis({ strictEveryWords: 0 });
  u.eng.takeFloor();
  for (let n = 8; n <= 41; n += 8) {
    await u.clock.advance(1600);
    feed(u, nw(n), n - 7);
    u.model.last().resolve("<notes>ok</notes>");
    await flush();
  }
  assert.ok(u.model.calls.every((c) => c.mode === "listen"));
  assert.strictEqual(u.model.calls.length, 5);
});

test("L7a guards: min gap between steps, cooldown after a cut-in, rate-limit backoff, assertiveness 0", async () => {
  const t = lis();
  t.eng.takeFloor();
  feed(t, nw(8));
  t.model.calls[0].resolve("<notes>a</notes>");
  await flush();
  feed(t, nw(16), 9);
  assert.strictEqual(t.model.calls.length, 1, "inside listenMinGapMs from the previous step start");
  await t.clock.advance(1600);
  t.mic.partial(nw(16) + " w17");
  assert.strictEqual(t.model.calls.length, 2);

  const r = lis();
  r.eng.takeFloor();
  feed(r, nw(8));
  r.model.calls[0].reject({ code: "rate_limited", message: "x" });
  await flush();
  assert.strictEqual(r.ev("notice")[0].code, "rate_limited");
  await t.clock.advance(0);
  await r.clock.advance(5000);
  feed(r, nw(20), 9);
  assert.strictEqual(r.model.calls.length, 1, "inside the backoff");
  await r.clock.advance(30000);
  r.mic.partial(nw(21));
  assert.strictEqual(r.model.calls.length, 2, "backoff over");

  const z = lis({ assertiveness: 0 });
  z.eng.takeFloor();
  feed(z, nw(30));
  assert.strictEqual(z.model.calls.length, 0);
});

test("L7b guard: no step during the cooldown after Claude cut in", async () => {
  const t = lis();
  t.eng.takeFloor();
  feed(t, nw(8));
  t.model.calls[0].resolve("Stop. Wrong. Why would you say that?");
  await flush();
  t.voice.finishAll();
  await flush();
  t.eng.takeFloor();
  feed(t, nw(8));
  assert.strictEqual(t.model.calls.length, 1, "inside cutInCooldownMs");
  await t.clock.advance(5000);
  t.mic.partial(nw(9));
  assert.strictEqual(t.model.calls.length, 2);
});

test("L7c a step returning after stop(), a typed message or yourTake() is ignored and does not touch the notes", async () => {
  const t = lis();
  t.eng.takeFloor();
  feed(t, nw(8));
  const c = t.model.calls[0];
  await t.eng.stop();
  c.resolve("Stop. Wrong. Really wrong.");
  await flush();
  assert.strictEqual(t.ev("cutIn").length, 0);
  assert.strictEqual(t.eng.getHistory().length, 0);
  assert.strictEqual(t.voice.calls.length, 0);

  const u = lis();
  u.eng.takeFloor();
  feed(u, nw(8));
  const c2 = u.model.calls[0];
  u.eng.submitText("typed");
  c2.resolve("<notes>stale notes</notes>");
  await flush();
  assert.strictEqual(u.eng.getInfo().notes, "");
  assert.strictEqual(u.ev("notes").length, 0);

  const v = lis();
  v.eng.takeFloor();
  feed(v, nw(8));
  const c3 = v.model.calls[0];
  v.eng.yourTake();
  c3.resolve("<notes>stale</notes>");
  await flush();
  assert.strictEqual(v.eng.getInfo().notes, "");

  // takeFloor() after Claude cut in (speaking): a step that was already ignored cannot resurface
  const w = lis();
  w.eng.takeFloor();
  feed(w, nw(8));
  w.model.calls[0].resolve("Stop. Wrong. Really.");
  await flush();
  w.eng.takeFloor();
  assert.strictEqual(w.eng.getState(), "listening");
  assert.strictEqual(w.model.calls.length, 1);
});

test("L8 a pause while a step is in flight waits for the step; its notes reach the pause check; a cut-in cancels the pause check", async () => {
  const t = lis({ pauseMs: 600, forceReplyMs: 2500 });
  t.eng.takeFloor();
  feed(t, nw(8));
  const step = t.model.calls[0];
  await t.clock.advance(700);
  assert.strictEqual(t.model.calls.length, 1, "pause check waits for the short step");
  step.resolve("<notes>they said w8 then stopped</notes>");
  await flush();
  assert.strictEqual(t.model.calls.length, 2);
  assert.strictEqual(t.model.calls[1].mode, "paused");
  assert.match(t.model.calls[1].last, /they said w8 then stopped/);

  const u = lis({ pauseMs: 600, forceReplyMs: 2500 });
  u.eng.takeFloor();
  feed(u, nw(8));
  await u.clock.advance(700);
  u.model.calls[0].resolve("Stop. That is wrong. Why?");
  await flush();
  assert.strictEqual(u.ev("cutIn").length, 1);
  assert.strictEqual(u.model.byMode("paused").length, 0, "the cut-in wins");
  await u.clock.advance(5000);
  assert.strictEqual(u.model.byMode("paused").length, 0);
});

test("L9 listen mode: a pause runs one monitor step; quiet commits the turn and keeps the notes; speech is a normal reply", async () => {
  const t = lis({ mode: "listen", pauseMs: 600 });
  t.eng.takeFloor();
  t.mic.final("I like cats");
  await t.clock.advance(600);
  const m = t.model.calls[0];
  assert.strictEqual(m.mode, "monitor");
  assert.strictEqual(m.tier, "quick");
  assert.match(m.last, /\[PAUSED: LISTEN MODE\]/);
  m.resolve("<notes>Likes cats; harmless.</notes>");
  await flush();
  assert.deepStrictEqual(t.eng.getHistory().map((x) => [x.role, x.text]), [["user", "I like cats"]]);
  assert.strictEqual(t.eng.getInfo().notes, "Likes cats; harmless.");
  assert.strictEqual(t.eng.getState(), "listening");
  assert.strictEqual(t.voice.calls.length, 0);
  assert.deepStrictEqual(t.decisions(), ["monitor:notes"]);
  await t.clock.advance(20000);
  assert.strictEqual(t.model.calls.length, 1, "no forced ask in listen mode");
  assert.strictEqual(t.eng.getInfo().mode, "listen");

  // the notes persist across quiet pauses; speech is a normal (not interrupted) reply
  t.mic.final("and dogs are overrated");
  await t.clock.advance(600);
  const m2 = t.model.calls[1];
  assert.match(m2.last, /Likes cats; harmless\./);
  m2.resolve("No, dogs are not overrated. Name one good argument.");
  await flush();
  assert.strictEqual(t.mic.stopCalls, 1);
  assert.strictEqual(t.voice.calls[0].lines[0].text, "No, dogs are not overrated.");
  const h = t.eng.getHistory();
  assert.deepStrictEqual(h.map((x) => x.role), ["user", "user", "assistant"]);
  assert.strictEqual(h[1].interrupted, undefined);
  assert.strictEqual(t.eng.getInfo().notes, "", "cleared once Claude spoke");
});

test("L9b listen mode: a monitor answer to a direct question is spoken; <wait> counts as quiet", async () => {
  const t = lis({ mode: "listen", pauseMs: 600 });
  t.eng.takeFloor();
  t.mic.final("what is the capital of France");
  await t.clock.advance(600);
  t.model.calls[0].resolve("Paris. Next question?");
  await flush();
  assert.strictEqual(t.voice.calls[0].lines[0].text, "Paris. Next question?");
  const u = lis({ mode: "listen", pauseMs: 600 });
  u.eng.takeFloor();
  u.mic.final("hmm okay");
  await u.clock.advance(600);
  u.model.calls[0].resolve("<wait>");
  await flush();
  assert.strictEqual(u.eng.getHistory().length, 1);
  assert.strictEqual(u.voice.calls.length, 0);
});

test("L9c yourTake(): forces a reply with the notes in both modes; false with nothing to answer", async () => {
  const t = lis({ mode: "listen", pauseMs: 600 });
  assert.strictEqual(t.eng.yourTake(), false);
  t.eng.takeFloor();
  t.mic.final("I like cats");
  await t.clock.advance(600);
  t.model.calls[0].resolve("<notes>Likes cats.</notes>");
  await flush();
  t.mic.final("and nothing else");
  assert.strictEqual(t.eng.yourTake(), true);
  await flush();
  const f = t.model.last();
  assert.strictEqual(f.mode, "forced");
  assert.match(f.last, /\[REPLY NOW\]/);
  assert.match(f.last, /Likes cats\./);
  assert.match(f.last, /and nothing else/);
  f.resolve("Cats are fine, honestly. Dogs win.");
  await flush();
  assert.strictEqual(t.voice.calls[0].lines[0].text, "Cats are fine, honestly.");
  assert.strictEqual(t.eng.getInfo().notes, "");

  const u = lis();
  u.eng.takeFloor();
  u.mic.final("I like cats");
  assert.strictEqual(u.eng.yourTake(), true);
  assert.strictEqual(u.model.last().mode, "forced");
  assert.strictEqual(u.eng.getState(), "thinking");
});

test("L10 notes are cleared on a reply, a cut-in, stop(), reset() and after submitText", async () => {
  const mk = async () => {
    const t = lis();
    t.eng.takeFloor();
    feed(t, nw(8));
    t.model.calls[0].resolve("<notes>some thinking</notes>");
    await flush();
    assert.strictEqual(t.eng.getInfo().notes, "some thinking");
    return t;
  };
  let t = await mk();
  await t.eng.stop();
  assert.strictEqual(t.eng.getInfo().notes, "");
  assert.deepStrictEqual(t.ev("notes").map((e) => e.text), ["some thinking", ""]);
  t = await mk();
  await t.eng.reset();
  assert.strictEqual(t.eng.getInfo().notes, "");
  t = await mk();
  t.eng.submitText("a typed message");
  await flush();
  assert.match(t.model.last().last, /some thinking/, "the typed reply carries the notes");
  t.model.last().resolve("Okay, noted. Moving on.");
  await flush();
  assert.strictEqual(t.eng.getInfo().notes, "");
  t = await mk();
  await t.clock.advance(2000);
  feed(t, nw(16), 9);
  t.model.calls[1].resolve("Stop. Wrong. Why?");
  await flush();
  assert.strictEqual(t.eng.getInfo().notes, "", "cut-in clears the notes");
  // notes are trimmed to 600 characters
  const u = lis();
  u.eng.takeFloor();
  feed(u, nw(8));
  u.model.calls[0].resolve("<notes>" + "x".repeat(900) + "</notes>");
  await flush();
  assert.strictEqual(u.eng.getInfo().notes.length, 600);
});

test("L11 step prompts: marker, quick tier, at most 6 history turns, attachments cut to 2000 bytes; reply prompts keep full context", async () => {
  const t = lis({ listenEveryWords: 1e9 });
  t.eng.addAttachment({ kind: "text", name: "big.txt", text: "x".repeat(5000) });
  for (let i = 0; i < 5; i++) {
    t.eng.submitText("message " + i);
    await flush();
    t.model.last().resolve("Reply " + i + " is here.");
    await flush();
    t.voice.finishAll();
    await flush();
  }
  t.eng.setConfig({ listenEveryWords: 8 });
  t.eng.takeFloor();
  feed(t, nw(8));
  const step = t.model.last();
  assert.strictEqual(step.mode, "listen");
  assert.strictEqual(step.tier, "quick");
  const all = step.messages.map((m) => m.content).join("\n");
  assert.doesNotMatch(all, /message 0|message 1(?!\d)/);
  assert.match(all, /message 2/);
  assert.match(all, /Reply 4/);
  assert.strictEqual((all.match(/x+/g) || []).sort((a, b) => b.length - a.length)[0].length, 2000);
  step.resolve("<notes>ok</notes>");
  await flush();
  t.eng.submitText("final question");
  await flush();
  const reply = t.model.last();
  const all2 = reply.messages.map((m) => m.content).join("\n");
  assert.match(all2, /message 0/);
  assert.strictEqual((all2.match(/x+/g) || []).sort((a, b) => b.length - a.length)[0].length, 5000);
  assert.strictEqual(reply.tier, "quick", "replies use config.tier (default quick)");
  const u = lis({ tier: "default" });
  u.eng.submitText("hi");
  await flush();
  assert.strictEqual(u.model.last().tier, "default");
});

test("L12 a failed step does not silence the reply check and is not retried; step errors are quiet", async () => {
  const t = lis({ pauseMs: 600, forceReplyMs: 2500 });
  t.eng.takeFloor();
  feed(t, nw(8));
  t.model.calls[0].reject({ code: "upstream_error", message: "blip" });
  await flush();
  assert.deepStrictEqual(t.ev("notice"), []);
  assert.deepStrictEqual(t.decisions(), ["listen:error"]);
  await t.clock.advance(700);
  assert.strictEqual(t.model.calls.length, 2);
  assert.strictEqual(t.model.calls[1].mode, "paused");
});

test("L13 defaults of the rework", () => {
  assert.strictEqual(DEFAULTS.mode, "conversation");
  assert.strictEqual(DEFAULTS.tone, "rough");
  assert.strictEqual(DEFAULTS.listenEveryWords, 8);
  assert.strictEqual(DEFAULTS.listenMinGapMs, 1500);
  assert.strictEqual(DEFAULTS.strictEveryWords, 20);
  assert.strictEqual(DEFAULTS.cutInCooldownMs, 5000);
  assert.strictEqual(DEFAULTS.pauseMs, 1500);
  assert.strictEqual(DEFAULTS.forceReplyMs, 3500);
  assert.strictEqual(DEFAULTS.minWordsForCutIn, undefined);
  assert.strictEqual(DEFAULTS.cutInMinGapMs, undefined);
});

// ---------------------------------------------------------- review fixes: notes, stoppers, listen mode
async function stepStream(chunks, cfg) {
  const t = lis(cfg);
  t.eng.takeFloor();
  feed(t, nw(8));
  const c = t.model.calls[0];
  let acc = "";
  for (const ch of chunks) { acc += ch; c.chunk(acc); await flush(); }
  c.resolve(acc);
  for (let i = 0; i < 3; i++) { await t.clock.advance(10); t.voice.finishAll(); }
  return t;
}
const assistantTurns = (t) => t.ev("turn").filter((e) => e.turn.role === "assistant").map((e) => e.turn.text);

test("L14a a step with words before <notes> is notes: nothing spoken, no cut-in, no turn, notes updated", async () => {
  for (const chunks of [["Okay. <notes>claims X; shaky</notes>"], ["Okay.", " <notes>claims X; shaky</notes>"], ["Okay. <no", "tes>claims X; shaky</notes>"]]) {
    const t = await stepStream(chunks);
    assert.deepStrictEqual(t.voice.spoken(), []);
    assert.strictEqual(t.ev("cutIn").length, 0);
    assert.deepStrictEqual(assistantTurns(t), []);
    assert.strictEqual(t.eng.getInfo().notes, "claims X; shaky");
  }
});

test("L14b a cut-in followed by a notes block speaks and shows only the spoken sentences and keeps the notes", async () => {
  const t = await stepStream(["Stop. That's wrong. Why?", " <notes>they said X</notes>"]);
  assert.strictEqual(t.voice.spoken().join(" "), "Stop. That's wrong. Why?");
  assert.deepStrictEqual(assistantTurns(t), ["Stop. That's wrong. Why?"]);
  assert.strictEqual(t.ev("cutIn").length, 1);
  assert.strictEqual(t.eng.getInfo().notes, "they said X");
});

test("L14c an unclosed notes block after a cut-in is not spoken", async () => {
  const t = await stepStream(["Stop. That's wrong. Why?", " <notes>they said X and more"]);
  assert.strictEqual(t.voice.spoken().join(" "), "Stop. That's wrong. Why?");
  assert.deepStrictEqual(assistantTurns(t), ["Stop. That's wrong. Why?"]);
  assert.strictEqual(t.eng.getInfo().notes, "they said X and more");
});

test("L15 a stopper does not commit mid-sentence; a real stopper still commits at once", async () => {
  const t = await stepStream(["No, it's 3.", "14 seconds. Check it?"]);
  assert.deepStrictEqual(t.voice.spoken(), ["No, it's 3.14 seconds.", "Check it?"]);
  const u = lis();
  u.eng.takeFloor();
  feed(u, nw(8));
  const c = u.model.calls[0];
  c.chunk("Stop."); await flush();
  assert.strictEqual(u.ev("cutIn").length, 1, "a real stopper commits at once");
  assert.strictEqual(u.voice.spoken()[0], "Stop.");
  const v = lis();
  v.eng.takeFloor();
  feed(v, nw(8));
  v.model.calls[0].chunk("Okay."); await flush();
  assert.strictEqual(v.ev("cutIn").length, 0, "a non-stopper sentence waits for more text, which may be notes");
  v.model.calls[0].chunk("Okay. That's wrong."); await flush();
  assert.strictEqual(v.ev("cutIn").length, 1);
});

test("L16 listen mode: a monitor reply is not abandoned for a forced ask when words arrive while the mic closes", async () => {
  const t = setup({ mode: "listen", pauseMs: 600 });
  t.eng.takeFloor();
  t.mic.final("what is the capital of france");
  await t.clock.advance(700);
  const m = t.model.byMode("monitor")[0];
  t.mic.lateWords.push("and also spain");
  m.chunk("The capital of France is Paris. "); await t.clock.advance(10);
  m.resolve("The capital of France is Paris. Spain's is Madrid."); await t.clock.advance(10);
  t.voice.finishAll(); await t.clock.advance(10);
  assert.strictEqual(t.model.calls.length, 1);
  assert.deepStrictEqual(t.voice.spoken(), ["The capital of France is Paris.", "Spain's is Madrid."]);
  const user = t.ev("turn").filter((e) => e.turn.role === "user").map((e) => e.turn.text).join(" ");
  assert.match(user, /and also spain/);
});

test("L17 listen mode with assertiveness 0: the monitor prompt has no bar and says to stay quiet unless asked directly", async () => {
  const t = setup({ mode: "listen", pauseMs: 600, assertiveness: 0 });
  t.eng.takeFloor();
  t.mic.final("the moon is made of cheese");
  await t.clock.advance(700);
  const last = t.model.byMode("monitor")[0].last;
  assert.doesNotMatch(last, /factual error|questionable|unsupported/);
  assert.match(last, /unless they have asked you something directly/);
  assert.match(last, /Never correct/);
  const u = setup({ mode: "listen", pauseMs: 600, assertiveness: 2 });
  u.eng.takeFloor();
  u.mic.final("the moon is made of cheese");
  await u.clock.advance(700);
  assert.match(u.model.byMode("monitor")[0].last, /factual error/);
});

test("L18 a pending image is not sent with a monitor step, and is sent with the next reply", async () => {
  const t = setup({ mode: "listen", pauseMs: 600 });
  const blob = { fake: "blob" };
  t.eng.addAttachment({ kind: "image", name: "pic.png", blob });
  await flush();
  t.model.calls[0].resolve("A heron.");
  await flush();
  t.eng.takeFloor();
  t.mic.final("what is in the picture");
  await t.clock.advance(700);
  const m = t.model.byMode("monitor")[0];
  assert.strictEqual(m.opts.images, undefined);
  m.resolve("<notes>asks about the picture</notes>");
  await flush();
  t.eng.submitText("please answer");
  await flush();
  assert.deepStrictEqual(t.model.last().opts.images, [blob]);
});
