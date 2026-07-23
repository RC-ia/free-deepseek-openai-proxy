# free-deepseek-openai-proxy

<p align="center">
  <strong>Local OpenAI-compatible API proxy for DeepSeek Web Chat</strong>
</p>

<p align="center">
  <a href="https://github.com/RC-ia/free-deepseek-openai-proxy/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
  <img alt="Node.js 18 plus" src="https://img.shields.io/badge/node-18%2B-339933.svg" />
  <img alt="No npm dependencies" src="https://img.shields.io/badge/dependencies-0-blue.svg" />
  <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-111111.svg" />
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-features">Features</a> •
  <a href="#-request-examples">Examples</a> •
  <a href="#-models">Models</a> •
  <a href="#-endpoints">Endpoints</a> •
  <a href="#-open-webui">Open WebUI</a>
</p>

free-deepseek-openai-proxy runs a local API server for **DeepSeek Web Chat** (`chat.deepseek.com`) and lets you connect DeepSeek Web to Open WebUI, LiteLLM, Hermes, Claude Code, OpenCode, OpenAI SDK-style clients, and other OpenAI-compatible tools.

It works through your normal logged-in DeepSeek account in a separate Chrome profile. The local server accepts API requests and, under the hood, talks to DeepSeek Web via the saved browser session.

> ⚠️ This is an experimental web-chat proxy. DeepSeek may change the internal Web API without warning. For production use cases, the official paid DeepSeek API is more reliable.

ForgetMeAI: https://t.me/forgetmeai

---

## 🔧 Tool-call normalization patch (vendored)

This fork includes a vendored **tool-call normalizer** (`toolcall_normalizer.js`) that
closes a gap in the upstream parser: DeepSeek Web emits native function calls as XML —

```xml
<tool_call name="todo_write">
  <parameter name="todos">[{"id":"1","content":"...","status":"in_progress"}]</parameter>
</tool_call>
```

— which the original `parseToolCall()` could not parse (it expected a JSON body).
The normalizer also understands the **OpenCode** tool-call shape (`<invoke name="…">…</invoke>`,
optionally wrapped in `<invokes>…</invokes>`), mapping it onto the native parser so OpenCode and
other clients that emit `<invoke>` work end-to-end through the proxy. It also parses OpenCode's
`TodoWrite` payload in either form — `<parameter name="todos">[…]</parameter>` **or** a bare
`<todos>[…]</todos>` array — and always promotes it to a real `todos` array (not a string).
The normalizer runs as a FAST-PATH inside `parseToolCall()` and converts that native
shape (plus strict-JSON / fenced-JSON / legacy `TOOL_CALL:` variants) into a clean
OpenAI `tool_calls` payload.

