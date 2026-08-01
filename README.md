# Personal AI Assistant

## English

Personal AI Assistant is a local-first assistant built around Telegram. It can read locally exported school email and Canvas assignments, generate study documents, browse the web, inspect the current screen, and dispatch work across Windows and macOS machines.

This repository contains the orchestration code and safety controls. Secrets, OAuth files, mail snapshots, runtime state, logs, browser profiles, and local queues are excluded from Git.

### How it works

```text
Telegram bridge
      |
      v
Task queue --> capability router --> Windows or macOS worker (Claude/Codex)
      |                                  |
      +<--------- progress/result -------+
      |
      v
Telegram reply

Every request also passes through tiered permission policy (T0-T3).
```

The Telegram bridge receives commands or free text, writes structured tasks to queues, and pushes progress and results back to Telegram. Capability routing selects a worker for files, browser, Canvas, screen, GUI control, Outlook, maintenance, or general coding work. A tiered policy decides whether the task may run directly, must stay sandboxed, needs confirmation, or must be refused.

### Main capabilities

- Telegram commands, free-text questions, progress updates, and result delivery.
- School-mail summaries and deadline reminders from local Outlook exports.
- Canvas course, assignment, due-date, and token-expiry checks.
- Markdown study-document generation through Claude or Codex workers.
- Read-only web browsing and current-screen inspection.
- Capability-based task dispatch across Windows and an optional macOS satellite.
- Bounded Windows maintenance and queue-based coding workflows.

### Security model

- **T0 - read only:** search, inspect, explain, and other read-only requests.
- **T1 - sandboxed:** default scoped work and screen capture, constrained to the assistant's allowed environment.
- **T2 - privileged:** software changes, system settings, paths outside the project, email/form submission, ordering, and GUI input require an explicit Telegram confirmation before execution.
- **T3 - forbidden:** payments, account-security changes, disabling security controls, destructive bulk deletion, and secret exfiltration are refused.
- **Confirmation:** T2 requests receive a short-lived approval ID and run only after the owner sends the matching Telegram approval command.
- **Audit:** decisions and outcomes are appended to a local JSONL audit log.
- **Redaction:** common Telegram, Google, OpenAI, Canvas, bearer-token, password, cookie, and secret patterns are redacted before safe-to-share logging or status output.

These controls reduce risk; they are not a substitute for reviewing prompts, scripts, host permissions, and network exposure in your own environment.

### Quick start

Requirements:

- Node.js 20+; Node.js 22.14+ is recommended to match the current package metadata, and CI uses Node.js 24.
- Claude Code CLI or Codex CLI, installed and authenticated locally.
- A Telegram bot and the chat ID that is allowed to control it.
- Optional integrations such as Canvas, Outlook Desktop, Gmail via `gog`, and a macOS SSH satellite.

```bash
git clone <your-repository-url>
cd personal-ai-assistant
npm ci
cp .env.example .env
# Fill .env with your local values. Never commit it.
npm run verify
```

PowerShell equivalent:

```powershell
Copy-Item .env.example .env
notepad .env
npm run verify
```

Review `.env.example`, enable only the integrations you need, and inspect the scripts before starting any long-running worker. The Windows launchers are under `scripts/`; the Node.js entry points and workers are under `src/`.

### Project status and scope

This project was built for the author's personal environment. It is public to share implementation patterns, architecture, and safety ideas; it is not guaranteed to work out of the box on another machine. Paths, account policies, CLIs, operating-system features, and threat models differ. Review and adapt every security boundary before use.

### License

MIT. See [LICENSE](LICENSE).

---

## 中文

Personal AI Assistant 是一个以 Telegram 为入口、本地优先的个人 AI 助手。它可以读取本地导出的学校邮件和 Canvas 作业，生成学习文档，浏览网页，查看当前屏幕，并在 Windows 与 macOS 机器之间分发任务。

本仓库包含编排代码与安全控制。密钥、OAuth 文件、邮件快照、运行状态、日志、浏览器配置和本地队列均排除在 Git 之外。

### 工作方式

```text
Telegram 桥
    |
    v
任务队列 --> 能力路由 --> Windows 或 macOS worker（Claude/Codex）
    |                            |
    +<--------- 进度/结果 -------+
    |
    v
Telegram 回推

每个请求还会经过 T0-T3 分级权限策略。
```

Telegram 桥接收命令或自由文本，把结构化任务写入队列，再把进度与结果回推到 Telegram。能力路由会为文件、浏览器、Canvas、屏幕、图形界面操控、Outlook、系统维护或通用编码任务选择 worker。分级权限策略决定任务可以直接执行、必须限制在沙箱、需要确认，还是必须拒绝。

### 主要能力

- Telegram 命令、自由文本问答、进度通知和结果回推。
- 从本地 Outlook 导出生成学校邮件摘要与截止日期提醒。
- 检查 Canvas 课程、作业、截止日期和 token 有效期。
- 通过 Claude 或 Codex worker 生成 Markdown 学习文档。
- 只读网页浏览与当前屏幕查看。
- 按能力在 Windows 与可选的 macOS 卫星之间分发任务。
- 有边界的 Windows 维护和基于队列的编码工作流。

### 安全模型

- **T0 - 只读：** 搜索、查看、解释及其他只读请求。
- **T1 - 沙箱：** 默认的有限范围工作和屏幕截图，只能在助手允许的环境内执行。
- **T2 - 特权：** 软件变更、系统设置、项目目录外路径、发送邮件/提交表单、下单和图形界面输入，执行前必须由 Telegram 明确确认。
- **T3 - 禁止：** 付款转账、修改账号安全设置、关闭安全防护、破坏性批量删除和外发密钥，一律拒绝。
- **确认：** T2 请求会生成短时有效的确认 ID，只有所有者发送匹配的 Telegram 批准命令后才会执行。
- **审计：** 权限判断和执行结果会追加到本地 JSONL 审计日志。
- **脱敏：** 在可分享日志或状态输出前，常见 Telegram、Google、OpenAI、Canvas、Bearer token、密码、cookie 和 secret 模式会被替换。

这些控制可以降低风险，但不能替代你对自己环境中的提示词、脚本、主机权限和网络暴露进行审查。

### 快速开始

需要：

- Node.js 20+；建议使用 Node.js 22.14+ 以匹配当前 package 元数据，CI 使用 Node.js 24。
- 已在本机安装并登录的 Claude Code CLI 或 Codex CLI。
- 一个 Telegram bot，以及允许控制它的 chat ID。
- 可选集成：Canvas、Outlook Desktop、通过 `gog` 使用 Gmail，以及通过 SSH 连接的 macOS 卫星。

```bash
git clone <your-repository-url>
cd personal-ai-assistant
npm ci
cp .env.example .env
# 在 .env 中填写本地值，绝不能提交该文件。
npm run verify
```

PowerShell 等价命令：

```powershell
Copy-Item .env.example .env
notepad .env
npm run verify
```

请检查 `.env.example`，只启用自己需要的集成，并在启动任何常驻 worker 前审阅相关脚本。Windows 启动脚本位于 `scripts/`，Node.js 入口和 worker 位于 `src/`。

### 项目状态与适用范围

本项目是为作者个人环境构建的。公开仓库是为了分享实现方法、架构与安全思路，不保证在其他机器上开箱即用。路径、账号策略、CLI、操作系统能力和威胁模型都可能不同；使用前请自行审阅并调整所有安全边界。

### 许可

MIT，详见 [LICENSE](LICENSE)。
