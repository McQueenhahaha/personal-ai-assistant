# Portability and Safety Audit

Generated during repository preparation for a private GitHub migration.

## Excluded From Git

The repository intentionally excludes:

- `.env` and any local environment variants
- OpenClaw runtime state under `.openclaw/`
- assistant runtime data under `data/`
- OAuth client JSON files and credential-looking config files
- local mail exports and mailbox snapshots
- browser profiles, cookies, and login stores
- logs, JSONL traces, temp/cache files, local databases
- `node_modules/`, Python virtualenvs, and build output
- Windows shortcut and startup backup files

## Sensitive Scan Notes

The current code scan found references to environment variable names and redaction regexes, but did not find a real token, API key, password, personal email address, or student account in the files intended for Git.

The Bilibili fetcher creates temporary request cookies from public API responses at runtime; those are not stored in the repository.

## Windows Absolute Paths Found

These paths are retained for now because the production setup is Windows-first. They should be reviewed before a Mac runtime port.

### Scripts

- `scripts/audit-windows.ps1`: `C:\XboxGames`, `C:\Program Files (x86)\Steam\steamapps\common`
- `scripts/create-desktop-shortcut.ps1`: `D:\AI\Ollama\app.ico`, `C:\Program Files\WindowsApps\...\Codex.exe`
- `scripts/export-gmail-mail.ps1`: `D:\AI\gogcli`
- `scripts/install-ollama.ps1`: `D:\AI\Ollama`, `D:\AI\ollama-models`
- `scripts/openclaw-env.ps1`: `D:\AI\npm-global`, `D:\AI\Ollama`, `D:\AI\ollama-models`, `D:\AI\gogcli`
- `scripts/pull-local-model.ps1`: `D:\AI\ollama-models`, `D:\AI\Ollama\ollama.exe`
- `scripts/register-local-queue-task.ps1`: `D:\AI\personal-ai-assistant\data\queues\local\inbox`
- `scripts/start-ollama-hidden.ps1`: `D:\AI\Ollama\ollama.exe`
- `scripts/stop-assistant-runtime.ps1`: `D:\AI\Ollama\...`, `D:\AI\npm-global\...`

### Skills and Runtime Prompts

- `skills/school-personal-assistant/SKILL.md`: several project-root-relative queue and script examples
- `src/codex-auto-worker.mjs`: prompt text says the default working directory is `D:\AI\personal-ai-assistant`
- `src/openclaw-telegram-bridge.mjs`: remote-maintenance prompt text says the default working directory is `D:\AI\personal-ai-assistant`

### Documentation

- `docs/GMAIL_SETUP_ZH.md`: Windows-specific Gmail/OAuth setup examples using `D:\AI\...`

## Mac Port Notes

A Mac clone can safely inspect and modify the Node.js source, config examples, README, and docs. Running the production assistant on Mac requires replacing or adapting:

- PowerShell launch scripts
- Outlook Desktop export scripts
- Windows scheduled task registration
- Windows Defender and system-health checks
- game-mode process detection
- D-drive OpenClaw/Ollama/gog path assumptions
