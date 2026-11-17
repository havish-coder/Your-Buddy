#!/usr/bin/env node
// Stand-in for the `claude` program, modelled on Claude Code 2.1.325 as observed with
// `-p --output-format stream-json --verbose --include-partial-messages`.
//
// Behaviour switches (env var OPEN_FLOOR_FAKE_MODE, or a magic word anywhere in the prompt):
//   normal      stream "Fake reply to: <last words of prompt>" in several deltas   (default)
//   slow        stream ~60 deltas, 150 ms apart (for abort tests)       [[slow]]
//   notloggedin result is_error "Invalid API key · Please run /login", exit 1      [[notloggedin]]
//   ratelimit   result is_error "Claude AI usage limit reached", api_error_status 429, exit 1 [[ratelimit]]
//   crash       print one partial delta, write to stderr, exit 3                  [[crash]]
//   garbage     print lines that are not JSON, then exit 0                        [[garbage]]
//   stderrauth  print "Not logged in" on stderr only, exit 1                      [[stderrauth]]
//   hang        never answer (for timeout tests)                                  [[hang]]
//   dieidle     (stream-json input only) exit 1 at once, before any message
// OPEN_FLOOR_FAKE_LOG=<file>: append one JSON line per run: {pid, args, prompt, images, event}.
// Real-process facts it reproduces: with --input-format stream-json the process sits idle and
// prints nothing (not even the init line) until the first user message line arrives; the
// result line comes some time after the last text delta; with a stream-json input it keeps
// waiting for more input after the result until stdin closes.
import fs from "node:fs";

const args = process.argv.slice(2);
const envMode = process.env.OPEN_FLOOR_FAKE_MODE || "normal";
const logFile = process.env.OPEN_FLOOR_FAKE_LOG;
const log = (o) => { if (logFile) { try { fs.appendFileSync(logFile, JSON.stringify({ pid: process.pid, ...o }) + "\n"); } catch {} } };
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = "00000000-0000-4000-8000-000000000001";
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

if (has("--version") || has("-v")) { console.log("9.9.9 (Fake Claude Code)"); process.exit(0); }
if (!has("-p") && !has("--print")) { console.error("fake-claude: only print mode is supported"); process.exit(2); }

const streamIn = val("--input-format") === "stream-json";
process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));
log({ event: "start", args, streamIn, cwd: process.cwd() });
// OPEN_FLOOR_FAKE_UNKNOWN_FLAG=<flag> with OPEN_FLOOR_FAKE_UNKNOWN=<stderr text>: reject that flag like an old build would.
if (process.env.OPEN_FLOOR_FAKE_UNKNOWN_FLAG && args.includes(process.env.OPEN_FLOOR_FAKE_UNKNOWN_FLAG)) { process.stderr.write((process.env.OPEN_FLOOR_FAKE_UNKNOWN || "error: unknown option") + "\n"); process.exit(2); }
if (envMode === "dieidle" && streamIn) process.exit(1);

// ---- read the prompt ----
function readAll() {
  return new Promise((resolve) => { let b = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (b += d)); process.stdin.on("end", () => resolve(b)); });
}
function readFirstLine() {
  return new Promise((resolve) => {
    let b = ""; process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { b += d; const i = b.indexOf("\n"); if (i >= 0) resolve(b.slice(0, i)); });
    process.stdin.on("end", () => resolve(null));
  });
}
let prompt = "", images = [];
if (streamIn) {
  const line = await readFirstLine();
  if (line === null) process.exit(0);
  let m; try { m = JSON.parse(line); } catch { console.error("fake-claude: bad stdin JSON"); process.exit(1); }
  if (m.type !== "user" || !m.message || !Array.isArray(m.message.content)) { console.error("fake-claude: bad message shape"); process.exit(1); }
  for (const b of m.message.content) {
    if (b.type === "text") prompt += b.text;
    else if (b.type === "image") images.push({ media_type: b.source?.media_type, bytes: Buffer.from(b.source?.data || "", "base64").length });
  }
  // keep the process alive after answering until stdin closes, like the real one
  process.stdin.resume();
} else {
  prompt = await readAll();
}
log({ event: "prompt", prompt, images });

