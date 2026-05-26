# Personal AI Assistant

A local-first personal assistant for Telegram-based digests, remote Codex tasks, RMIT school-mail summaries, personal Gmail snapshots, selected game news, and Windows maintenance checks.

This repository is intended to be safe to review and clone. Runtime state, mail snapshots, OAuth files, logs, Telegram/OpenClaw state, and local secrets are intentionally excluded from Git.

## Current Capabilities

- Sends Telegram summaries in Simplified Chinese.
- Routes simple queue tasks to a local Ollama model.
- Routes complex `/codex`, `/dev`, and `/update` Telegram commands into a local Codex auto-worker queue.
- Sends Codex task status updates to Telegram while a task is running, including elapsed time and the current safe-to-share step.
- Reads locally exported Outlook Desktop school-mail snapshots for RMIT summaries and deadline reminders.
- Reads personal Gmail snapshots after local OAuth is configured with `gog`.
- Fetches curated game news for Escape from Tarkov, War Thunder, and WARNO.
- Suspends assistant runtime while Escape from Tarkov is running and resumes afterward.
- Runs bounded Windows checks and safe cleanup tasks through explicit scripts.

## Technical Stack

- Windows PowerShell scripts for setup, launchers, mail export, scheduled checks, and runtime control.
- Node.js ESM modules for digest processing, queues, Telegram delivery, RSS/news handling, and Codex auto execution.
- OpenClaw as the Telegram gateway and local assistant interface.
- Ollama with a local chat model for routine summaries.
- `@openai/codex` for local non-interactive Codex queue execution.
- Telegram Bot API for phone notifications and commands.
- Optional `gog` CLI for Gmail OAuth and read-only Gmail export.

## Repository Layout

```text
config/   Example OpenClaw configuration.
docs/     Setup guides, especially Gmail OAuth.
scripts/  Windows setup, launch, queue, mail, cleanup, and task scripts.
skills/   OpenClaw skill instructions for this assistant.
src/      Node.js assistant runtime code.
```

Excluded local-only directories include `.openclaw/`, `data/`, `node_modules/`, browser/mail profiles, logs, OAuth client JSON files, and `.env`.

## Windows Install

Install prerequisites:

```powershell
.\scripts\install-prereqs.ps1
```

Install Node dependencies:

```powershell
npm install
```

Install or configure OpenClaw:

```powershell
.\scripts\install-openclaw.ps1
.\scripts\setup-openclaw-telegram.ps1
.\scripts\set-openclaw-owner.ps1
```

Install Ollama and pull the local model:

```powershell
.\scripts\install-ollama.ps1
.\scripts\pull-local-model.ps1
```

Create a private `.env` from the example:

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill the values locally. Do not commit `.env`.

## Windows Start

Start the assistant normally:

```powershell
.\scripts\start-assistant.ps1
```

Start with administrator privileges when system maintenance tasks need elevation:

```powershell
.\scripts\start-codex-admin.ps1
```

Stop the assistant before gaming or heavy local work:

```powershell
.\scripts\stop-assistant.ps1
```

Useful manual checks:

```powershell
npm run check
.\scripts\run-school-check.ps1 --force-school
.\scripts\run-school-check.ps1 --force-game
.\scripts\run-codex-auto-worker.ps1
```

## Environment Variables

See `.env.example` for the full list of required variable names. Important groups:

- Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- Local model: `LOCAL_AI_PROVIDER`, `OLLAMA_BASE_URL`, `LOCAL_MODEL`
- Queues: `LOCAL_QUEUE_INBOX`, `CODEX_QUEUE_INBOX`, `CODEX_MODE`
- Codex worker: `CODEX_AUTO_*`
- OpenClaw bridge: `ENABLE_OPENCLAW_TELEGRAM_BRIDGE`, `OPENCLAW_TELEGRAM_BRIDGE_POLL_SECONDS`
- School checks: `SCHOOL_*`, `OUTLOOK_SYNC_WAIT_SECONDS`
- Gmail export: `GOG_ACCOUNT`, `GMAIL_EXPORT_*`
- Game news: `GAME_*`, `TARKOV_*`, `WAR_THUNDER_*`, `WARNO_STEAM_RSS`

## Stable Features

- Telegram delivery and Chinese digest formatting.
- Local queue and Codex queue folder layout.
- `/codex` command routing through OpenClaw Telegram cache into the Codex auto worker.
- Codex task progress/result pushback to Telegram.
- Outlook Desktop export path for RMIT mail when third-party school OAuth is blocked.
- Gmail OAuth guide and snapshot export path for personal Gmail.
- Curated game-news sources for Tarkov, War Thunder, and WARNO.
- Game-mode runtime suspension for Escape from Tarkov.
- Safe assistant-data cleanup and basic Windows audit scripts.

## Future Integration Goals

- Make a Mac-friendly runtime profile for clone-and-run development without Windows-specific launchers.
- Split Windows-only scripts from cross-platform Node runtime code.
- Add a Codex workspace handoff mode for remote feature work from phone commands.
- Add Canvas-style project planning/output views for summaries and task history.
- Add richer mailbox automation using official Outlook/Gmail connectors where account policies allow it.
- Improve structured status telemetry for long-running Codex and Windows maintenance tasks.

## Security Notes

Never commit:

- `.env`
- OAuth client JSON files
- Telegram/OpenAI/Gmail tokens
- cookies or browser profiles
- personal or school mail exports
- OpenClaw runtime state
- local queue results
- logs
- local databases
- `node_modules`

The `.gitignore` is intentionally broad. If a new file contains real account, mailbox, browser, or token data, keep it out of Git even if it looks useful for debugging.

## Mac / Codex Handoff Notes

The current production runtime is Windows-first. A Mac clone can inspect and edit the Node.js code, README, docs, and config examples, but the PowerShell scripts, Outlook Desktop export, Windows scheduled tasks, Windows Defender checks, and game-mode process watcher need Mac-specific replacements.

Before running on Mac:

1. Install Node.js and run `npm install`.
2. Create `.env` from `.env.example`.
3. Replace Windows script calls with shell scripts or Node wrappers.
4. Rebuild OpenClaw/Ollama/Gmail paths for the Mac filesystem.
5. Do not copy `data/`, `.openclaw/`, browser profiles, or local OAuth/token stores from Windows.
