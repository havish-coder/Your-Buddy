# Open Floor

Open Floor is a page for talking with Claude out loud. You speak, Claude answers in a spoken voice, and you can interrupt it by simply talking over it, the way you would with a person. It follows turn-taking rules: it waits for you to finish, does not mistake "yeah" for an interruption, and stops when you say two real words or "stop".

This folder is the version that runs on your own computer. A small server (`server.js`) shows the page in your browser and passes your conversation to the Claude Code program (`claude`) that is already installed and signed in on your machine. No API key is involved, and nothing is stored on disk.

## What you need

- **Node 22 or newer.** Check with `node --version`.
- **Google Chrome** (or another Chromium browser that has speech recognition). Chrome listens to you using its own speech recognition, which sends your voice to Google's servers while you talk, so you need an internet connection. Firefox and Safari will not work.
- **Claude Code, installed and signed in.** Install it from Anthropic's instructions, then run `claude` once in a terminal and type `/login` to sign in with your Claude account.
- A microphone, and speakers or (better) headphones.

No `npm install` is needed. There are no dependencies.

## Run it

```
cd duplex-voice
node server.js
```

Then open <http://localhost:3000> in Chrome.

Three steps in all: change into the folder, start the server, open the address. To use another port, run `PORT=3001 node server.js` (on Windows PowerShell: `$env:PORT=3001; node server.js`). Stop the server with Ctrl+C.

## What to expect the first time

1. The terminal prints `Open Floor is running at http://localhost:3000/` and the version of Claude Code it found. If it does not find `claude`, it says so; see Troubleshooting.
2. Chrome asks to use your microphone when you click to start. Choose Allow. If you chose Block by accident, click the lock icon in the address bar and allow the microphone for this page.
3. Click once on the page to start. After that you do not need the keyboard: the microphone stays open, Claude speaks through the browser's voice, and you can talk over it to take the floor back.
4. The first answer can take a second or two longer than later ones while things warm up.

## Use headphones

Without headphones, your microphone also picks up Claude's voice coming out of your speakers, and Claude can end up answering itself or being cut off by its own words. The page has a filter that ignores words that match what Claude has just said, and it handles most of it, but it is a guess. It cannot tell your voice from Claude's if you repeat Claude's words, and a loud room or loud speakers will still cause trouble.

With headphones there is no echo to filter. Tick **I'm using headphones** in the page's settings and the filter is switched off, which also lets you interrupt more reliably.

## Settings

The page keeps its settings (such as voice, speed and the headphones option) in your browser. The server has a few options set through environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port to listen on. The server only listens on 127.0.0.1, so other computers cannot reach it. |
| `OPEN_FLOOR_CLAUDE_BIN` | `claude` | The program to run, in case it is not on your PATH. |
| `OPEN_FLOOR_PRESTART` | on | Set to `0` to start one `claude` process per question instead of keeping a warm one ready. Slower, and pictures are not supported. |

## How it works, briefly

For each question the server runs `claude` in print mode with all tools turned off and sends the whole conversation to it, so every question stands alone and nothing is remembered by Claude Code between questions. To keep replies fast the server keeps one idle `claude` process per model waiting, uses it for the next question, and starts a new one straight away. The page's "quick", "default" and "complex" tiers map to Claude Code's `haiku`, `sonnet` and `opus`.

The server refuses any request whose Host or Origin is not `localhost` or `127.0.0.1` on its own port, serves only `index.html`, `floor.js` and `local/shim.js`, and starts `claude` without a shell.

## Troubleshooting

**"The `claude` program was not found."** The server could not run `claude`. Open a terminal and type `claude --version`. If that fails, install Claude Code first. If it works in the terminal but not for the server, the server was started from somewhere with a different PATH; start it from that same terminal, or set `OPEN_FLOOR_CLAUDE_BIN` to the full path of the program. On Windows, where `claude` is often `claude.cmd`, the server handles that itself.

**"Claude Code is not signed in."** Run `claude` in a terminal, type `/login`, finish signing in, then try again in the page. You do not need to restart the server.

**A usage or rate limit message.** Your Claude plan has run out of allowance for now. Wait for it to reset and try again.

**Claude does not hear me, or the page says the microphone is blocked.** Check that Chrome has permission for the microphone (lock icon in the address bar) and that the right input device is selected in your system settings. Speech recognition needs an internet connection.

**Claude answers itself, or cuts itself off.** That is echo from your speakers. Use headphones and tick the headphones option, or turn the volume down.

**"Port 3000 is already in use."** Another program is using the port. Start on another one: `PORT=3001 node server.js`, then open `http://localhost:3001`.

## A note on terms of use

Anthropic's documentation allows signing in to Claude Code with a Claude subscription, but it does not clearly say whether personal scripts that drive Claude Code, like this server, are covered by that. If that matters to you, check Anthropic's current terms or ask them before relying on it.

## Tests

```
node --test test/server.test.js
```

The server tests run against a stand-in for `claude` (`test/fixtures/fake-claude.mjs`) and need no network or sign-in.