const magic = /\[\[(slow|notloggedin|ratelimit|crash|garbage|stderrauth|hang|maxtokens|refusal|refusaltext)\]\]/.exec(prompt);
const mode = magic ? magic[1] : envMode;

const model = val("--model") || "default";
const msgId = "msg_fake_" + process.pid;
const usage = { input_tokens: 2, output_tokens: 7 };

out({ type: "active_goal", value: null, session_id: sid });
out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, tools: [], mcp_servers: [], model, permissionMode: "default", claude_code_version: "9.9.9" });
out({ type: "system", subtype: "status", status: "requesting", session_id: sid });

const result = (extra) => out({ type: "result", subtype: "success", is_error: false, duration_ms: 1, num_turns: 1, session_id: sid, stop_reason: "end_turn", usage, ...extra });
const delta = (text) => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, session_id: sid, parent_tool_use_id: null });

if (mode === "garbage") {
  process.stdout.write("this is not json\n{broken json\n\u0000\u0001 binary-ish noise\n");
  process.exit(0);
}
if (mode === "stderrauth") { process.stderr.write("Not logged in · Please run /login\n"); process.exit(1); }
if (mode === "notloggedin") {
  out({ type: "assistant", message: { model: "<synthetic>", id: msgId, type: "message", role: "assistant", content: [{ type: "text", text: "Invalid API key · Please run /login" }] }, error: "authentication_failed", session_id: sid });
  result({ subtype: "success", is_error: true, result: "Invalid API key · Please run /login", api_error_status: 401, stop_reason: "stop_sequence" });
  process.exit(1);
}
if (mode === "ratelimit") {
  out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" }, session_id: sid });
  result({ is_error: true, result: "Claude AI usage limit reached|1794769800", api_error_status: 429 });
  process.exit(1);
}
if (mode === "hang") { setInterval(() => {}, 1000); await new Promise(() => {}); }

out({ type: "stream_event", event: { type: "message_start", message: { model, id: msgId, type: "message", role: "assistant", content: [], stop_reason: null, usage } }, session_id: sid, parent_tool_use_id: null });
out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sid, parent_tool_use_id: null });

if (mode === "crash") {
  delta("Partial ");
  await sleep(20);
  process.stderr.write("fake-claude: simulated crash with secret detail /home/user/.claude/credentials\n");
  process.exit(3);
}

const stopReason = mode === "maxtokens" ? "max_tokens" : (mode === "refusal" || mode === "refusaltext") ? "refusal" : "end_turn"; // [[maxtokens]] [[refusal]] (no text) [[refusaltext]] (text, then a refusal)
let parts;
if (mode === "refusal") parts = [];
else if (mode === "slow") parts = Array.from({ length: 60 }, (_, i) => `word${i} `);
else {
  const tail = prompt.trim().split(/\s+/).slice(-4).join(" ");
  const imgNote = images.length ? ` [${images.length} image${images.length > 1 ? "s" : ""}]` : "";
  parts = ["Fake ", "reply ", "to: ", tail, imgNote, "."];
}
let full = "";
for (const p of parts) {
  delta(p); full += p;
  await sleep(mode === "slow" ? 150 : 5);
}
out({ type: "assistant", message: { model, id: msgId, type: "message", role: "assistant", content: [{ type: "text", text: full }], stop_reason: null, usage }, session_id: sid });
out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, session_id: sid, parent_tool_use_id: null });
out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage }, session_id: sid, parent_tool_use_id: null });
out({ type: "stream_event", event: { type: "message_stop" }, session_id: sid, parent_tool_use_id: null });
out({ type: "rate_limit_event", rate_limit_info: { status: "allowed" }, session_id: sid });
// The real program spends a couple of seconds on a post-turn summary before the result line.
const lag = Number(process.env.OPEN_FLOOR_FAKE_RESULT_LAG_MS ?? 150);
await sleep(lag);
out({ type: "system", subtype: "post_turn_summary", status_category: "completed", session_id: sid });
result({ result: full, stop_reason: stopReason });
if (!streamIn) process.exit(0);
// stream-json input: wait for stdin to close, then exit
process.stdin.on("end", () => process.exit(0));
