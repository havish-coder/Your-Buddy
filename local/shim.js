/* Open Floor local shim.
   Emulates window.claude.use("dictation" | "tts" | "sample") on localhost, on top of Chrome's
   webkitSpeechRecognition, speechSynthesis and the server's /api/ask. Method names and event shapes
   follow the platform type definitions (dictation.d.ts, tts.d.ts, sample.d.ts). Classic script. */
(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  root.OPEN_FLOOR_LOCAL = { duplex: true, maxRate: 2.5, micProblem: null, onMicLog: null };

  function emitter() {
    var list = [];
    return {
      on: function (fn) {
        list.push(fn);
        return function () { var i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
      },
      emit: function (e) { list.slice().forEach(function (fn) { try { fn(e); } catch (err) { /* handler errors stay in the page */ } }); },
      list: list
    };
  }

  /* ------------------------------------------------------------------ microphone diagnosis */
  var diag = { code: null, restarts: 0, lastSessionMs: null }; // what recognition last did, for the help box
  function setMicProblem(cause, detail) {
    root.OPEN_FLOOR_LOCAL.micProblem = cause ? { cause: cause, detail: detail || null, code: diag.code, restarts: diag.restarts, lastSessionMs: diag.lastSessionMs } : null;
  }
  function micLog(result, detail) { try { if (root.OPEN_FLOOR_LOCAL.onMicLog) root.OPEN_FLOOR_LOCAL.onMicLog(result, detail); } catch (e) { /* log only */ } }
  // Maps a getUserMedia failure to a cause, then calls done(code). Reads the permission state only when it helps.
  function diagnoseGum(err, done) {
    var n = (err && err.name) || "";
    if (n === "NotFoundError" || n === "DevicesNotFoundError" || n === "OverconstrainedError") { setMicProblem("no_device"); done("unavailable"); return; }
    if (n === "NotReadableError" || n === "TrackStartError" || n === "AbortError") { setMicProblem("busy"); done("upstream_error"); return; }
    var finish = function (state) { setMicProblem("blocked", state === "denied" ? "site" : "system"); done("not_granted"); };
    try {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: "microphone" }).then(function (r) { finish(r && r.state); }, function () { finish(null); });
        return;
      }
    } catch (e) { /* fall through */ }
    finish(null);
  }
  // Called synchronously inside the user's gesture. done(null) means the microphone works.
  function checkMic(done) {
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia || root.isSecureContext === false) { setMicProblem("insecure"); done("not_granted"); return; }
    var p;
    try { p = md.getUserMedia({ audio: true }); } catch (e) { diagnoseGum(e, done); return; }
    p.then(function (stream) {
      try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
      done(null);
    }, function (err) { diagnoseGum(err, done); });
  }

  /* ------------------------------------------------------------------ dictation */
  function makeDictation(SR) {
    var state = "idle";
    var wanted = false;          // the page asked for listening and has not stopped it
    var stopping = false;        // stop() was called; the next real end is the end
    var rec = null;              // current recognition object (late events from older ones are ignored)
    var waiters = [];            // start() promises waiting for "listening"
    var finishWaiters = [];      // stop() promises waiting for idle
    var restarts = [];           // timestamps of automatic restarts
    var hadFinal = false;
    var interim = "";
    var fatal = null;
    var micOk = false;           // getUserMedia worked once on this page load
    var startToken = 0;
    var stopTimer = null;
    var pe = emitter(), fe = emitter(), se = emitter();

    function setState(s, reason) {
      state = s;
      var e = { state: s };
      if (s === "idle" && reason) e.reason = reason;
      se.emit(e);
    }
    function setInterim(t) {
      if (t === interim) return;
      interim = t;
      pe.emit({ text: t });
    }
    function settle(ok, code) {
      var w = waiters; waiters = [];
      w.forEach(function (x) { if (ok) x.res(); else x.rej({ code: code, message: "Dictation did not start (" + code + ")." }); });
    }
    function finalize(reason) {
      clearTimeout(stopTimer);
      var r = rec; rec = null;
      if (r) { r.onstart = r.onresult = r.onerror = r.onend = null; try { r.abort(); } catch (e) { /* already ended */ } }
      var wasStarting = state === "starting";
      wanted = false; stopping = false;
      if (interim) { interim = ""; pe.emit({ text: "" }); }
      if (wasStarting && reason !== "stopped") settle(false, reason);
      else if (wasStarting) settle(false, "stopped");
      if (state !== "idle") setState("idle", reason);
      var f = finishWaiters; finishWaiters = [];
      f.forEach(function (fn) { fn(); });
    }
    function joinText(t) {
      t = String(t || "").trim();
      if (!t) return "";
      var out = (hadFinal ? " " : "") + t;
      hadFinal = true;
      return out;
    }
    function spawn() {
      var r = new SR();
      rec = r;
      r.continuous = true;
      r.interimResults = true;
      try { r.lang = navigator.language || "en-US"; } catch (e) { /* ignore */ }
      var began = 0;
      r.onstart = function () {
        if (rec !== r) return;
        began = Date.now();
        if (state === "starting") { setMicProblem(null); setState("listening"); settle(true); }
      };
      r.onresult = function (ev) {
        if (rec !== r) return;
        var finals = [], guess = "";
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          var res = ev.results[i];
          var t = res[0] ? res[0].transcript : "";
          if (res.isFinal) finals.push(t); else guess += t;
        }
        finals.forEach(function (t) { var j = joinText(t); if (j) fe.emit({ text: j }); });
        if (finals.length) { interim = guess; pe.emit({ text: guess.trim() }); interim = guess.trim(); }
        else setInterim(guess.trim());
      };
      r.onerror = function (ev) {
        if (rec !== r) return;
        var code = ev && ev.error;
        diag.code = code || "unknown";
        if (began) diag.lastSessionMs = Date.now() - began;
        micLog("error", "recognition error " + diag.code);
        if (code === "no-speech" || code === "aborted") return;
        if (code === "service-not-allowed") { setMicProblem("browser"); fatal = "not_granted"; }
        else if (code === "not-allowed") { setMicProblem("blocked", "site"); fatal = "not_granted"; }
        else if (code === "language-not-supported") { setMicProblem("other"); fatal = "unavailable"; }
        else if (code === "audio-capture") { setMicProblem("no_device", "capture"); fatal = "unavailable"; }
        else if (code === "network") { setMicProblem("network"); fatal = "upstream_error"; }
        else { setMicProblem("other"); fatal = "upstream_error"; }
        finalize(fatal);
      };
      r.onend = function () {
        if (rec !== r) return;
        if (stopping) { finalize("stopped"); return; }
        if (!wanted) { finalize("stopped"); return; }
        // Chrome ended the session on its own (silence, time limit): restart quietly, stay "listening".
        var now = Date.now();
        var ran = began ? now - began : 0;
        diag.lastSessionMs = ran;
        restarts = restarts.filter(function (t) { return now - t < 10000; });
        if (ran < 1000) restarts.push(now); // only sessions that ended almost at once count toward the limit
        diag.restarts = restarts.length;
        micLog("restart", "session ended after " + ran + " ms");
        if (restarts.length > 5) { setMicProblem("stops"); finalize("upstream_error"); return; }
        if (interim) { interim = ""; pe.emit({ text: "" }); }
        rec = null;
        var tries = 0;
        var again = function () {
          if (!wanted || stopping || rec) return;
          try { spawn(); }
          catch (e) {
            if (tries++ < 1 && e && e.name === "InvalidStateError") { setTimeout(again, 500); return; }
            diag.code = (e && e.name) || "start_failed"; micLog("error", "restart failed " + diag.code);
            setMicProblem("other"); finalize("upstream_error");
          }
        };
        setTimeout(again, 250); // Chrome on Windows can refuse a start() that follows onend too quickly
      };
      r.start(); // may throw InvalidStateError; the caller handles it
    }

    var dictation = {
      start: function () {
        if (state === "finishing") {
          return new Promise(function (r) { finishWaiters.push(r); }).then(function () { return dictation.start(); });
        }
        if (wanted) {
          if (state === "listening") return Promise.resolve();
          return new Promise(function (res, rej) { waiters.push({ res: res, rej: rej }); });
        }
        wanted = true; stopping = false; restarts = []; fatal = null; diag = { code: null, restarts: 0, lastSessionMs: null };
        setState("starting");
        var p = new Promise(function (res, rej) { waiters.push({ res: res, rej: rej }); });
        var launch = function () {
          try {
            if (!SR) { setMicProblem("browser"); finalize("not_granted"); return; }
            spawn();
          } catch (e) { finalize("upstream_error"); }
        };
        if (micOk) { launch(); return p; }
        var token = ++startToken;
        checkMic(function (code) { // getUserMedia is called synchronously, inside the click
          if (token !== startToken || !wanted || state !== "starting") return; // stopped meanwhile
          if (code) { finalize(code); return; }
          micOk = true;
          launch();
        });
        return p;
      },
      stop: function () {
        if (state === "idle") return Promise.resolve();
        var p = new Promise(function (r) { finishWaiters.push(r); });
        if (state === "starting") { finalize("stopped"); return p; }
        wanted = false; stopping = true;
        if (state !== "finishing") setState("finishing");
        if (!rec) { finalize("stopped"); return p; } // between an automatic restart and the next session
        try { rec.stop(); } catch (e) { /* ignore */ }
        clearTimeout(stopTimer);
        stopTimer = setTimeout(function () { finalize("stopped"); }, 2500); // onend should arrive sooner
        return p;
      },
      active: function () { return state !== "idle"; },
      onPartial: function (fn) { return pe.on(fn); },
      onFinal: function (fn) { return fe.on(fn); },
      onState: function (fn) {
        var off = se.on(fn);
        if (state !== "idle") { var s = state; setTimeout(function () { if (se.list.indexOf(fn) >= 0) fn({ state: s }); }, 0); }
        return off;
      }
    };
    return dictation;
  }

  /* ------------------------------------------------------------------ tts */
  function splitSentences(text) {
    var out = [];
    var re = /[^.!?…\n]+(?:[.!?…]+["')\]]*|\n+|$)\s*/g, m;
    while ((m = re.exec(text))) { if (m[0].trim()) out.push(m[0]); if (re.lastIndex >= text.length) break; }
    // join very short pieces and cut very long ones
    var merged = [];
    out.forEach(function (s) {
      if (merged.length && (merged[merged.length - 1].length < 25)) merged[merged.length - 1] += s; else merged.push(s);
    });
    var res = [];
    merged.forEach(function (s) {
      while (s.length > 220) {
        var cut = s.lastIndexOf(",", 200); if (cut < 80) cut = s.lastIndexOf(" ", 200); if (cut < 40) cut = 200;
        res.push(s.slice(0, cut + 1)); s = s.slice(cut + 1);
      }
      if (s.trim()) res.push(s);
    });
    return res.length ? res : (text.trim() ? [text] : []);
  }

  function makeTts(synth) {
    var Utt = root.SpeechSynthesisUtterance;
    var state = "idle";
    var rate = 1;
    var voiceName = null;
    var lines = [];        // lines of the current reading: {text, id, call, sentences, index}
    var cur = -1;          // index of the line being spoken
    var sent = 0;          // next sentence within the current line
    var reading = false;
    var token = 0;         // identifies the utterance whose events count
    var lineBase = 0;      // ms spoken in finished sentences of the current line
    var uttStart = 0;      // when the current sentence began
    var speakingNow = false;
    var watchdog = null, posTimer = null, startTimer = null;
    var se = emitter(), pe = emitter(), le = emitter();
    var lastCancel = 0;

    function setState(s, reason) {
      state = s;
      var e = { state: s };
      if (s === "idle" && reason) e.reason = reason;
      se.emit(e);
    }
    function pickVoice() {
      if (!voiceName) return null;
      var vs = synth.getVoices ? synth.getVoices() : [];
      for (var i = 0; i < vs.length; i++) if (vs[i].name === voiceName) return vs[i];
      return null;
    }
    function clampRate(r) { r = Number(r); if (!isFinite(r)) return 1; return Math.min(3, Math.max(0.5, r)); }
    function stopTimers() { clearTimeout(watchdog); clearInterval(posTimer); clearTimeout(startTimer); posTimer = null; }
    function ms() { return Math.round(lineBase + (speakingNow ? Date.now() - uttStart : 0)); }

    function endReading(reason) {
      stopTimers(); token++; speakingNow = false;
      reading = false; lines = []; cur = -1; sent = 0;
      if (state !== "idle") setState("idle", reason);
    }
    function failCalls(list, reason) {
      var seen = [];
      list.forEach(function (l) { if (seen.indexOf(l.call) < 0) seen.push(l.call); });
      seen.forEach(function (c) { if (!c.done) { c.done = true; c.reject({ code: "stopped", message: "Speech was cut short (" + reason + ").", reason: reason }); } });
    }
    function cancelAll(reason) {
      var old = lines;
      var hadReading = reading;
      stopTimers(); token++; // late events from the cancelled utterance are now ignored
      try { synth.cancel(); } catch (e) { /* ignore */ }
      lastCancel = Date.now();
      speakingNow = false;
      reading = false; lines = []; cur = -1; sent = 0;
      if (hadReading && state !== "idle") setState("idle", reason);
      failCalls(old, reason);
    }

    function lineDone() {
      var l = lines[cur];
      var call = l.call;
      call.playedMs += Math.round(lineBase);
      call.left--;
      if (call.left === 0 && !call.done) { call.done = true; call.resolve({ playedMs: call.playedMs }); }
      next();
    }
    function next() {
      stopTimers();
      if (!reading) return;
      if (cur >= 0 && sent >= lines[cur].sentences.length) { /* line finished */ }
      if (cur < 0 || sent >= lines[cur].sentences.length) {
        // move to the next line
        var n = cur + 1;
        if (n >= lines.length) { endReading("completed"); return; }
        cur = n; sent = 0; lineBase = 0;
        le.emit({ line: cur, id: lines[cur].id });
        if (!lines[cur].sentences.length) { lines[cur].call.left--; var c = lines[cur].call; if (c.left === 0 && !c.done) { c.done = true; c.resolve({ playedMs: c.playedMs }); } sent = 0; next(); return; }
      }
      speakSentence();
    }
    function speakSentence() {
      var l = lines[cur];
      var text = l.sentences[sent];
      var my = ++token;
      var u = new Utt(text);
      u.rate = clampRate(rate);
      var v = pickVoice(); if (v) u.voice = v;
      try { u.lang = (v && v.lang) || navigator.language || "en-US"; } catch (e) { /* ignore */ }
      var finished = false;
      function done(skipTime) {
        if (finished || my !== token) return;
        finished = true;
        clearTimeout(watchdog);
        if (speakingNow && !skipTime) lineBase += Date.now() - uttStart;
        speakingNow = false;
        sent++;
        if (sent >= l.sentences.length) lineDone(); else next();
      }
      u.onstart = function () {
        if (my !== token || finished) return;
        speakingNow = true; uttStart = Date.now();
        if (state !== "speaking") setState("speaking");
      };
      u.onend = function () { done(false); };
      u.onerror = function (ev) {
        if (my !== token) return;
        var err = ev && ev.error;
        if (err === "canceled" || err === "interrupted") return; // our own cancel; promises are settled by cancelAll
        done(false);
      };
      uttStart = Date.now(); // fallback if onstart never fires
      // Chrome stalls on some utterances; give up on this one after a generous estimate
      var est = 2500 + (text.length * 90) / u.rate;
      clearTimeout(watchdog);
      watchdog = setTimeout(function () {
        if (my !== token || finished) return;
        try { synth.cancel(); } catch (e) { /* ignore */ }
        done(false);
      }, est);
      if (!posTimer) posTimer = setInterval(function () {
        if (!reading || cur < 0) return;
        pe.emit({ ms: ms(), line: cur, id: lines[cur].id });
      }, 100);
      try { synth.speak(u); } catch (e) { done(true); }
    }

    function normalise(what) {
      if (typeof what === "string") return [{ text: what }];
      if (Array.isArray(what)) return what.map(function (x) { return typeof x === "string" ? { text: x } : x; });
      return [];
    }
    function enqueue(what, opts) {
      opts = opts || {};
      if (opts.rate != null) rate = clampRate(opts.rate);
      if (opts.voice) voiceName = opts.voice;
      var items = normalise(what).filter(function (x) { return x && typeof x.text === "string"; });
      return new Promise(function (resolve, reject) {
        var call = { resolve: resolve, reject: reject, left: items.length, playedMs: 0, done: false };
        if (!items.length) { call.done = true; resolve({ playedMs: 0 }); return; }
        var wasReading = reading;
        items.forEach(function (x) { lines.push({ text: x.text, id: x.id, call: call, sentences: splitSentences(x.text) }); });
        if (!wasReading) {
          reading = true;
          setState("starting");
          var delay = Date.now() - lastCancel < 80 ? 60 : 0; // Chrome can swallow a speak() right after cancel()
          clearTimeout(startTimer);
          var my = token;
          startTimer = setTimeout(function () { if (my === token && reading) next(); }, delay);
        }
      });
    }

    return {
      speak: function (what, opts) {
        if (reading) cancelAll("replaced");
        return enqueue(what, opts);
      },
      add: function (what, opts) { return enqueue(what, opts); },
      stop: function () { if (reading) cancelAll("stopped"); else { try { synth.cancel(); } catch (e) { /* ignore */ } } return Promise.resolve(); },
      pause: function () { try { synth.pause(); } catch (e) { /* ignore */ } if (state === "speaking") setState("paused"); return Promise.resolve(); },
      resume: function () { try { synth.resume(); } catch (e) { /* ignore */ } if (state === "paused") setState("speaking"); return Promise.resolve(); },
      setRate: function (r) { rate = clampRate(r); return Promise.resolve(); },
      active: function () { return reading; },
      voices: function () {
        return new Promise(function (resolve) {
          var tries = 0;
          function go() {
            var vs = synth.getVoices ? synth.getVoices() : [];
            if (!vs.length && tries++ < 10) { setTimeout(go, 100); return; }
            var lang = (navigator.language || "en").toLowerCase();
            var short = lang.split("-")[0];
            var mine = [], other = [];
            vs.forEach(function (v) { ((v.lang || "").toLowerCase().indexOf(short) === 0 ? mine : other).push(v.name); });
            var seen = {}, out = [];
            mine.concat(other).forEach(function (n) { if (!seen[n] && out.length < 12) { seen[n] = 1; out.push(n); } });
            resolve(out);
          }
          go();
        });
      },
      languages: function () { return Promise.resolve([navigator.language || "en-US"]); },
      onState: function (fn) {
        var off = se.on(fn);
        if (state !== "idle") { var s = state; setTimeout(function () { if (se.list.indexOf(fn) >= 0) fn({ state: s }); }, 0); }
        return off;
      },
      onLine: function (fn) { return le.on(fn); },
      onPosition: function (fn) { return pe.on(fn); }
    };
  }

  /* ------------------------------------------------------------------ sample */
  var healthPromise = null;
  function health() {
    if (!healthPromise) {
      healthPromise = fetch("/api/health").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    }
    return healthPromise;
  }
  var CODES = ["cancelled", "rate_limited", "not_granted", "sampling_disabled", "upstream_error", "invalid_request", "prompt_too_large", "images_unavailable", "image_rejected", "refused", "empty_completion"];
  function blobToBase64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { var s = String(r.result || ""); res(s.slice(s.indexOf(",") + 1)); };
      r.onerror = function () { rej(r.error); };
      r.readAsDataURL(blob);
    });
  }

  function sample(input, options) {
    options = options || {};
    var messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
    var tier = options.modelTier && options.modelTier !== "inherit" ? options.modelTier : "quick";
    var signal = options.signal;
    return new Promise(function (resolve, reject) {
      var dead = false;
      var text = "";
      var ctl = new AbortController();
      function fail(code, message) {
        if (dead) return;
        dead = true;
        var e = { code: code, message: message || "Request failed." };
        if (text) e.text = text;
        try { ctl.abort(); } catch (x) { /* ignore */ }
        reject(e);
      }
      function onAbort() { fail("cancelled", "Cancelled."); }
      if (signal) {
        if (signal.aborted) { fail("cancelled", "Cancelled."); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      var imgs = options.images ? (Array.isArray(options.images) ? options.images : (options.images.length != null && !options.images.size ? Array.prototype.slice.call(options.images) : [options.images])) : [];
      Promise.all(imgs.map(function (b) { return blobToBase64(b).then(function (d) { return { mediaType: b.type || "image/png", data: d }; }); })).then(function (images) {
        if (dead) return;
        var body = { messages: messages, tier: tier };
        if (images.length) body.images = images;
        return fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
      }).then(function (res) {
        if (dead || !res) return;
        if (!res.ok || !res.body) {
          return res.text().then(function (t) {
            var code = "upstream_error", msg = "The local server refused the request.";
            try { var j = JSON.parse(t); if (j && j.error) { code = CODES.indexOf(j.error.code) >= 0 ? j.error.code : code; msg = j.error.message || msg; } } catch (e) { /* not JSON */ }
            fail(res.status === 413 ? "prompt_too_large" : code, msg);
          });
        }
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = "";
        function handle(line) {
          if (dead || !line.trim()) return;
          var o;
          try { o = JSON.parse(line); } catch (e) { return; }
          if (typeof o.delta === "string" && o.delta) {
            text += o.delta;
            if (options.onText) { try { options.onText({ text: text, delta: o.delta }); } catch (e) { /* page handler */ } }
          } else if (o.done) {
            if (typeof o.text === "string") text = o.text;
            dead = true;
            if (signal) signal.removeEventListener("abort", onAbort);
            if (o.refused) { reject({ code: "refused", message: "Claude declined to answer." }); return; }
            resolve({ text: text, truncated: !!o.truncated, modelTierApplied: tier });
          } else if (o.error) {
            fail(CODES.indexOf(o.error.code) >= 0 ? o.error.code : "upstream_error", o.error.message);
          }
        }
        function pump() {
          return reader.read().then(function (r) {
            if (dead) { try { reader.cancel(); } catch (e) { /* ignore */ } return; }
            if (r.done) {
              buf += dec.decode();
              buf.split("\n").forEach(handle);
              if (!dead) fail("upstream_error", "The answer ended early.");
              return;
            }
            buf += dec.decode(r.value, { stream: true });
            var parts = buf.split("\n"); buf = parts.pop();
            parts.forEach(handle);
            return pump();
          });
        }
        return pump();
      }).catch(function (err) {
        if (dead) return;
        fail("upstream_error", "Couldn't reach the local server. Is it still running?");
      });
    });
  }
  sample.limits = function () {
    return health().then(function (h) {
      var l = { maxPromptBytes: 262144 };
      if (h && h.images === true) l.images = { maxCount: 3, maxInputBytes: 2500000, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] };
      return l;
    });
  };

  /* ------------------------------------------------------------------ use() */
  var cache = {};
  root.claude = {
    use: function (name) {
      try {
        if (name === "dictation") {
          var SR = root.webkitSpeechRecognition || root.SpeechRecognition;
          if (!SR && !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return Promise.resolve(null);
          return Promise.resolve(cache.d || (cache.d = makeDictation(SR)));
        }
        if (name === "tts") {
          if (!root.speechSynthesis || !root.SpeechSynthesisUtterance) return Promise.resolve(null);
          return Promise.resolve(cache.t || (cache.t = makeTts(root.speechSynthesis)));
        }
        if (name === "sample") { health(); return Promise.resolve(sample); }
      } catch (e) { /* fall through */ }
      return Promise.resolve(null);
    }
  };
})();