- **Upstream project (original author — please credit):** [ForgetMeAI/FreeDeepseekAPI](https://github.com/ForgetMeAI/FreeDeepseekAPI) by **ForgetMeAI** (`t.me/forgetmeai`), MIT.
- **Companion normalizer:** [RC-ia/deepseek-toolcall-normalizer](https://github.com/RC-ia/deepseek-toolcall-normalizer) by **RC-ia**, MIT.
- Tests cover the native XML shape (see `tests/unit.test.js`). Run `npm test`.

---

## 👥 Multi-account pool (failover)

To survive DeepSeek Web free-tier rate limits / empty responses, run several
accounts and let the proxy fail over automatically.

The proxy already supports this out of the box via two env vars — no code changes needed:

- **`DEEPSEEK_AUTH_DIR=./accounts`** — load every `*.json` in that folder as a separate account.
- **`DEEPSEEK_AUTH_PATH="./a.json,./b.json"`** — explicit comma-separated list.

Place your auth files in the provided **`accounts/`** folder (see `accounts/README.md` for details):

```bash
mkdir -p accounts
cp deepseek-auth-main.json accounts/main.json
cp deepseek-auth-backup.json accounts/backup.json
chmod 600 accounts/*.json
DEEPSEEK_AUTH_DIR=./accounts NON_INTERACTIVE=1 npm start
```

How it behaves:

- New agent/sessions get an available account **round-robin**.
- The chosen account is **sticky** to the session (no mid-conversation switching).
- On `401` / `403` / `429` the account enters **cooldown**; the next request routes to another healthy account.
- **Empty responses are now treated as account failures too.** DeepSeek Web sometimes returns HTTP 200 with zero content (rate limit / silent throttle / "verify you are human"). Previously that kept retrying the *same* account forever. Now consecutive empty responses mark the account as failed and fail over to the next one. Tunables:
  - `DEEPSEEK_EMPTY_FAILURE_LIMIT` (default `2`) — empty responses before an account cools down.
  - `DEEPSEEK_EMPTY_COOLDOWN_MS` (default `15000`) — cooldown after hitting the limit.
- Account status (ready / cooldown) is visible in `GET /health` — file paths and names are never exposed.
- Set cooldown duration with `DEEPSEEK_ACCOUNT_COOLDOWN_MS` (default 600000 = 10 min).
- **Per-call account throttle:** after an account serves a request it is held in "wait" for `DEEPSEEK_ACCOUNT_CALL_COOLDOWN_MS` (default `25000` = 25 s). Rapid-fire clients (OpenCode, etc.) cannot spawn a new DeepSeek chat every few seconds. If **every** account is in its wait window, the API **blocks and waits** (up to the soonest account freeing up) instead of erroring — so generation never starts until an account is available.

> Security: each `*.json` is your DeepSeek Web login. The `accounts/` folder is
> git-ignored for secrets (`accounts/*.json`); only `.gitkeep` and `accounts/README.md`
> are tracked.

---

## Navigation

- [What it gives you](#-what-it-gives-you)
- [Features](#-features)
- [Quick Start](#-quick-start)
- [Windows run](#-windows-run)
- [Linux / Chromium run](#-linux--chromium-run)
- [VPS / headless run](#-vps--headless-run)
- [Diagnostics / doctor](#-diagnostics--doctor)
- [Session reuse and chat reset](#-session-reuse-and-chat-reset)
- [Multi-account pool](#-multi-account-pool)
- [Verify it works](#-verify-it-works)
- [Request examples](#-request-examples)
  - [Chat Completions](#chat-completions)
  - [Reasoning](#reasoning)
  - [Web search](#web-search)
  - [Streaming](#streaming)
  - [Anthropic Messages API](#anthropic-messages-api)
  - [OpenAI Responses API](#openai-responses-api)
  - [Tool calling](#tool-calling)
- [Models](#-models)
- [Endpoints](#-endpoints)
- [Open WebUI](#-open-webui)
- [Refresh login](#-refresh-login)
- [Self-update](#-self-update)
- [Tests](#-tests)
- [Project status](#-project-status)

---

## ✨ What it gives you

- Use DeepSeek Web as a local API endpoint.
- Connect DeepSeek to Open WebUI and other OpenAI-compatible clients.
- Get normal JSON responses or streaming SSE.
- Use reasoning models with a separate `reasoning_content`.
- Use the Anthropic Messages API shim for Claude Code / Anthropic SDK.
- Use the OpenAI Responses API shim for new OpenAI/Codex-style clients.
- Keep separate web sessions for different agents/users.

## 🚀 Features

- **OpenAI-compatible API:** `POST /v1/chat/completions`
- **Anthropic-compatible shim:** `POST /v1/messages`
- **OpenAI Responses shim:** `POST /v1/responses`
- **Streaming:** SSE chunks and normal non-stream JSON responses
- **Reasoning output:** separate `reasoning_content` for thinking models
- **Tool calling:** parses OpenAI tools, Anthropic tools and Responses function tools
- **Single-model policy:** only `deepseek-reasoner` is exposed and accepted; every request runs with reasoning enabled
- **Advertised 1M context window:** `/v1/models` and chat `usage` report `context_window` / `max_context_length` / `token_limit` = `1_000_000` (DeepSeek V4 theoretical limit). Real Web-chat input cap (~162k chars) is enforced separately — see [Error 413](#-error-413--full-context-validated-behavior)
- **Agent sessions:** a separate DeepSeek session per `user` / agent id
- **Session recovery:** auto-reset of stale chains/sessions
- **Zero dependencies:** Node.js 18+, no npm dependencies
- **Large prompt upload:** prompts over the inline limit (~154k chars) are auto-uploaded as `.txt` file attachments for `deepseek-reasoner`
- **Self-update:** `npm run update` pulls the latest code from git while preserving local auth/config (cross-platform, no `git` CLI quirks)

---

## ⚡ Quick Start

```bash
git clone https://github.com/RC-ia/free-deepseek-openai-proxy.git
cd free-deepseek-openai-proxy
npm install        # installs dev deps (none at runtime; only needed for `npm test`)
npm run auth
npm start
```

> ⚠️ Use the **fork** URL above (`RC-ia/free-deepseek-openai-proxy`). The runtime has **zero npm dependencies** — `npm install` only pulls the test runner.

### `npm run auth` (authorize / refresh login)

Opens a separate Chrome profile so the proxy can reuse your real DeepSeek Web session. The menu shows:

1. **Authorize / refresh DeepSeek login** ← choose this first
2. Import auth file / cookies
3. Show models and statuses
4. Start the proxy (default)
5. Exit

Steps for option `1`:

1. select option `1`;
2. log in to DeepSeek in the separate Chrome profile that opens;
3. send a short message like `ok` in that chat;
4. return to the terminal and press Enter to capture the session.

### `npm start` (startup menu)

After auth, run `npm start` — the menu shows:

- `1` — authorize / refresh DeepSeek login
- `2` — import auth file / cookies
- `3` — show models and statuses
- `4` — **start the proxy (default — just press Enter)**
- `5` — exit

```bash
npm start            # interactive menu; press Enter to start (option 4)
```

For headless/CI run without the menu (requires auth already captured):

```bash
NON_INTERACTIVE=1 npm start
# or
SKIP_ACCOUNT_MENU=1 npm start
```

By default the server listens on:

```text
http://localhost:9655
```

### ⚠️ Error 413 — full context (validated behavior)

The DeepSeek Web chat caps **input** at ~162,131 chars (measured). Over that, DeepSeek Web returns an **empty** response (0 chars) instead of an error — which silently breaks agent loops. This proxy detects it **before** sending and returns a clean **HTTP 413** with usage info in Portuguese, so the client can compress its own history:

```json
{
  "error": {
    "message": "Janela de contexto excedida: o prompt tem 200006 caracteres, mas o limite do chat DeepSeek Web é de ~162.131 caracteres (você estourou em ~37875 caracteres, 123.36% do limite). Comprima o histórico da conversa / anexos antes de tentar de novo.",
    "type": "context_length_exceeded",
    "context_char_limit": 162131,
    "prompt_chars": 200006,
    "context_usage_ratio": 1.2336
  }
}
```

Tunables:

- `DEEPSEEK_CHAT_CONTEXT_CHAR_LIMIT` (default `162131`) — hard char cap of the Web chat.
- `DEEPSEEK_CONTEXT_SAFETY_MARGIN` (default `0.95`) — reject at 95% to avoid the empty-response failure mode.
- `DEEPSEEK_CHAT_CONTEXT_EFFECTIVE_LIMIT` = `CHAR_LIMIT × SAFETY_MARGIN` (the reject threshold).
- `DEEPSEEK_CONTEXT_WINDOW_TOKENS` (default `1000000`) — advertised context window in tokens, surfaced via `/v1/models` and chat `usage` as `context_window` / `max_context_length` / `token_limit`. This is the theoretical DeepSeek V4 limit (1M) so clients don't under-cap themselves. It does **not** raise the real Web-chat char gate above.

> `deepseek-reasoner` supports file attachments. The proxy automatically uploads an oversized prompt as a `.txt` file and sends a short placeholder prompt with `ref_file_ids`, instead of failing with a 413. It does **not** auto-truncate inline text. (Replying with a 413 on a *compaction notice* is intentionally avoided to prevent a compress→413→compress loop.)

---

## 🪟 Windows run

```powershell
git clone https://github.com/RC-ia/free-deepseek-openai-proxy.git
cd free-deepseek-openai-proxy
npm run auth
npm start
```

If Chrome is installed in a non-standard path, set it explicitly:

```powershell
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
npm run auth
```

If Chrome is not found, `npm run auth` now prints ready-made instructions for Windows/macOS/Linux instead of a cryptic stack trace.

---

## 🐧 Linux / Chromium run

```bash
git clone https://github.com/RC-ia/free-deepseek-openai-proxy.git
cd free-deepseek-openai-proxy
CHROME_PATH=$(which chromium) npm run auth
npm start
```

If Chromium has a different name:

```bash
CHROME_PATH=$(which chromium-browser) npm run auth
# or
CHROME_PATH=$(which google-chrome) npm run auth
```

---

## 🖥 VPS / headless run

The most reliable flow without Chrome on the server:

1. On your home PC, where there is GUI/Chrome:

```bash
npm run auth
```

2. Copy `deepseek-auth.json` to the VPS:

```bash
scp deepseek-auth.json user@your-vps:/opt/free-deepseek-openai-proxy/deepseek-auth.json
```

3. On the VPS, import/verify the file and set safe permissions:

```bash
cd /opt/free-deepseek-openai-proxy
npm run auth:import -- --input ./deepseek-auth.json
npm run doctor -- --offline
```

4. Run the proxy without the interactive menu:

```bash
NON_INTERACTIVE=1 npm start
```

You can also import a browser cookie export, not just a ready-made `deepseek-auth.json`:

```bash
DEEPSEEK_TOKEN="<token>" npm run auth:import -- --input ./cookies.json
```

> Important: `deepseek-auth.json` is access to your DeepSeek Web login. Do not commit it, do not publish it, store it with `0600` permissions.

---

## 🩺 Diagnostics / doctor

```bash
npm run doctor
# without network requests to DeepSeek:
npm run doctor -- --offline
```

`doctor` checks:

- whether `deepseek-auth.json` / `DEEPSEEK_AUTH_DIR` is found;
- whether the JSON is valid;
- whether `token`, `cookie`, `wasmUrl` are present;
- whether file permissions are safe on macOS/Linux (`0600`);
- on a normal run — whether the DeepSeek PoW endpoint is reachable.

If you see `data.biz_data is null`, `fetch failed`, `401/403/429`, or Hermes/OpenCode does not see the models — run `npm run doctor` first.

---

## ♻️ Session reuse and chat reset

FreeDeepseekAPI does not create a new DeepSeek chat on every HTTP request without reason. The logic is:

- one `x-agent-session`, `session` or `user` → one DeepSeek chat session;
- if the session id already exists — the proxy reuses it and continues the chain via `parent_message_id`;
- auto-reset happens on TTL, DeepSeek session error, or too long a message chain;
- local history is preserved as a short context so a new DeepSeek session can continue the conversation.

Set agent/session explicitly:

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-agent-session: my-agent" \
  -d '{"model":"deepseek-reasoner","messages":[{"role":"user","content":"Hi"}]}'
```

View active sessions:

```bash
curl http://localhost:9655/v1/sessions
```

Reset one session:

```bash
curl -X POST "http://localhost:9655/reset-session?agent=my-agent"
```

Reset all sessions:

```bash
curl -X POST "http://localhost:9655/reset-session?agent=all"
```

Why chats still show up in DeepSeek Web: the proxy works through the internal Web Chat API, and DeepSeek stores the real chat sessions on its side. That is normal for a web-proxy. The point of session reuse is to not spawn new chats unnecessarily and to reset cleanly only when the chain has gone stale/broken.

---

## 👥 Multi-account pool

You can connect several auth files. The right model: sticky account per agent/session — the proxy does not switch accounts within a live DeepSeek session. If an account gets `401/403/429` and goes into cooldown, the session is safely reset and the next request can move to another available account.

Option 1 — directory with auth files:

```bash
mkdir -p accounts
cp deepseek-auth-main.json accounts/main.json
cp deepseek-auth-backup.json accounts/backup.json
chmod 600 accounts/*.json
DEEPSEEK_AUTH_DIR=./accounts NON_INTERACTIVE=1 npm start
```

Option 2 — list of files:

```bash
DEEPSEEK_AUTH_PATH="./accounts/main.json,./accounts/backup.json" NON_INTERACTIVE=1 npm start
```

How the pool works:

- a new agent/session gets an available account round-robin;
- the chosen account is pinned to the session (`sticky`);
- on `401`, `403`, `429` the account goes into cooldown;
- if the session's sticky account went into cooldown, the old DeepSeek session is reset so it does not hammer the rate-limited/expired account;
- account status is visible in `/health` without exposing auth-file paths or file names;
- auth files should be stored with `0600` permissions.

Set cooldown:

```bash
DEEPSEEK_ACCOUNT_COOLDOWN_MS=600000 npm start
```

---

## 🔑 Ideas for console authorization

The password flow from PR #3 can be done, but it is safer not to store the password and not to make it the default. Normal implementation:

1. `npm run auth:console` asks email/phone and password via a hidden prompt.
2. The password stays only in process memory, not written to files/logs/history.
3. The script replays the Web login flow via `fetch`/CDP: gets the captcha/verify challenge, hands the link/code to the human, waits for confirmation.
4. After successful login, only the standard-format `deepseek-auth.json` is saved.
5. If DeepSeek asks for captcha/2FA — the script honestly says "open the link, pass the check, press Enter", instead of trying to bypass protection.
6. For VPS, the `auth:console --no-save-password --output deepseek-auth.json` mode is preferable.

Minimal safe MVP: console auth is interactive only, no env password. Acceptable automation variant: `DEEPSEEK_EMAIL=... npm run auth:console`, but the password is still entered via hidden prompt.

---

## ✅ Verify it works

```bash
curl http://localhost:9655/
curl http://localhost:9655/v1/models
curl http://localhost:9655/v1/model-capabilities
```

If all is well, `/health` returns the server status, the supported model list (`deepseek-reasoner`), and `config_ready: true`.

---

## 🧪 Request examples

### Chat Completions

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "Hello! Reply with one phrase."}],
    "stream": false
  }'
```

Because the only supported model is `deepseek-reasoner`, the API always returns the thinking chain separately from the final answer:

- non-stream: `choices[0].message.reasoning_content`
- stream: `choices[0].delta.reasoning_content`
- usage: `usage.completion_tokens_details.reasoning_tokens`

`reasoning_tokens` is an approximate estimate from the extracted DeepSeek Web `THINK` text, because the web stream does not return official per-reasoning token usage.

### Streaming

```bash
curl -N -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "Tell a short joke."}],
    "stream": true
  }'
```

### Anthropic Messages API

```bash
curl -X POST http://localhost:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Reply exactly OK"}],
    "stream": false
  }'
```

To use with Claude Code, set the backend directly:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
export ANTHROPIC_AUTH_TOKEN="dummy-key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model deepseek-reasoner
```

### OpenAI Responses API

```bash
curl -X POST http://localhost:9655/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "input": "Reply exactly OK",
    "stream": false
  }'
```

### Tool calling

FreeDeepseekAPI accepts:

- OpenAI `tools`;
- Anthropic `tools`;
- Responses API function tools.

The proxy asks DeepSeek to return a strict JSON tool call, but also parses fallback formats:

- `TOOL_CALL:`
- fenced JSON
- `<tool_call>...</tool_call>` (including the native DeepSeek Web `<tool_call name=><parameter>` shape, thanks to the vendored normalizer)

---

## 🧠 Models

This proxy exposes **exactly one model**:

| Model | Web mode | Reasoning | Web search | Files | Context window |
| --- | --- | --- | --- | --- | --- |
| `deepseek-reasoner` | `default` | yes | no | ✅ | 1 000 000 (advertised) |

Requests with any other model ID return HTTP 400 (`invalid_model`). The proxy does **not** silently remap aliases, so clients cannot accidentally disable reasoning.

`deepseek-reasoner` runs DeepSeek Web default mode with `thinking_enabled=true` (currently DeepSeek-V4-Flash thinking). Large prompts are auto-uploaded as `.txt` attachments when the inline limit is exceeded.

### Advertised context window vs real chat cap

`GET /v1/models` and chat `usage` report **1 000 000 tokens** for `context_window` / `max_context_length` / `token_limit` — the theoretical DeepSeek V4 limit — so clients (Qwen Code, OpenCode, LiteLLM, etc.) don't under-cap themselves at the old ~40k estimate. This advertised value can be overridden with `DEEPSEEK_CONTEXT_WINDOW_TOKENS`.

The real DeepSeek Web **chat input** cap is ~162 131 chars (~40k tokens). That gate is independent of the advertised window and is enforced by the 413 / file-upload path (see [Error 413](#-error-413--full-context-validated-behavior)). Advertising 1M does **not** raise the physical chat input limit.

```bash
curl http://localhost:9655/v1/models
# {
#   "data": [{
#     "id": "deepseek-reasoner",
#     "context_window": 1000000,
#     "max_context_length": 1000000,
#     "token_limit": 1000000,
#     "capabilities": { "reasoning": true, "web_search": false, "files": true }
#   }]
# }

curl http://localhost:9655/v1/model-capabilities
```

---

## 🔌 Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` or `/health` | proxy status |
| `GET` | `/v1/models` | list of the single supported model |
| `GET` | `/v1/model-capabilities` | real model mapping and capabilities for `deepseek-reasoner` |
| `POST` | `/v1/chat/completions` | OpenAI-compatible Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages API shim |
| `POST` | `/v1/responses` | OpenAI Responses API shim |
| `GET` | `/v1/sessions` | active local agent sessions |
| `POST` | `/reset-session?agent=<id>` | reset one session |
| `POST` | `/reset-session?agent=all` | reset all sessions |

---

## 🖥 Open WebUI

Base URL for Open WebUI in Docker:

```text
http://host.docker.internal:9655/v1
```

For local run without Docker:

```text
http://localhost:9655/v1
```

The API key can be anything: the proxy talks to DeepSeek Web via the saved browser session.

---

## 🔐 Refresh login

```bash
npm run auth
npm start
```

If DeepSeek starts responding `401`, `403`, or asks for a new PoW/session — repeat `npm run auth` and refresh the saved browser session.

Local auth files should not go to GitHub:

- `deepseek-auth.json`
- `.chrome-profile-deepseek/`
- `.env`

They are already in `.gitignore`.

---

## 🔄 Self-update

Pull the latest code from the git remote while preserving local auth/config files (`.env`, `auth.json`, `deepseek-auth.json`, `accounts/*.json`, `package-lock.json`). Works on Windows, WSL, and Linux — no Unix shell quirks.

```bash
npm run update           # interactive: shows commits behind/ahead, asks y/N
npm run update:pull       # non-interactive: snapshot → stash → pull --rebase → restore
npm run update -- --status   # show current commit + remote + working-tree state
npm run update -- --check    # exit 0 = up-to-date, 1 = updates available
```

What it does:

1. **Snapshots** protected auth/config files to a temp dir (survives even if gitignored).
2. **Stashes** all dirty tracked + untracked files (`git stash push --include-untracked`) so the rebase can fast-forward cleanly.
3. **`git pull --rebase origin <branch>`** (detects `main` or `master` automatically).
4. **Restores** the auth snapshot (overwrites whatever the pull put there).
5. **Pops** the stash (your pre-update local edits come back; conflicts are warned, not silently dropped).
6. **Syntax check** on `server.js`.

If the working tree is still dirty after stash (shouldn't happen), it aborts safely without clobbering.

---

## 🧪 Tests

Project syntax check + unit tests:

```bash
npm test
```

Live smoke tests against a running local proxy:

```bash
BASE_URL=http://127.0.0.1:9655 MODEL=deepseek-reasoner npm run test:live
```

---

## 📌 Project status

FreeDeepseekAPI is an experimental web-chat proxy for local use and integrations. It depends on the current DeepSeek Web Chat contract, so changes on DeepSeek's side may require updating auth/session logic or model mapping.

If something stopped working:

1. refresh the login via `npm run auth`;
2. check `/v1/model-capabilities`;
3. retry on a fresh session;
4. if the problem persists — DeepSeek likely changed the internal Web API.

---

<p align="center">
  <strong>RC-ia</strong> · fork of <a href="https://github.com/ForgetMeAI/FreeDeepseekAPI">ForgetMeAI/FreeDeepseekAPI</a> · <a href="https://t.me/forgetmeai">Original author's Telegram</a>
</p>
