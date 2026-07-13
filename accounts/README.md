# Put additional DeepSeek Web auth files here for multi-account failover.

This directory is read automatically when the proxy is started with the
`DEEPSEEK_AUTH_DIR` environment variable pointing at it:

```bash
# Linux / macOS
DEEPSEEK_AUTH_DIR=./accounts NON_INTERACTIVE=1 npm start

# Windows (PowerShell)
$env:DEEPSEEK_AUTH_DIR=".\accounts"; npm start
```

## How it works

- Every `*.json` file in this folder is loaded as a separate DeepSeek Web account.
- The proxy assigns accounts round-robin to new agent/sessions.
- Each account is **sticky** to the session it serves (it does not switch accounts
  mid-conversation).
- If an account receives `401` / `403` / `429`, it goes into cooldown and the next
  request is routed to another healthy account.
- Account status is visible in `GET /health` (no file paths or names are exposed).

## Required file contents (each account)

Generate each file with `npm run auth` (interactive Chrome login) or
`npm run auth:import` (import an existing `deepseek-auth.json` / browser cookie export).
Each file must contain at least:

```json
{
  "token": "<DeepSeek web token>",
  "cookie": "ds_session_id=...; smidV2=...",
  "hif_dliq": "<optional>",
  "hif_leim": "<optional>",
  "wasmUrl": "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm"
}
```

## Security

- Store these files with `0600` permissions (the importer does this automatically):
  ```bash
  chmod 600 accounts/*.json
  ```
- These files are your DeepSeek Web login — do NOT commit them. This folder is
  already in `.gitignore` for the auth JSON files; the `.gitkeep` and this README
  are the only tracked files.

## Example

```bash
mkdir -p accounts
cp deepseek-auth-main.json accounts/main.json
cp deepseek-auth-backup.json accounts/backup.json
chmod 600 accounts/*.json
DEEPSEEK_AUTH_DIR=./accounts NON_INTERACTIVE=1 npm start
```
