/* floor.js - the turn-taking engine for Open Floor.
 * Pure logic: no DOM, no window.claude, no dependencies. Everything external
 * (mic, voice, model, clock) is injected. Loads as a classic script (defines
 * globalThis.Floor) and under Node via require().
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Floor = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULTS = {
    mode: "conversation",
    tone: "rough",
    listenEveryWords: 8,
    listenMinGapMs: 1500,
    strictEveryWords: 20,
    pauseMs: 1500,
    forceReplyMs: 3500,
    cutInCooldownMs: 5000,
    rateLimitBackoffMs: 30000,
    assertiveness: 2,
    rate: 1.15,
    voiceName: "buttery",
    tier: "quick",
    topic: "",
    duplex: false,
    wordsPerMinute: 165,
    minRate: 0.7,
    maxRate: 1.5,
    bargeInMinWords: 2,
    echoGuard: true,
    echoTailMs: 1500,
    fillers: ["um", "uh", "er", "erm", "ah", "hmm", "mm", "uhm"],
    mixedMinWords: 3,
    phraseFilterMs: 2500,
    cutInGraceMs: 1200,
    backchannels: ["yeah", "yep", "yes", "mm", "mhm", "mm-hm", "uh-huh", "right", "ok", "okay", "sure", "i see", "got it"],
    stopWords: ["stop", "wait", "hold on", "no"],
    maxContextBytes: 180000,
    maxPromptBytes: 245000,
  };

  var MAX_LINE_CHARS = 1800;
  var MAX_HISTORY_TURNS = 40;
  var MIC_IDLE_WAIT_MS = 1500;
  var MIC_STOP_TIMEOUT_MS = 3000;

  var RULES_BASE =
    "You are Claude in a live voice conversation, and you are a sharp, knowledgeable listener who does not let wrong " +
    "things slide. Your words are spoken aloud, so use contractions and plain words, with no markdown, lists or headings " +
    "in what you say. Take positions: say why a claim is wrong, give a concrete example or counter-fact, and concede at once " +
    "and plainly when the other person is right. Don't flatter and don't summarise what they just said. The transcript " +
    "comes from speech recognition and may contain errors and missing punctuation; read past them. If your earlier turn " +
    "ends with \"[cut off by user]\", they talked over you: don't restart it, respond to what they said. When the answer " +
    "needs something that can't be spoken well, such as code, a list or a long explanation, say a short version and put the " +
    "rest inside one <show>...</show> block after your spoken words; it is displayed on screen and not read aloud.";

  var TONES = {
    polite: "Tone: firm but courteous.",
    direct: "Tone: plain and unsoftened.",
    rough: "Tone: blunt and impatient with lazy or wrong claims. Say so plainly (\"No. That's just wrong.\" / \"That's " +
      "nonsense, and here's why.\"). No cushioning, no praise sandwiches. Go after the claim, never the person: no insults " +
      "about who they are, no slurs, no contempt for honest questions.",
  };

  var BARS = {
    1: "a clear factual error.",
    2: "a factual error; a sweeping or lazy claim stated as fact (\"X is useless\", \"nobody uses Y\"); contradicting " +
      "something they said earlier; going in circles.",
    3: "anything questionable or unsupported.",
  };

  var DESCRIBE_PROMPT =
    "Describe this image in detail so that someone who cannot see it can discuss it: what it shows, any text in it " +
    "(transcribe it), layout, colours, numbers and anything notable. Plain prose, no preamble.";

  var enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  var dec = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;

  function byteLen(s) {
    s = String(s == null ? "" : s);
    if (enc) return enc.encode(s).length;
    return unescape(encodeURIComponent(s)).length;
  }

  /** Longest prefix of `s` that fits in `n` UTF-8 bytes, never splitting a character. */
  function truncBytes(s, n) {
    if (byteLen(s) <= n) return s;
    if (!enc || !dec) return s.slice(0, Math.max(0, n));
    return dec.decode(enc.encode(s).slice(0, Math.max(0, n))).replace(/\uFFFD+$/, "");
  }

  // ---------------------------------------------------------------- parsing

  /** Is this (possibly partial) reply definitely a wait, definitely speech, or undecided yet? */
  function classifyReply(text) {
    var t = String(text == null ? "" : text).replace(/^\s+/, "");
    if (!t) return "undecided";
    var l = t.toLowerCase();
    if (/^<wait\s*\/?>/.test(l)) return "wait";
    if (l.length < 6 && "<wait>".indexOf(l) === 0) return "undecided";
    if (/^<wait\s*\/?$/.test(l)) return "undecided";
    return "speech";
  }

  var SHOW_OPEN = "<show>";
  var NOTES_OPEN = "<notes>";

  /** Remove every <notes>...</notes> block (an unclosed one runs to the end); unless `final`, hold back a dangling "<no" tail. */
  function stripNotes(text, final) {
    var t = String(text == null ? "" : text).replace(/<notes>[\s\S]*?(<\/notes>|$)/gi, "");
    if (!final) {
      for (var k = Math.min(NOTES_OPEN.length - 1, t.length); k >= 1; k--) {
        if (NOTES_OPEN.indexOf(t.slice(-k).toLowerCase()) === 0) { t = t.slice(0, t.length - k); break; }
      }
    }
    return t;
  }

  /** Split reply text into spoken part and show part. `final` false holds back a dangling "<sh" tail. */
  function splitReply(text, final) {
    var t = stripNotes(text, final).replace(/^\s+/, "");
    var m = /<show>/i.exec(t);
    var say, show = "", hasShow = false, closed = false;
    if (m) {
      hasShow = true;
      say = t.slice(0, m.index);
      var rest = t.slice(m.index + SHOW_OPEN.length);
      var c = /<\/show>/i.exec(rest);
      if (c) { show = rest.slice(0, c.index); closed = true; } else show = rest;
    } else {
      say = t;
      if (!final) {
        for (var k = Math.min(SHOW_OPEN.length - 1, t.length); k >= 1; k--) {
          if (SHOW_OPEN.indexOf(t.slice(-k).toLowerCase()) === 0) { say = t.slice(0, t.length - k); break; }
        }
      }
    }
    return { say: say, show: show, hasShow: hasShow, closed: closed };
  }

  function parseReply(text) {
    var c = classifyReply(text);
    if (c === "wait") return { wait: true, say: "", show: "" };
    var t = String(text == null ? "" : text).trim();
    if (t && "<wait>".indexOf(t.toLowerCase()) === 0) return { wait: true, say: "", show: "" };
    var s = splitReply(text, true);
    return { wait: false, say: s.say.trim(), show: s.show.trim() };
  }

  /** End index (exclusive, closers included, whitespace excluded) of the first complete sentence, or -1. */
  function firstSentenceEnd(say) {
    var re = /[.!?…]["'”’)\]]*(?=\s)/g;
    var m;
    while ((m = re.exec(say))) {
      if (m.index + 1 >= 12) return m.index + m[0].length;
    }
    return -1;
  }

  /** Split into pieces of at most `max` chars: sentence boundary, else clause boundary, else space, else hard cut. */
  function splitLines(text, max) {
    var out = [];
    var s = text.trim();
    while (s.length > max) {
      var cut = -1, m, re;
      re = /[.!?…]["'”’)\]]*\s/g;
      while ((m = re.exec(s)) && m.index + m[0].length <= max) cut = m.index + m[0].length;
      if (cut < max / 2) {
        var c2 = -1;
        re = /[,;:—–]\s/g;
        while ((m = re.exec(s)) && m.index + m[0].length <= max) c2 = m.index + m[0].length;
        if (c2 > cut) cut = c2;
      }
      if (cut < max / 4) {
        var sp = s.lastIndexOf(" ", max);
        cut = sp > 0 ? sp + 1 : max;
      }
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) out.push(s);
    return out;
  }

  function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function wordCount(s) { var n = norm(s); return n ? n.split(" ").length : 0; }
  /** Activity key: lowercase letters and digits only (Unicode aware). */
  function looseKey(s) {
    try { return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }
    catch (_) { return String(s).toLowerCase().replace(/[\s.,;:!?'"“”‘’()\-]+/g, ""); }
  }
  function noop() {}

  // ----------------------------------------------------------------- engine

  function createFloor(opts) {
    opts = opts || {};
    var mic = opts.mic || { available: false };
    var voice = opts.voice || { available: false };
    var model = opts.model || { available: false };
    var clock = opts.clock || {
      now: function () { return Date.now(); },
      setTimeout: function (f, ms) { return setTimeout(f, ms); },
      clearTimeout: function (id) { clearTimeout(id); },
    };
    var onEvent = opts.onEvent || noop;
    var config = Object.assign({}, DEFAULTS, opts.config || {});
    var now = function () { return clock.now(); };

    var destroyed = false;
    var state = "idle";
    var yourTurn = false;
    var gen = 0;

    // utterance
    var finals = [];
    var partial = "";
    var lastNorm = "";
    var lastKey = "";
    var version = 0;
    var lastActivity = 0;
    var utterTyped = false;
    var muted = false; // ignore mic text between stop()/reset() and the next takeFloor()

    var history = [];
    var attachments = [];
    var turnSeq = 0;
    var attSeq = 0;

    // asks
    var replyAsk = null;
    var listenAsk = null;   // the one listening/strict step in flight
    var notes = "";
    var lastStepWords = 0;
    var lastStepAt = -Infinity;
    var strictLevel = 0;
    var pausePending = false;
    var stepNewText = "";
    var reply = null; // committed reply session
    var pauseTimer = null;
    var forceTimer = null;
    var askedPaused = -1;
    var askedForced = -1;
    var lastCutInAt = -Infinity;
    var backoffUntil = -Infinity;

    // capability health
    var micOn = false;
    var micStarting = false;
    var micStopping = 0;
    var micToken = 0;
    var micNoticeToken = -1;
    var micBroken = false;
    var idleWaiters = [];
    var modelOk = true;
    var voiceOk = true;
    var blocked = false; // platform refuses speech until a press (after viewer Stop/Escape)
    var lastBlockedB = false;
    var lastBlockedC = false;
    var staleClose = 0; // mic sessions closed by stop()/reset() that are still finishing
    var droppedGuess = false; // the live guess was withdrawn ("" with no final): not part of the utterance
    var promptTrimNoticed = false;
    // full duplex (config.duplex): echo filtering and barge-in
    var echoTail = null;      // {until, keys}: Claude's last words, ignored for echoTailMs after the voice stops
    var pf = null;            // per-phrase references: {committed, frozen, at}
    var graceCarry = [];      // words said during a cut-in's grace period, carried into a barge-in utterance
    var held = [];            // lone ordinary-word finals heard while Claude spoke: start of the next utterance
    var phraseIgnored = false; // an "ignored" bargeIn decision was already emitted for this phrase
    var checkedSinceDrop = true; // a pause check or ask ran since the live guess was withdrawn

    var subs = [];

    function emit(e) { if (destroyed) return; try { onEvent(e); } catch (_) { /* page bug must not break the engine */ } }
    function notice(code, message, detail) { emit({ type: "notice", code: code, message: message, detail: detail || {} }); }
    function errDetail(err, extra) {
      var d = extra || {};
      if (err && err.code) d.reason = err.code;
      if (err && typeof err.retryAfterMs === "number") d.retryAfterMs = err.retryAfterMs;
      return d;
    }

    function canMic() { return !!(mic && mic.available) && !micBroken; }
    function canVoice() { return !!(voice && voice.available) && voiceOk; }
    function speakAllowed() { return canVoice() && !blocked; }
    function canModel() { return !!(model && model.available) && modelOk; }
    function micActiveNow() { try { return !!mic.active(); } catch (_) { return false; } }
    function micOpen() {
      if (!canMic()) return false;
      return micOn || micStarting || micActiveNow();
    }
    function rateNow() {
      var lo = Number(config.minRate) || DEFAULTS.minRate;
      var hi = Math.max(lo, Number(config.maxRate) || DEFAULTS.maxRate);
      return Math.min(hi, Math.max(lo, Number(config.rate) || 1));
    }

    function setState(s, yt) {
      yt = !!yt;
      if (state === s && yourTurn === yt) return;
      state = s;
      yourTurn = yt;
      emit({ type: "state", state: s, yourTurn: yt });
      syncBlocked();
    }

    /** voiceBlocked is emitted when `blocked` or `canResume` changes. */
    function syncBlocked() {
      var c = blocked && state === "idle" && !micOpen() && canVoice();
      if (blocked === lastBlockedB && c === lastBlockedC) return;
      lastBlockedB = blocked;
      lastBlockedC = c;
      emit({ type: "voiceBlocked", blocked: blocked, canResume: c });
    }

    function setBlocked(b) {
      if (blocked === b) return;
      blocked = b;
      syncBlocked();
    }

    /** Resting state after a reply or a failed ask. */
    function restState() {
      if (micOpen()) { setState("listening"); scheduleSilence(); }
      else setState("idle", true);
    }

    // ------------------------------------------------------------ utterance

    function joinText(withGuess) {
      var f = finals.join("");
      var p = withGuess && partial ? (f && !/^\s/.test(partial) ? " " : "") + partial : "";
      return norm(f + p);
    }
    /** What the user has actually said: settled pieces plus a live guess that was not withdrawn. */
    function utteranceText() { return joinText(!droppedGuess); }

    /** Emits `partial` when the display text changes; returns true only when the loose key changed (activity). */
    function utteranceChanged() {
      var t = joinText(true);
      if (t !== lastNorm) {
        lastNorm = t;
        emit({ type: "partial", text: t });
      }
      var k = looseKey(t);
      if (k === lastKey) return false;
      lastKey = k;
      version++;
      lastActivity = now();
      return true;
    }

    function clearUtterance() {
      finals = [];
      partial = "";
      droppedGuess = false;
      utterTyped = false;
      lastStepWords = 0;
      strictLevel = 0;
      stepNewText = "";
      var had = lastNorm !== "";
      var hadKey = lastKey !== "";
      lastNorm = "";
      lastKey = "";
      if (hadKey) version++;
      if (had) emit({ type: "partial", text: "" });
    }

    // --------------------------------------------------------------- timers

    function clearTimers() {
      if (pauseTimer != null) { clock.clearTimeout(pauseTimer); pauseTimer = null; }
      if (forceTimer != null) { clock.clearTimeout(forceTimer); forceTimer = null; }
    }

    function scheduleSilence() {
      if (pauseTimer != null) { clock.clearTimeout(pauseTimer); pauseTimer = null; }
      if (destroyed || state !== "listening" || !utteranceText() || !canModel()) return;
      var d = Math.max(0, config.pauseMs - (now() - lastActivity));
      pauseTimer = clock.setTimeout(onPause, d);
    }

    function onPause() {
      pauseTimer = null;
      checkedSinceDrop = true;
      if (destroyed || state !== "listening" || !utteranceText() || !canModel()) return;
      // A listening step is short: let it finish, then run the pause check with its notes.
      if (inflight(listenAsk)) { pausePending = true; return; }
      if (inflight(replyAsk)) return;
      if (askedPaused === version) return;
      askedPaused = version;
      startAsk(config.mode === "listen" ? "monitor" : "paused", { spec: true });
    }

    function onForce(v) {
      forceTimer = null;
      if (destroyed || state !== "listening" || version !== v || !canModel()) return;
      if (inflight(replyAsk) || askedForced === version) return;
      askedForced = version;
      startAsk("forced", { spec: true });
    }

    // ----------------------------------------------------------------- asks

    function inflight(a) { return !!a && !a.dead && a.gen === gen; }

    function release(a) {
      if (replyAsk === a) replyAsk = null;
      if (listenAsk === a) listenAsk = null;
    }

    function settle(a, result, detail, ms) {
      if (a.settled) return;
      a.settled = true;
      var e = { type: "decision", kind: a.kind, result: result, ms: ms != null ? ms : now() - a.startedAt };
      if (detail !== undefined) e.detail = detail;
      emit(e);
    }

    function abortAsk(a, why) {
      if (!a || a.dead) return;
      a.dead = true;
      try { a.ctrl.abort(); } catch (_) { /* ignore */ }
      release(a);
      settle(a, "dropped", why);
    }

    function abortSpeculative(why) {
      if (replyAsk && !replyAsk.committing) abortAsk(replyAsk, why);
      if (listenAsk && !listenAsk.committing) abortAsk(listenAsk, why);
    }

    function pendingImages() {
      return attachments.filter(function (a) { return a.kind === "image" && a.blob && !a.sent; });
    }

    function rulesText() {
      return RULES_BASE + " " + (TONES[config.tone] || TONES.rough);
    }

    function barText() {
      var r = Math.round(config.assertiveness);
      if (isNaN(r)) r = 2;
      return BARS[Math.min(3, Math.max(1, r))];
    }

    function isStepMode(mode) { return mode === "listen" || mode === "strict" || mode === "monitor"; }

    /** The final user turn: marker, notes, what was heard, the instruction. The utterance and instruction are its last two paragraphs. */
    function finalTurn(mode, utt) {
      var n = notes || "(none yet)";
      if (mode === "listen" || mode === "strict") {
        var strict = mode === "strict";
        return (strict ? "[LISTENING: STRICT CHECK]" : "[LISTENING]") + "\n\nYour private notes so far: " + n +
          "\n\nWords new since your last check: " + (stepNewText || "(none)") +
          "\n\nEverything they have said this turn:\n" + utt + "\n\n" +
          "You are listening while they are still talking. Do not draft a reply. Either stay quiet by answering with only " +
          "<notes>...</notes>: your updated private thinking (what they claim, where they are heading, what looks shaky, what " +
          "you would want to challenge), under 60 words. Or cut in. " +
          (strict
            ? "This is a strict check: cut in if anything said this turn is wrong, sloppy or unsupported, taking into account how the " +
              "speaker has since narrowed, qualified or backed it up; stay quiet only if all of it holds up. "
            : "Cut in when they have gone wrong by this bar: " + barText() + " You do not have to wait for the end of the sentence " +
              "if where it is heading is already clear and wrong. A person lets one doubtful remark pass and notes it, " +
              "then stops the speaker when they double down or build on it: use your notes that way. A remark the speaker has " +
              "since narrowed or backed up is no longer wrong. ") +
          "If you cut in, do not write <notes>: start with a one-to-three-word stopper as its own sentence (\"Stop.\", " +
          "\"No, wait.\", \"Hold on.\"), then say what is wrong, give one concrete example or counter-fact, and end by putting a " +
          "question back to them. Four sentences at most.";
      }
      if (mode === "monitor") {
        if (Math.round(config.assertiveness) === 0) {
          return "[PAUSED: LISTEN MODE]\n\nYour private notes so far: " + n + "\n\nWhat they said:\n" + utt + "\n\n" +
            "They paused. Stay quiet by answering with only <notes>...</notes> (your updated private thinking, under 60 words) " +
            "unless they have asked you something directly. Never correct them or point out mistakes. If they did ask, answer " +
            "in spoken words, in four sentences at most.";
        }
        return "[PAUSED: LISTEN MODE]\n\nYour private notes so far: " + n + "\n\nWhat they said:\n" + utt + "\n\n" +
          "They paused. Stay quiet by answering with only <notes>...</notes> (your updated private thinking, under 60 words) " +
          "unless they have gone wrong by this bar: " + barText() + " or they have asked you something directly. In that case " +
          "answer in spoken words: open with a one-to-three-word stopper if they were wrong, then say what is wrong with a " +
          "concrete example, in four sentences at most.";
      }
      if (mode === "paused") {
        return "[PAUSED]\n\nYour listening notes:\n" + n + "\n\nWhat they said:\n" + utt + "\n\n" +
          "The user paused. If their thought is clearly unfinished (trailing \"and\", \"because\", \"so\", mid-sentence), reply " +
          "with exactly <wait>. Otherwise reply now, in one to four sentences, written from your notes and the whole of what " +
          "they said, not only their last words.";
      }
      return "[REPLY NOW]\n\nYour listening notes:\n" + n + "\n\nWhat they said:\n" + (utt || "(they said nothing new)") + "\n\n" +
        "Reply now, in one to four sentences, written from your notes and the whole conversation. Never reply with <wait>.";
    }

    function turnContent(t) {
      if (t.role === "user") return t.text;
      var c = t.text || "";
      if (t.show) c += (c ? "\n" : "") + "<show>" + t.show + "</show>";
      if (t.cutOff) c += " [cut off by user]";
      return c;
    }

    function tailBytes(str, n) {
      if (n <= 0) return "";
      if (byteLen(str) <= n) return str;
      if (!enc || !dec) return str.slice(-n);
      var bytes = enc.encode(str);
      return dec.decode(bytes.slice(bytes.length - n)).replace(/^\uFFFD+/, "");
    }

    function buildMessages(mode, utt, images) {
      var small = isStepMode(mode);
      var pieces = [];
      attachments.forEach(function (a) { if (a.ctx) pieces.push({ name: a.name, text: small ? truncBytes(a.ctx, 2000) : a.ctx }); });
      function ctxContent() {
        var ctx = [rulesText()];
        if (config.topic) ctx.push("Topic of this conversation: " + config.topic);
        pieces.forEach(function (p) { ctx.push("--- file: " + p.name + " ---\n" + p.text); });
        return ctx.join("\n\n");
      }
      var tail = "";
      (images || []).forEach(function (a) { tail += "An image named " + a.name + " is attached to this message.\n\n"; });
      function finContent(u) { return tail + finalTurn(mode, u); }
      var hist = [];
      history.slice(small ? -6 : -MAX_HISTORY_TURNS).forEach(function (t) {
        var c = turnContent(t);
        if (c) hist.push({ role: t.role, content: c });
      });
      // +2 bytes per message covers the separator added when neighbours of one role merge.
      function total() {
        var n = byteLen(ctxContent()) + byteLen(finContent(utt)) + 4;
        hist.forEach(function (m) { n += byteLen(m.content) + 2; });
        return n;
      }
      var cap = config.maxPromptBytes;
      var n = total();
      while (n > cap && hist.length) { hist.shift(); n = total(); }
      var trimmed = false;
      while (n > cap) {
        var big = null;
        pieces.forEach(function (p) { if (byteLen(p.text) > 0 && (!big || byteLen(p.text) > byteLen(big.text))) big = p; });
        if (!big) break;
        var bb = byteLen(big.text);
        big.text = truncBytes(big.text, Math.max(0, bb - (n - cap) - 8));
        trimmed = true;
        n = total();
      }
      if (n > cap) {
        var ub = byteLen(utt);
        var keep = Math.max(0, ub - (n - cap) - 100);
        var head = truncBytes(utt, Math.ceil(keep / 2));
        var back = tailBytes(utt, Math.floor(keep / 2));
        var left = Math.max(0, utt.length - head.length - back.length);
        utt = head + "\n[... " + left + " characters left out ...]\n" + back;
        trimmed = true;
      }
      if (trimmed && !promptTrimNoticed) {
        promptTrimNoticed = true;
        notice("error", "That message and its attachments are too long for one request, so part of it was left out of what Claude saw.",
               { reason: "prompt_trimmed" });
      }
      var msgs = [{ role: "user", content: ctxContent() }].concat(hist, [{ role: "user", content: finContent(utt) }]);
      // Messages must alternate: merge neighbours with the same role.
      var out = [];
      msgs.forEach(function (m) {
        var last = out[out.length - 1];
        if (last && last.role === m.role) last.content += "\n\n" + m.content;
        else out.push({ role: m.role, content: m.content });
      });
      return out;
    }

    /** Add the current utterance to history as a user turn and clear it. */
    function commitUserTurn(o) {
      var text = utteranceText();
      if (!text) return null;
      var ut = { id: "t" + (++turnSeq), role: "user", text: text };
      if (o && o.interrupted) ut.interrupted = true;
      if (o && o.typed) ut.typed = true;
      history.push(ut);
      emit({ type: "turn", turn: Object.assign({}, ut) });
      clearUtterance();
      return ut;
    }

    /** A non-speculative forced ask (mic closed or typed). The user turn is committed at once. */
    function startForcedCommit(o) {
      if (!canModel()) {
        commitUserTurn(o);
        restState();
        return false;
      }
      return !!startAsk("forced", { spec: false, commitUser: true, typed: !!(o && o.typed) });
    }

    function startAsk(mode, o) {
      if (!canModel()) return null;
      checkedSinceDrop = true;
      var ctrl = new AbortController();
      var ask = {
        mode: mode,
        kind: mode === "paused" ? "reply" : isStepMode(mode) ? mode : o.typed ? "typed" : "forced",
        cutIn: mode === "listen" || mode === "strict",
        spec: !!o.spec,
        ctrl: ctrl,
        gen: gen,
        version: version,
        startedAt: now(),
        text: "",
        ended: false,
        err: null,
        refused: false,
        dead: false,
        committing: false,
        settled: false,
        userCommitted: false,
        rs: null,
        images: mode === "listen" || mode === "strict" || mode === "monitor" ? [] : pendingImages(),
      };
      var utt = utteranceText();
      if (ask.cutIn) {
        // A listening step sees the words that are new since the last step.
        var ws = utt ? utt.split(" ") : [];
        stepNewText = ws.slice(lastStepWords).join(" ");
        lastStepWords = ws.length;
        lastStepAt = now();
      }
      var messages = buildMessages(mode, utt, ask.images);
      if (o.commitUser) { commitUserTurn({ typed: o.typed }); ask.userCommitted = true; }
      if (ask.cutIn) listenAsk = ask; else replyAsk = ask;
      var callOpts = {
        tier: isStepMode(mode) ? "quick" : config.tier,
        signal: ctrl.signal,
        onText: function (u) { onAskText(ask, u); },
      };
      if (ask.images.length) callOpts.images = ask.images.map(function (a) { return a.blob; });
      var p;
      try { p = model.ask(messages, callOpts); } catch (err) { p = Promise.reject(err); }
      Promise.resolve(p).then(
        function (res) { onAskDone(ask, res); },
        function (err) { onAskError(ask, err); }
      );
      return ask;
    }

    function onAskText(ask, u) {
      if (!inflight(ask) || ask.ended) return;
      if (u && typeof u.text === "string") ask.text = u.text;
      else if (u && typeof u.delta === "string") ask.text += u.delta;
      onAskProgress(ask);
    }

    /** A step answers <notes>...</notes> (quiet), <wait>/empty (quiet, notes unchanged) or speech (a cut-in / reply). */
    function classifyStep(text) {
      var t = String(text == null ? "" : text).replace(/^\s+/, "");
      if (!t) return "undecided";
      var l = t.toLowerCase();
      var ni = l.indexOf("<notes>");
      if (ni >= 0 && ni < 40) return "notes";
      if (l.length < 7 && "<notes>".indexOf(l) === 0) return "undecided";
      if (/^<wait\s*\/?>/.test(l)) return "quiet";
      if (l.length < 6 && "<wait>".indexOf(l) === 0) return "undecided";
      return "cut";
    }

    function extractNotes(text) {
      var m = /<notes>([\s\S]*?)(<\/notes>|$)/i.exec(text);
      return (m ? m[1] : "").replace(/\s+/g, " ").trim().slice(0, 600);
    }

    /** End of the first sentence with no minimum length (a stopper like "Stop." counts), or -1. */
    function stopperEnd(say, ended) {
      var m = /[.!?\u2026]["'\u201d\u2019)\]]*(?=\s|$)/.exec(say);
      if (!m) return -1;
      var e = m.index + m[0].length;
      if (e < say.length || ended) return e;
      // At the very end of text still arriving: only a short digit-free stopper is safe ("Stop."), not "3." of "3.14".
      var words = say.slice(0, e).trim().split(/\s+/).length;
      return words <= 3 && !/\d/.test(say.slice(0, e)) ? e : -1;
    }

    /** A bare interjection that can only be a cut-in ("Stop.", "No, wait."), safe to speak before more text arrives. */
    function isStopperWord(sentence) {
      var w = String(sentence).toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
      return /^(stop|wait|no|nope|whoa|hold on|hold up|hold it|hang on|no wait|wait a (second|moment|minute))$/.test(w);
    }

    function setNotes(text) {
      text = String(text || "").slice(0, 600);
      if (text === notes) return;
      notes = text;
      emit({ type: "notes", text: notes });
    }

    function clearNotes() { setNotes(""); }

    function onAskProgress(ask) {
      if (ask.rs) { pump(ask.rs); return; }
      if (ask.committing) return;
      if (isStepMode(ask.mode)) {
        if (classifyStep(ask.text) !== "cut") return;
        var ss = splitReply(ask.text, false);
        var se = ask.cutIn ? stopperEnd(ss.say, false) : firstSentenceEnd(ss.say);
        // Under 40 characters a <notes> tag may still arrive: commit early only with more text after the sentence.
        if (se >= 0 && (ask.text.trim().length >= 40 || ss.say.slice(se).trim() || isStopperWord(ss.say.slice(0, se)))) beginCommit(ask);
        return;
      }
      if (classifyReply(ask.text) !== "speech") return;
      var s = splitReply(ask.text, false);
      if (firstSentenceEnd(s.say) >= 0) beginCommit(ask);
    }

    function onAskDone(ask, res) {
      if (!inflight(ask)) return;
      if (res && typeof res.text === "string") ask.text = res.text;
      ask.ended = true;
      if (ask.rs) { pump(ask.rs); return; }
      if (ask.committing) return;
      if (isStepMode(ask.mode)) { onStepDone(ask); return; }
      var pr = parseReply(ask.text);
      var isWait = pr.wait || (!pr.say && !pr.show);
      if (isWait) {
        release(ask);
        settle(ask, "wait", ask.mode === "forced" ? "unexpected wait" : undefined);
        if (ask.mode === "paused") {
          if (state === "listening" && ask.version === version && askedForced !== version) {
            var d = Math.max(0, config.forceReplyMs - (now() - lastActivity));
            if (forceTimer != null) clock.clearTimeout(forceTimer);
            var v = version;
            forceTimer = clock.setTimeout(function () { onForce(v); }, d);
          }
        } else if (ask.mode === "forced" && !ask.spec) {
          askedPaused = askedForced = version; // never re-ask the same content from a timer
          restState();
        }
        return;
      }
      beginCommit(ask);
    }

    /** A listening, strict or monitor step finished without committing a cut-in. */
    function onStepDone(ask) {
      var c = classifyStep(ask.text);
      if (c === "cut") {
        var sd = splitReply(ask.text, true);
        if (sd.say.trim() || sd.show.trim()) { beginCommit(ask); return; }
        c = /<notes>/i.test(ask.text) ? "notes" : "quiet";
      }
      release(ask);
      var fresh = c === "notes" ? extractNotes(ask.text) : "";
      if (fresh) setNotes(fresh);
      if (fresh) settle(ask, "notes", fresh); else settle(ask, "wait");
      if (ask.mode === "monitor") {
        // Listen mode, at a pause: stay quiet. The utterance becomes a transcript turn; the notes stay.
        if (state === "listening" && ask.version === version && utteranceText()) {
          commitUserTurn({});
          scheduleSilence();
        }
        return;
      }
      afterStep();
    }

    /** After a step returned quiet (or failed): a pending pause check runs now, else the next step if enough words arrived. */
    function afterStep() {
      if (pausePending) { pausePending = false; onPause(); return; }
      maybeListen(true);
    }

    function isImageError(code) { return code === "image_rejected" || code === "images_unavailable"; }

    function dropImages(list, code) {
      var names = [];
      list.forEach(function (a) {
        if (a.blob) { a.blob = null; }
        if (!a.dropNoticed) { a.dropNoticed = true; names.push(a.name); }
      });
      if (names.length) {
        notice("image_rejected", "Claude couldn't use the image " + names.map(function (n) { return "\"" + n + "\""; }).join(", ") +
          ". It was left out; the conversation carries on.", { name: names.join(", "), names: names, reason: code });
      }
    }

    /** Shared error side effects (notices, backoff, availability). Returns true if a notice-worthy generic error. */
    function noteAskError(err, imgs) {
      var code = err && err.code;
      if (code === "cancelled") return;
      if (code === "rate_limited") {
        backoffUntil = now() + config.rateLimitBackoffMs;
        notice("rate_limited", "Claude is rate limited right now. Cut-ins are paused for " + Math.round(config.rateLimitBackoffMs / 1000) + " seconds.", errDetail(err));
      } else if (code === "not_granted" || code === "sampling_disabled" || code === "not_declared" ||
                 code === "capability_disabled" || code === "capability_removed") {
        modelOk = false;
        notice("model_unavailable", "Claude can't answer here. Open this page at claude.ai and allow it.", errDetail(err));
      } else if (code === "refused") {
        notice("refused", "Claude declined to answer that.", errDetail(err));
      } else if (isImageError(code) && imgs && imgs.length) {
        dropImages(imgs, code);
      } else {
        notice("error", "Something went wrong getting a reply. Try again.", errDetail(err));
      }
    }

    function onAskError(ask, err) {
      if (!inflight(ask)) return;
      var code = err && err.code;
      if (err && typeof err.text === "string" && err.text.length > ask.text.length) ask.text = err.text;
      if (isStepMode(ask.mode)) {
        // Steps are background work: only a rate limit or an unavailable model is worth telling the user.
        if (code === "rate_limited" || code === "not_granted" || code === "sampling_disabled" || code === "not_declared" ||
            code === "capability_disabled" || code === "capability_removed") noteAskError(err, null);
      } else noteAskError(err, ask.images);
      ask.ended = true;
      ask.err = err || { code: "error" };
      ask.refused = code === "refused";
      settle(ask, code === "cancelled" ? "dropped" : "error", code || "error");
      if (ask.rs) { pump(ask.rs); return; }
      release(ask);
      if (ask.committing) { ask.dead = true; return; }
      if (ask.cutIn) { if (pausePending) { pausePending = false; onPause(); } return; }
      askedPaused = askedForced = ask.version;
      if (!ask.spec) restState();
    }

    // --------------------------------------------------------- commit / speak

    function beginCommit(ask) {
      if (!inflight(ask) || ask.committing) return;
      if (ask.spec && state !== "listening") { abortAsk(ask, "state"); return; }
      var kind = ask.cutIn ? "cutIn" : "reply";
      if (kind === "cutIn") emit({ type: "cutIn" });
      pausePending = false;
      ask.committing = true;
      var others = [replyAsk, listenAsk];
      for (var i = 0; i < others.length; i++) if (others[i] && others[i] !== ask) abortAsk(others[i], "superseded");
      clearTimers();
      ask.gen = ++gen;
      var rs = { ask: ask, kind: kind, gen: ask.gen, stage: "closing", dead: false, turn: null, lines: [], pending: 0,
                 consumed: 0, restIssued: false, audible: false, pos: null, voiceFailed: false, noSpeak: false,
                 forceIdle: false, rate: rateNow(), commitMs: now() - ask.startedAt };
      ask.rs = rs;
      reply = rs;
      setState("thinking");
      var v0 = version;
      if (micOpen() && canVoice() && !config.duplex) {
        closeMic().then(function (ok) { afterClose(rs, v0, ok); });
      } else {
        afterClose(rs, v0, true);
      }
    }

    function waitMicIdle(ms) {
      return new Promise(function (resolve) {
        var done = false, tid = null;
        var fin = function (v) {
          if (done) return;
          done = true;
          if (tid != null) clock.clearTimeout(tid);
          idleWaiters = idleWaiters.filter(function (w) { return w !== fin; });
          resolve(v);
        };
        idleWaiters.push(fin);
        tid = clock.setTimeout(function () { fin(false); }, ms);
      });
    }

    /** Stop the mic. Resolves true only when it is really closed. */
    function closeMic(onStopSettled) {
      micStopping++;
      var tok = micToken;
      var p;
      try { p = Promise.resolve(mic.stop()); } catch (e) { p = Promise.reject(e); }
      var tid = null;
      // A stop() that never settles must not leave the engine waiting (or deaf) forever.
      var timed = new Promise(function (res) { tid = clock.setTimeout(function () { res(false); }, MIC_STOP_TIMEOUT_MS); });
      var settled = p.then(function () { return true; }, function () { return !micActiveNow(); });
      return Promise.race([settled, timed])
        .then(function (ok) {
          if (tid != null) clock.clearTimeout(tid);
          if (onStopSettled) onStopSettled();
          if (!ok) return false;
          if (!micActiveNow()) return true;
          return waitMicIdle(MIC_IDLE_WAIT_MS);
        })
        .then(function (closed) {
          micStopping--;
          if (closed && micToken === tok) micOn = false;
          syncBlocked();
          return closed;
        });
    }

    function afterClose(rs, v0, closed) {
      if (destroyed || rs.dead || reply !== rs || rs.gen !== gen) return;
      var ask = rs.ask;
      if (!closed) {
        // The mic may still be open: the platform would refuse to speak. Show text only.
        rs.noSpeak = true;
        rs.forceIdle = true;
        notice("voice_failed", "The microphone didn't close, so the reply stays on screen. Tap to talk again.", { reason: "mic_not_closed" });
      } else if (rs.kind === "reply" && ask.mode !== "monitor" && !ask.userCommitted && !ask.err && version !== v0) {
        // The user was still talking while the mic closed and it can't reopen without a tap:
        // abandon this ask and ask again, forced, with the whole utterance.
        ask.dead = true;
        try { ask.ctrl.abort(); } catch (_) { /* ignore */ }
        release(ask);
        settle(ask, "dropped", "words arrived while the mic closed");
        reply = null;
        rs.dead = true;
        startForcedCommit({});
        return;
      }
      if (rs.kind === "cutIn") { lastCutInAt = now(); clearNotes(); }
      if (config.duplex && !ask.userCommitted) {
        // The recogniser may keep growing a live guess whose words go into the user turn now: remember the
        // turn's text as already said for this phrase.
        var utxt = utteranceText();
        if (utxt && ((partial && !droppedGuess) || rs.kind === "cutIn")) pf = { committed: keySeq([utxt]), frozen: null, at: now() };
        if (rs.kind === "cutIn") rs.graceUntil = now() + Number(config.cutInGraceMs || 0);
      }
      if (!ask.userCommitted) commitUserTurn({ interrupted: rs.kind === "cutIn" });
      if (!ask.err) ask.images.forEach(function (a) { a.sent = true; });
      rs.stage = "live";
      pump(rs);
    }

    function lineOpts(rs) { return { rate: rs.rate, voice: config.voiceName }; }

    function issue(rs, text, first) {
      var idx = rs.lines.length;
      var line = { text: text, id: (rs.turn ? rs.turn.id : "replay") + ":" + idx };
      rs.lines.push(line);
      rs.pending++;
      var p;
      try {
        p = first ? voice.speak([{ text: text, id: line.id }], lineOpts(rs))
                  : voice.add([{ text: text, id: line.id }], lineOpts(rs));
      } catch (e) { p = Promise.reject(e); }
      if (first) setState("speaking");
      Promise.resolve(p).then(
        function () {
          if (rs.dead || reply !== rs) return;
          if (rs.resume) setBlocked(false);
          rs.pending = Math.max(0, rs.pending - 1);
          pump(rs);
        },
        function (err) { onVoiceReject(rs, err); }
      );
    }

    function stopVoiceQuietly() {
      try { Promise.resolve(voice.stop()).catch(noop); } catch (_) { /* ignore */ }
    }

    function onVoiceReject(rs, err) {
      if (destroyed || rs.dead || reply !== rs || rs.voiceFailed) return;
      var code = err && err.code;
      if (code === "stopped") {
        // The platform's own Stop / Escape (or anything else that ended the reading): same as a cut-off.
        gen++;
        abortSpeculative("voice stopped");
        cutOffReply(false);
        clearTimers();
        setState("idle", true);
        return;
      }
      rs.voiceFailed = true;
      rs.forceIdle = true;
      rs.pending = 0;
      if (code === "no_gesture") {
        if (rs.resume) {
          notice("voice_needs_tap", "The voice is still blocked. Wait a few seconds and tap \"Turn voice back on\" again.", errDetail(err));
        } else if (!blocked) {
          setBlocked(true);
          notice("voice_needs_tap", "The voice is switched off after you stopped it. Tap \"Turn voice back on\" to hear replies again. Replies show as text until then.", errDetail(err));
        }
      } else if (code === "busy") {
        notice("voice_failed", "The voice couldn't start because the microphone was still open, so the reply stays on screen.", errDetail(err));
      } else {
        if (code === "not_granted" || code === "unavailable") { voiceOk = false; setBlocked(false); }
        notice("voice_failed", "The voice failed, so the reply stays on screen.", errDetail(err));
      }
      stopVoiceQuietly();
      pump(rs);
    }

    function pump(rs) {
      if (destroyed || rs.dead || reply !== rs || rs.stage !== "live") return;
      var ask = rs.ask;
      if (rs.resume) { if (rs.pending === 0) finish(rs); return; }
      if (ask.err && ask.refused) { refuseReply(rs); return; }
      var sp = splitReply(ask.text, ask.ended);
      var say = ask.ended ? sp.say.trimEnd() : sp.say;
      var show = sp.show.trim();
      var turnText = say.trim();
      if (ask.err && rs.lines.length) turnText = rs.lines.map(function (l) { return l.text; }).join(" ");

      if (!rs.turn) {
        if ((!turnText && !show) || ask.err) {
          // Nothing was on screen or heard yet, and the ask failed: no assistant turn.
          if (ask.ended) finish(rs);
          return;
        }
        var t = { id: "t" + (++turnSeq), role: "assistant", text: turnText, show: show };
        rs.turn = t;
        clearNotes();
        history.push(t);
        emit({ type: "turn", turn: Object.assign({}, t) });
      } else if (rs.turn.text !== turnText || rs.turn.show !== show) {
        rs.turn.text = turnText;
        rs.turn.show = show;
        emit({ type: "turnUpdate", turn: Object.assign({}, rs.turn) });
      }
      if (rs.kind === "cutIn" && ask.ended && !ask.err) { var cn = extractNotes(ask.text); if (cn) setNotes(cn); }
      if (ask.ended && !ask.err && !ask.settled) settle(ask, "speak", turnText.slice(0, 80), rs.commitMs);

      var voiceActive = speakAllowed() && !rs.voiceFailed && !rs.noSpeak && !ask.err;
      if (voiceActive && !config.duplex && micOpen()) {
        // Never speak into an open mic: the platform would refuse.
        rs.noSpeak = true;
        rs.forceIdle = true;
        voiceActive = false;
        notice("voice_failed", "The microphone is still open, so the reply stays on screen.", { reason: "mic_open" });
      }
      if (voiceActive) {
        if (!rs.lines.length) {
          var fe = rs.kind === "cutIn" ? stopperEnd(say, ask.ended) : firstSentenceEnd(say); // a cut-in speaks its stopper first
          if (fe >= 0) {
            rs.consumed = fe;
            splitLines(say.slice(0, fe), MAX_LINE_CHARS).forEach(function (p, i) { issue(rs, p, i === 0); });
          } else if (ask.ended && say.trim()) {
            rs.consumed = say.length;
            splitLines(say, MAX_LINE_CHARS).forEach(function (p, i) { issue(rs, p, i === 0); });
            rs.restIssued = true;
          }
        }
        if (rs.lines.length && ask.ended && !rs.restIssued) {
          rs.restIssued = true;
          var rest = say.slice(rs.consumed).trim();
          if (rest) splitLines(rest, MAX_LINE_CHARS).forEach(function (p) { issue(rs, p, false); });
        }
      }
      var more = voiceActive && rs.lines.length > 0 && !rs.restIssued;
      if (ask.ended && rs.pending === 0 && !more) finish(rs);
    }

    /** A refusal after commit: nothing new is spoken; keep only what was actually heard. */
    function refuseReply(rs) {
      if (rs.lines.length && voice && voice.available) stopVoiceQuietly();
      if (rs.turn) {
        var heard = rs.lines.length && rs.audible ? heardText(rs) : "";
        if (!heard) { removeTurn(rs.turn); rs.turn = null; }
        else {
          rs.turn.text = heard;
          rs.turn.show = "";
          emit({ type: "turnUpdate", turn: Object.assign({}, rs.turn) });
        }
      }
      finish(rs);
    }

    function finish(rs) {
      if (reply !== rs) return;
      rs.dead = true;
      reply = null;
      release(rs.ask);
      noteEchoTail(rs);
      flushHeld();
      if (config.duplex) { endPhrase(); graceCarry = []; }
      if (!micOpen()) setState("idle", true);
      else { setState("listening"); scheduleSilence(); }
    }

    // --------------------------------------------------------------- cut-off

    function heardText(rs) {
      var pos = rs.pos;
      if (!pos || !rs.lines.length) return "";
      var idx = -1;
      if (pos.id != null) for (var i = 0; i < rs.lines.length; i++) if (rs.lines[i].id === pos.id) idx = i;
      if (idx < 0) idx = Math.min(Math.max(0, pos.line | 0), rs.lines.length - 1);
      var done = rs.lines.slice(0, idx).map(function (l) { return l.text; });
      var n = Math.floor((pos.ms || 0) / 1000 * config.wordsPerMinute * rs.rate / 60);
      var words = rs.lines[idx].text.split(/\s+/).filter(Boolean).slice(0, Math.max(0, n));
      if (words.length) done.push(words.join(" "));
      return done.join(" ").trim();
    }

    function removeTurn(t) {
      var i = history.indexOf(t);
      if (i >= 0) history.splice(i, 1);
      emit({ type: "turnRemove", id: t.id });
    }

    /** Abort the committed reply (if any), stop the voice, truncate or remove the assistant turn. */
    function cutOffReply(callVoiceStop) {
      var rs = reply;
      reply = null;
      var wasActive = state === "thinking" || state === "speaking";
      noteEchoTail(rs);
      flushHeld();
      if (rs) {
        rs.dead = true;
        if (rs.stage === "live" && !rs.ask.settled && !rs.ask.err) settle(rs.ask, "speak", "cut off", rs.commitMs);
        abortAsk(rs.ask, "cut off");
        release(rs.ask);
      }
      if (callVoiceStop !== false && wasActive && voice && voice.available) stopVoiceQuietly();
      // The platform accepted this press-driven speak(): cutting the replay off does not leave the voice blocked.
      if (rs && rs.resume && !rs.voiceFailed && callVoiceStop !== false) setBlocked(false);
      if (rs && rs.turn) {
        // Duplex with a working voice: a reply nobody heard yet is removed even if some text was on screen.
        var textOnly = rs.lines.length === 0 && (!config.duplex || !speakAllowed() || rs.noSpeak);
        if (textOnly || rs.voiceFailed) {
          // Text-only reply (no voice, blocked, failed): the text on screen is what they read.
          if (!rs.turn.text && !rs.turn.show) removeTurn(rs.turn);
          else {
            rs.turn.cutOff = true;
            if (!rs.ask.ended) rs.turn.show = "";
            emit({ type: "turnUpdate", turn: Object.assign({}, rs.turn) });
          }
          return;
        }
        var heard = rs.audible ? heardText(rs) : "";
        if (!heard) removeTurn(rs.turn);
        else {
          rs.turn.text = heard;
          rs.turn.cutOff = true;
          if (!rs.ask.ended) rs.turn.show = "";
          emit({ type: "turnUpdate", turn: Object.assign({}, rs.turn) });
        }
      }
    }

    // ------------------------------------------------------------ mic events

    // ---------------------------------------------------------- full duplex

    function tokens(raw) {
      return String(raw == null ? "" : raw).split(/\s+/).filter(function (w) { return looseKey(w) !== ""; });
    }

    function keySeq(list) {
      var seq = [];
      list.forEach(function (text) { tokens(text).forEach(function (w) { seq.push(looseKey(w)); }); });
      return seq;
    }

    function listKeys(list) {
      return (list || []).map(function (entry) { return tokens(entry).map(looseKey); }).filter(function (k) { return k.length; });
    }

    function isFiller(w) {
      var k = looseKey(w);
      return listKeys(config.fillers).some(function (e) { return e.length === 1 && e[0] === k; });
    }

    function editWithin(a, b, max) {
      if (Math.abs(a.length - b.length) > max) return false;
      var prev = [];
      for (var j = 0; j <= b.length; j++) prev.push(j);
      for (var i = 1; i <= a.length; i++) {
        var cur = [i];
        var rowMin = i;
        for (j = 1; j <= b.length; j++) {
          var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
          cur.push(v);
          if (v < rowMin) rowMin = v;
        }
        if (rowMin > max) return false;
        prev = cur;
      }
      return prev[b.length] <= max;
    }

    /** Word similarity: equal keys, edit distance 1 (2 for 7+ chars) for keys of 3+ chars, or a prefix of 3+ chars. */
    function wordMatch(a, b) {
      if (a === b) return true;
      var la = a.length, lb = b.length;
      if (la >= 3 && lb >= 3 && editWithin(a, b, la >= 7 && lb >= 7 ? 2 : 1)) return true;
      var sh = la < lb ? a : b, lo = la < lb ? b : a;
      return sh.length >= 3 && lo.indexOf(sh) === 0;
    }

    function isBackchannelOnly(real) {
      var keys = real.map(looseKey);
      var entries = listKeys(config.backchannels).sort(function (a, b) { return b.length - a.length; });
      var pos = 0;
      while (pos < keys.length) {
        var hit = null;
        for (var i = 0; i < entries.length && !hit; i++) {
          var e = entries[i];
          if (pos + e.length <= keys.length && e.every(function (k, j) { return keys[pos + j] === k; })) hit = e;
        }
        if (!hit) return false;
        pos += hit.length;
      }
      return keys.length > 0;
    }

    function isStopWord(real) {
      var keys = real.map(looseKey).join(" ");
      return listKeys(config.stopWords).some(function (e) { return e.join(" ") === keys; });
    }

    function startsWithStop(real) {
      var keys = real.map(looseKey);
      return listKeys(config.stopWords).some(function (e) { return e.every(function (k, j) { return keys[j] === k; }); });
    }

    function ignoreOnce(reason) {
      if (phraseIgnored) return;
      phraseIgnored = true;
      emit({ type: "decision", kind: "bargeIn", result: "ignored", ms: 0, detail: reason });
    }

    function endPhrase() {
      pf = null;
      phraseIgnored = false;
    }

    function curPf() {
      if (pf && now() - pf.at > Number(config.phraseFilterMs || 0)) pf = null;
      return pf;
    }

    function noteEchoTail(rs) {
      if (!config.duplex || config.echoGuard === false || !rs || rs.resume || !rs.lines.length) return;
      echoTail = { until: now() + Number(config.echoTailMs || 0), seq: keySeq(rs.lines.map(function (l) { return l.text; })) };
    }

    function flushHeld() {
      if (!held.length) return;
      held.forEach(function (t) { finals.push(" " + t); });
      held = [];
      utteranceChanged();
    }

    /** Reference lists (ordered loose keys): the voice's words (speakers only), then the phrase's committed/frozen text. */
    function buildRefs() {
      var refs = [];
      if (config.echoGuard !== false) {
        if (reply && !reply.resume && reply.lines.length) refs.push(keySeq(reply.lines.map(function (l) { return l.text; })));
        if (echoTail && now() < echoTail.until) refs.push(echoTail.seq);
      }
      var ph = curPf();
      if (ph) {
        if (ph.committed) refs.push(ph.committed);
        if (ph.frozen) ph.frozen.forEach(function (r) { refs.push(r); });
      }
      return refs.filter(function (r) { return r.length; });
    }

    /** Word index within the current reply's spoken words that the voice has reached (the cut-off's estimate). */
    function spokenWordIndex(rs) {
      var pos = rs.pos;
      if (!pos || !rs.lines.length) return 0;
      var idx = -1;
      if (pos.id != null) for (var i = 0; i < rs.lines.length; i++) if (rs.lines[i].id === pos.id) idx = i;
      if (idx < 0) idx = Math.min(Math.max(0, pos.line | 0), rs.lines.length - 1);
      var n = 0;
      for (var k = 0; k < idx; k++) n += tokens(rs.lines[k].text).length;
      var inLine = Math.floor((pos.ms || 0) / 1000 * config.wordsPerMinute * rs.rate / 60);
      return n + Math.min(Math.max(0, inLine), tokens(rs.lines[idx].text).length);
    }

    /** Is this stop word/phrase what the voice is saying right now (about 10 words back to 5 ahead)? */
    function nearSpeaking(words) {
      var rs = reply;
      if (!rs || rs.resume || !rs.lines.length) return false;
      var ref = keySeq(rs.lines.map(function (l) { return l.text; }));
      var p = spokenWordIndex(rs);
      var win = ref.slice(Math.max(0, p - 10), p + 5);
      var keys = words.map(looseKey);
      return win.some(function (x, i) {
        return keys.every(function (k, j) { return i + j < win.length && wordMatch(k, win[i + j]); });
      });
    }

    /**
     * Tolerant alignment of an event's words to the reference lists. A span is two or more matched words, in
     * order, within one list, with at most one event word and at most one reference word between neighbours;
     * everything from the first to the last matched word of a span is explained. If every word of the event
     * matches some word of the reference bag, the whole event is explained.
     */
    function explain(keys, refs) {
      var n = keys.length;
      var mask = [];
      for (var q = 0; q < n; q++) mask.push(false);
      if (!refs.length || !n) return { mask: mask, hasSpan: false, whole: false };
      var inBag = function (k) { return refs.some(function (r) { return r.some(function (x) { return wordMatch(k, x); }); }); };
      if (keys.every(inBag)) return { mask: mask.map(function () { return true; }), hasSpan: false, whole: true };
      var gaps = [[0, 0], [1, 0], [0, 1], [1, 1]];
      var extend = function (e0, r, r0) {
        var i = e0, j = r0, matched = 1, last = e0;
        for (;;) {
          var moved = false;
          for (var g = 0; g < gaps.length && !moved; g++) {
            var ni = i + 1 + gaps[g][0], nj = j + 1 + gaps[g][1];
            if (ni < n && nj < r.length && wordMatch(keys[ni], r[nj])) { i = ni; j = nj; matched++; last = ni; moved = true; }
          }
          if (!moved) break;
        }
        return { first: e0, last: last, matched: matched };
      };
      var pos = 0, spans = 0;
      while (pos < n) {
        var best = null;
        for (var e0 = pos; e0 < n; e0++) {
          for (var ri = 0; ri < refs.length; ri++) {
            var r = refs[ri];
            for (var r0 = 0; r0 < r.length; r0++) {
              if (!wordMatch(keys[e0], r[r0])) continue;
              var sp = extend(e0, r, r0);
              if (sp.matched >= 2 && (!best || sp.matched > best.matched)) best = sp;
            }
          }
          if (best) break; // earliest start wins; within it, the most matched words
        }
        if (!best) break;
        for (var m = best.first; m <= best.last; m++) mask[m] = true;
        spans++;
        pos = best.last + 1;
      }
      return { mask: mask, hasSpan: spans > 0, whole: false };
    }

    function textOut(kind, words) { return (kind === "final" ? " " : "") + words.join(" "); }

    /** Claude is thinking or speaking and the user is talking: stop Claude exactly as takeFloor() would. */
    function cutBarge(real, kind, refs) {
      var all = graceCarry.concat(real);
      graceCarry = [];
      var text = all.join(" ");
      emit({ type: "decision", kind: "bargeIn", result: "cut", ms: 0, detail: text });
      gen++;
      abortSpeculative("barge-in");
      clearTimers();
      cutOffReply(); // also moves held lone words into the utterance
      var carried = utteranceText();
      clearUtterance();
      var frozen = refs && refs.length ? refs.map(function (r) { return r.slice(); }) : null;
      droppedGuess = false;
      phraseIgnored = false;
      if (kind === "final") {
        pf = null;
        finals = [carried ? carried + " " + text : text];
        partial = "";
      } else {
        // The phrase is still arriving: keep explaining its already-seen words until it ends.
        pf = { committed: null, frozen: frozen, at: now() };
        finals = carried ? [carried] : [];
        partial = text;
      }
      setState("listening");
      utteranceChanged();
      lastActivity = now();
      scheduleSilence();
    }

    /** Words that would stop Claude. During a cut-in's grace period they are recorded instead, unless a stop word. */
    function barge(real, kind, refs) {
      var rs = reply;
      if (rs && rs.kind === "cutIn" && rs.graceUntil && now() < rs.graceUntil && !isStopWord(real)) {
        graceCarry = graceCarry.concat(real);
        var p = curPf() || (pf = { committed: null, frozen: null, at: now() });
        p.committed = (p.committed || []).concat(real.map(looseKey));
        if (kind === "final") endPhrase();
        return null;
      }
      cutBarge(real, kind, refs);
      return null;
    }

    /**
     * Duplex handling of one mic event. Returns null when the event is fully handled or dropped, otherwise the
     * (possibly filtered) text for the normal path.
     */
    function duplexIncoming(kind, raw) {
      var ph = curPf();
      if (ph) ph.at = now();
      var all = tokens(raw);
      var words = all.filter(function (w) { return !isFiller(w); });
      var fillersRemoved = all.length !== words.length;
      if (!words.length) { if (kind === "final") endPhrase(); return null; }
      var inZone = (state === "thinking" || state === "speaking") && micOpen();
      var echoOn = config.echoGuard !== false;
      var refs = buildRefs();
      var done = function (v) { if (kind === "final") endPhrase(); return v; };

      // A lone stop word is echo only if it is what the voice is saying right now.
      if (isStopWord(words)) {
        if (inZone) {
          if (echoOn && nearSpeaking(words)) { ignoreOnce("echo"); return done(null); }
          return barge(words, kind, refs);
        }
        return fillersRemoved ? textOut(kind, words) : raw;
      }

      var ex = explain(words.map(looseKey), refs);
      if (ex.whole) { ignoreOnce("echo"); return done(null); }
      var real = words;
      if (ex.hasSpan) {
        // The rest is probably misheard echo: it counts only as a long enough run, or one starting with a stop word.
        var minRun = echoOn ? Math.max(1, Number(config.mixedMinWords) || 3) : Math.max(1, Number(config.bargeInMinWords) || 1);
        real = [];
        var run = [];
        var flushRun = function () {
          if (run.length && (run.length >= minRun || startsWithStop(run))) real = real.concat(run);
          run = [];
        };
        words.forEach(function (w, i) { if (ex.mask[i]) flushRun(); else run.push(w); });
        flushRun();
      }
      if (inZone) {
        if (!real.length) ignoreOnce("mishearing");
        else if (ex.hasSpan) {
          if (isBackchannelOnly(real)) ignoreOnce("backchannel");
          else return done(barge(real, kind, refs));
        } else if (isBackchannelOnly(real)) ignoreOnce("backchannel");
        else if (real.length >= Math.max(1, Number(config.bargeInMinWords) || 1)) return done(barge(real, kind, refs));
        else { ignoreOnce("short"); if (kind === "final") held.push(real.join(" ")); }
        return done(null);
      }
      if (!real.length) { ignoreOnce("mishearing"); return done(null); }
      if (!ex.hasSpan && !fillersRemoved) return raw;
      return textOut(kind, real);
    }

    function onPartialEv(e) {
      if (destroyed || muted || staleClose > 0) return;
      var t = (e && e.text) || "";
      // "" means the phrase settled; its final follows (or preceded). Keep the last guess until the
      // next final replaces it, so the settle itself is not a change.
      if (!t) {
        if (config.duplex) endPhrase();
        if (partial && !droppedGuess) {
          droppedGuess = true;
          checkedSinceDrop = false;
          var shown = utteranceText();
          if (shown !== lastNorm) { lastNorm = shown; emit({ type: "partial", text: shown }); }
        }
        return;
      }
      if (config.duplex) { t = duplexIncoming("partial", t); if (t === null) return; }
      partial = t;
      droppedGuess = false;
      handleActivity(utteranceChanged());
      maybeListen();
    }

    function onFinalEv(e) {
      if (destroyed || muted || staleClose > 0) return;
      var t = (e && e.text) || "";
      if (!t) return;
      if (config.duplex) { t = duplexIncoming("final", t); if (t === null) return; }
      finals.push(t);
      var wasDropped = droppedGuess;
      partial = "";
      droppedGuess = false;
      var changed = utteranceChanged();
      if (!changed && wasDropped && checkedSinceDrop) {
        // The withdrawn guess was already acted on (a check ran without it): this final is new input.
        version++;
        lastActivity = now();
        changed = true;
      }
      handleActivity(changed);
      if (config.duplex) endPhrase();
      if (changed) maybeListen();
    }

    function handleActivity(changed) {
      if (!changed || state !== "listening") return;
      pausePending = false;
      if (replyAsk && inflight(replyAsk) && replyAsk.spec && !replyAsk.committing) abortAsk(replyAsk, "user resumed");
      if (forceTimer != null) { clock.clearTimeout(forceTimer); forceTimer = null; }
      scheduleSilence();
    }

    /** Start a listening step when enough new words have been heard while the user is still talking. */
    function maybeListen(atOnce) {
      if (destroyed || state !== "listening" || !micOpen() || !canModel()) return;
      if (!(config.assertiveness > 0)) return;
      if (inflight(listenAsk) || inflight(replyAsk)) return;
      var t = now();
      if (t < backoffUntil) return;
      if (t - lastCutInAt < config.cutInCooldownMs) return;
      var words = wordCount(utteranceText());
      if (words - lastStepWords < Math.max(1, Number(config.listenEveryWords) || 8)) return;
      if (!atOnce && t - lastStepAt < config.listenMinGapMs) return;
      var S = Number(config.strictEveryWords) || 0;
      var level = S > 0 ? Math.floor(words / S) : 0;
      var strict = level >= 1 && level > strictLevel;
      if (strict) strictLevel = level;
      startAsk(strict ? "strict" : "listen", { spec: true });
    }

    /** Mic failure from a rejected start() or an idle event; one notice per mic session. */
    function micFailure(err, reasonCode) {
      var code = reasonCode || (err && err.code);
      if (code === "dismissed" || code === "stopped" || code === "hidden" || code === "time_limit" || code === "viewer_stopped") return;
      if (code === "not_granted" || code === "unavailable") micBroken = true;
      if (micNoticeToken === micToken) return;
      micNoticeToken = micToken;
      var d = errDetail(err, { reason: code || "unknown" });
      if (code === "not_granted") notice("mic_denied", "Microphone access was denied. Typing still works.", d);
      else if (code === "unavailable") notice("mic_unavailable", "The microphone isn't available here. Typing still works.", d);
      else notice("mic_error", "The microphone stopped working. Tap to try again, or type.", d);
    }

    function onMicState(e) {
      if (destroyed || !e || e.state !== "idle") return;
      idleWaiters.slice().forEach(function (w) { w(true); });
      var reason = e.reason;
      // Only the engine calls stop(), so "stopped" is never the mic ending on its own; it may also
      // arrive late from a previous session.
      if (reason === "stopped") return;
      var mine = micStopping > 0;
      micOn = false;
      syncBlocked();
      micFailure(null, reason);
      if (mine) return;
      if (state !== "listening") return;
      gen++;
      abortSpeculative("mic ended");
      clearTimers();
      if (reason === "viewer_stopped") {
        if (utteranceText()) {
          setState("thinking");
          startForcedCommit({});
        } else setState("idle");
        return;
      }
      setState("idle");
    }

    function onVoicePosition(e) {
      var rs = reply;
      if (!rs || rs.dead || rs.stage !== "live" || !e) return;
      if (e.id != null && !rs.lines.some(function (l) { return l.id === e.id; })) return;
      rs.audible = true;
      rs.pos = e;
      if (rs.resume) setBlocked(false);
    }

    function onVoiceState(e) {
      var rs = reply;
      if (!rs || rs.dead || rs.stage !== "live" || !e) return;
      if (e.state === "speaking" && rs.lines.length) {
        rs.audible = true;
        if (rs.resume) setBlocked(false);
      }
    }

    // --------------------------------------------------------- public: floor

    function startMic() {
      var token = ++micToken;
      micStarting = true;
      micOn = true;
      syncBlocked();
      var p;
      try { p = mic.start(); } catch (err) { p = Promise.reject(err); }
      Promise.resolve(p).then(
        function () { if (token === micToken) micStarting = false; },
        function (err) {
          if (destroyed || token !== micToken) return;
          micStarting = false;
          micOn = false;
          micFailure(err);
          if (state === "listening") setState("idle");
        }
      );
    }

    function takeFloor() {
      if (destroyed) return;
      if (!canMic()) {
        if (state === "thinking" || state === "speaking") {
          gen++;
          abortSpeculative("floor taken");
          clearTimers();
          cutOffReply();
          setState("idle", true);
        } else {
          notice("mic_unavailable", "The microphone isn't available here. Type your message instead.", { reason: "no_mic" });
        }
        return;
      }
      var open = micOpen();
      if (state === "listening" && open && !micStopping) return; // already holding the floor
      gen++;
      muted = false;
      abortSpeculative("floor taken");
      clearTimers();
      cutOffReply();
      // Must stay synchronous: the platform only allows the mic to start inside the gesture.
      if (!open || micStopping) startMic();
      setState("listening");
      lastActivity = now();
      scheduleSilence();
    }

    function submitText(text) {
      if (destroyed) return false;
      text = String(text == null ? "" : text).trim();
      if (!text) return false;
      if (!canModel()) {
        notice("model_unavailable", "Claude isn't available here, so there is nothing to send this to.", { reason: "unavailable" });
        return false;
      }
      gen++;
      abortSpeculative("typed message");
      clearTimers();
      cutOffReply();
      var spoken = utteranceText();
      if (config.duplex && micOpen() && partial && !droppedGuess) {
        pf = { committed: keySeq([spoken + " " + text]), frozen: null, at: now() }; // the mic keeps growing this guess
      }
      finals = [spoken ? spoken + " " + text : text];
      partial = "";
      droppedGuess = false;
      utterTyped = true;
      utteranceChanged();
      setState("thinking");
      startForcedCommit({ typed: true });
      return true;
    }

    /** The user asks for Claude's view now: commit what they said and ask in forced mode, with the notes. */
    function yourTake() {
      if (destroyed) return false;
      if (!canModel()) {
        notice("model_unavailable", "Claude isn't available here, so there is nothing to ask.", { reason: "unavailable" });
        return false;
      }
      if (!utteranceText() && history.length === 0) return false;
      gen++;
      abortSpeculative("your take");
      clearTimers();
      pausePending = false;
      cutOffReply();
      setState("thinking");
      return startForcedCommit({});
    }

    function resumeVoice() {
      if (destroyed || !blocked || state !== "idle" || micOpen() || !canVoice()) return false;
      var turn = null;
      for (var i = history.length - 1; i >= 0; i--) if (history[i].role === "assistant") { turn = history[i]; break; }
      var text = turn && turn.text ? turn.text : "Voice is back on.";
      gen++;
      var ask = { ended: true, text: text, err: null, refused: false, dead: false, settled: true, images: [],
                  gen: gen, ctrl: { abort: noop } };
      // A replay never touches history or any turn: it only speaks.
      var rs = { ask: ask, kind: "resume", resume: true, gen: gen, stage: "live", dead: false, turn: null, lines: [], pending: 0,
                 consumed: text.length, restIssued: true, audible: false, pos: null, voiceFailed: false, noSpeak: false,
                 forceIdle: false, rate: rateNow(), commitMs: 0 };
      ask.rs = rs;
      reply = rs;
      // Synchronous: this must happen inside the viewer's own press.
      splitLines(text, MAX_LINE_CHARS).forEach(function (p, i) { issue(rs, p, i === 0); });
      return true;
    }

    function stop() {
      if (destroyed) return Promise.resolve();
      gen++;
      muted = true;
      abortSpeculative("stopped");
      clearTimers();
      cutOffReply();
      clearUtterance();
      clearNotes();
      pausePending = false;
      echoTail = null;
      held = [];
      graceCarry = [];
      endPhrase();
      var p = Promise.resolve();
      if (micOpen()) {
        // Words from this session keep arriving while it finishes: ignore them until it has closed.
        staleClose++;
        var released = false;
        var release = function () {
          if (released) return;
          released = true;
          idleWaiters = idleWaiters.filter(function (w) { return w !== release; });
          staleClose--;
          if (muted) clearUtterance();
        };
        idleWaiters.push(release); // the old session's idle event, or stop() settling, whichever comes first
        p = closeMic(release).then(release);
      }
      setState("idle");
      return p;
    }

    function reset() {
      var p = stop();
      history.slice().forEach(function (t) { emit({ type: "turnRemove", id: t.id }); });
      history = [];
      promptTrimNoticed = false;
      // The platform's block outlives the conversation: tell the page the current values again.
      lastBlockedB = blocked;
      lastBlockedC = blocked && state === "idle" && !micOpen() && canVoice();
      emit({ type: "voiceBlocked", blocked: blocked, canResume: lastBlockedC });
      attachments.slice().forEach(function (a) { dropAttachment(a); });
      return p;
    }

    function setConfig(patch) {
      if (!patch) return;
      var oldRate = config.rate;
      Object.keys(patch).forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) config[k] = patch[k];
      });
      if (config.rate !== oldRate && state === "speaking" && canVoice() && typeof voice.setRate === "function") {
        try { Promise.resolve(voice.setRate(rateNow())).catch(noop); } catch (_) { /* ignore */ }
        if (reply) reply.rate = rateNow();
      }
      if (patch.maxContextBytes !== undefined) layoutAttachments().forEach(function (x) { emit({ type: "attachment", attachment: attView(x) }); });
      if (patch.pauseMs !== undefined) scheduleSilence();
    }

    // ----------------------------------------------------------- attachments

    function attView(a) {
      var v = { id: a.id, kind: a.kind, name: a.name, chars: a.text.length, bytes: a.bytes, truncated: !!a.truncated, included: a.included };
      if (a.describing) v.describing = true;
      return v;
    }

    function layoutAttachments() {
      var total = 0;
      var changed = [];
      attachments.forEach(function (a) {
        var avail = Math.max(0, config.maxContextBytes - total);
        var ctx = a.bytes <= avail ? a.text : truncBytes(a.text, avail);
        var inc = ctx === a.text ? a.bytes : byteLen(ctx);
        var tr = inc < a.bytes;
        if (inc !== a.included || tr !== a.truncated) changed.push(a);
        a.included = inc;
        a.truncated = tr;
        a.ctx = ctx;
        total += inc;
      });
      return changed;
    }

    function addAttachment(a) {
      if (destroyed || !a || (a.kind !== "text" && a.kind !== "image")) return null;
      var att = { id: "a" + (++attSeq), kind: a.kind, name: String(a.name || a.kind), text: "", bytes: 0, ctx: "", included: 0,
                  truncated: false, describing: false, blob: null, sent: false, ctrl: null, removed: false,
                  dropNoticed: false, describeSettle: null };
      if (a.kind === "text") { att.text = String(a.text == null ? "" : a.text); att.bytes = byteLen(att.text); }
      else { att.blob = a.blob; att.describing = canModel(); }
      attachments.push(att);
      layoutAttachments();
      emit({ type: "attachment", attachment: attView(att) });
      if (att.kind === "image") describeImage(att);
      return att.id;
    }

    function describeImage(att) {
      if (!canModel()) { att.describing = false; emit({ type: "attachment", attachment: attView(att) }); return; }
      var ctrl = new AbortController();
      att.ctrl = ctrl;
      var t0 = now();
      var done = false;
      att.describeSettle = function (result, detail) {
        if (done) return;
        done = true;
        var e = { type: "decision", kind: "describe", result: result, ms: now() - t0 };
        if (detail !== undefined) e.detail = detail;
        emit(e);
      };
      var p;
      try {
        p = model.ask([{ role: "user", content: DESCRIBE_PROMPT }], { tier: "quick", signal: ctrl.signal, images: [att.blob] });
      } catch (err) { p = Promise.reject(err); }
      Promise.resolve(p).then(
        function (res) {
          if (destroyed || att.removed) return;
          att.text = String((res && res.text) || "");
          att.bytes = byteLen(att.text);
          att.describing = false;
          att.ctrl = null;
          att.describeSettle("speak", att.text.slice(0, 80));
          var ch = layoutAttachments();
          if (ch.indexOf(att) < 0) ch.push(att);
          ch.forEach(function (x) { emit({ type: "attachment", attachment: attView(x) }); });
        },
        function (err) {
          if (destroyed || att.removed) return;
          att.describing = false;
          att.ctrl = null;
          var code = err && err.code;
          att.describeSettle(code === "cancelled" ? "dropped" : "error", code || "error");
          if (isImageError(code)) dropImages([att], code);
          else if (code === "rate_limited") {
            backoffUntil = now() + config.rateLimitBackoffMs;
            notice("rate_limited", "Claude is rate limited right now, so the image wasn't described.", errDetail(err, { name: att.name }));
          } else if (code === "not_granted" || code === "sampling_disabled" || code === "not_declared" ||
                     code === "capability_disabled" || code === "capability_removed") {
            modelOk = false;
            notice("model_unavailable", "Claude can't answer here. Open this page at claude.ai and allow it.", errDetail(err));
          } else if (code !== "cancelled") {
            notice("error", "Couldn't describe " + att.name + ". Claude will still see the image with your next message.", errDetail(err, { name: att.name }));
          }
          emit({ type: "attachment", attachment: attView(att) });
        }
      );
    }

    function dropAttachment(att) {
      att.removed = true;
      if (att.ctrl) {
        try { att.ctrl.abort(); } catch (_) { /* ignore */ }
        att.ctrl = null;
        if (att.describeSettle) att.describeSettle("dropped", "removed");
      }
      var i = attachments.indexOf(att);
      if (i >= 0) attachments.splice(i, 1);
      emit({ type: "attachmentRemove", id: att.id });
    }

    function removeAttachment(id) {
      var att = attachments.filter(function (a) { return a.id === id; })[0];
      if (!att) return;
      dropAttachment(att);
      layoutAttachments().forEach(function (x) { emit({ type: "attachment", attachment: attView(x) }); });
    }

    // ------------------------------------------------------------------- misc

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimers();
      abortSpeculative("destroyed");
      if (reply) { reply.dead = true; abortAsk(reply.ask, "destroyed"); reply = null; }
      attachments.forEach(function (a) { if (a.ctrl) { try { a.ctrl.abort(); } catch (_) { /* ignore */ } } });
      subs.forEach(function (u) { try { u(); } catch (_) { /* ignore */ } });
      subs = [];
    }

    if (mic && mic.available) {
      subs.push(mic.onPartial(onPartialEv));
      subs.push(mic.onFinal(onFinalEv));
      subs.push(mic.onState(onMicState));
    }
    if (voice && voice.available) {
      if (voice.onPosition) subs.push(voice.onPosition(onVoicePosition));
      if (voice.onState) subs.push(voice.onState(onVoiceState));
    }

    return {
      takeFloor: takeFloor,
      submitText: submitText,
      yourTake: yourTake,
      resumeVoice: resumeVoice,
      addAttachment: addAttachment,
      removeAttachment: removeAttachment,
      stop: stop,
      reset: reset,
      setConfig: setConfig,
      getState: function () { return state; },
      getInfo: function () {
        return { state: state, yourTurn: yourTurn, utterance: utteranceText(), notes: notes, mode: config.mode, micAvailable: canMic(),
                 voiceAvailable: canVoice(), voiceBlocked: blocked, modelAvailable: canModel() };
      },
      getHistory: function () { return history.map(function (t) { return Object.assign({}, t); }); },
      destroy: destroy,
    };
  }

  return { createFloor: createFloor, parseReply: parseReply, DEFAULTS: DEFAULTS, classifyReply: classifyReply };
});
