# Phase 4 — 桥直连 Telegram + Claude 大脑（去掉 OpenClaw 中间层）

状态：设计中（2026-06-25）。总工：Claude；实现：Codex。

## 背景与动机

当前 Telegram 链路：**OpenClaw 网关**持有 Telegram 连接（getUpdates），把消息写进
`.openclaw/state/agents/main/sessions/sessions.json.telegram-messages.json`，**桥**
（`src/openclaw-telegram-bridge.mjs`）轮询该文件、处理斜杠命令。OpenClaw 的本地
`qwen3:8b` 曾作"大脑"答自由文本，但它太弱（把 `/digest` 当提问乱答），已停用
（清空 `channels.telegram.allowFrom`，见记忆/Phase 说明）。

问题：OpenClaw 只剩"Telegram 传输管道"这一个作用，却带来一整套重型网关、弱大脑、
双消费者竞争（OpenClaw agent 与桥都读同一批消息）等复杂度。用户已表态"麻烦可以不用
OpenClaw"。

## 目标架构

让**桥成为唯一的 Telegram 客户端**：
- 桥自己做 `getUpdates` 长轮询（带 offset 持久化）。
- 斜杠命令 → 现有确定性处理器（不变）。
- 自由文本 → **Claude 大脑**回复。
- 菜单 → 桥已用 chat scope 注册（Phase 已完成）。
- **OpenClaw 退出 Telegram 链路**（关闭其 telegram 通道；网关本体是否保留另议）。

## 关键决策

**大脑 = Claude Code headless（`claude -p`），不用 Anthropic API。**
理由：用户是成本敏感的学生、已有 Claude 订阅（正用 Claude Code），headless 复用订阅、
**不产生新计费**，模型强；本机已登录、免新密钥。低频个人用途下，headless 每次略重可接受。
（对齐 todo#2 原话"API 或 Claude Code headless"，选 headless。）

**Telegram 单消费者约束（最大风险点）**：Telegram 的 getUpdates 同一 bot 只能有一个
offset 消费者。桥一旦开始 getUpdates，会和 OpenClaw 的轮询**互相抢 update**。因此
"桥直连"与"关闭 OpenClaw telegram 通道"**必须同时切换**——这步是有风险的原子切换，
放最后、需用户在场实测、可一键回滚。

## 分阶段（切换放最后）

### Slice 1 — Claude 大脑模块（安全、独立、不接线）
新建 `src/brain/claude.mjs`：
- `buildBrainPrompt(question, context)`（纯函数，可单测）：拼系统指令（简体中文、
  简洁、Telegram 友好、个人助手口吻）+ 可选上下文 + 用户问题。
- `askClaude(question, opts)`：spawn `claude -p`（headless，text 输出）取回复；
  超时/失败返回 null（调用方 fail-soft）。Codex 先用 `claude --help` 确认确切参数。
- 单测覆盖 `buildBrainPrompt`；spawn 部分加一个 env 门控的 smoke（默认跳过）。
- **不接入任何运行路径**，对现网零影响。

### Slice 2 — 桥内直连 Telegram 轮询（flag 默认关）
- 新模块 `src/telegram/poller.mjs`：getUpdates 长轮询 + offset 持久化
  （`data/state/telegram-update-offset.json`），产出与现有 `readTelegramMessages`
  同形的消息对象，复用现有 `handleCommand`。
- 自由文本（非斜杠）→ `askClaude` → `send`。
- 全程 `ENABLE_DIRECT_TELEGRAM=false` 门控；为 true 时才走直连，否则维持读文件旧路径。
- 纯逻辑（路由：斜杠 vs 自由文本、offset 推进）单测。

### Slice 3 — 切换 + 去 OpenClaw（需用户在场）
- 关闭 OpenClaw telegram 通道（`openclaw config set channels.telegram.enabled false`
  或停网关），同一时刻把桥切到 `ENABLE_DIRECT_TELEGRAM=true` 并重启桥。
- 实测：命令、自由文本、菜单全通；观察 5–10 分钟。
- 回滚：flag 关回 + 重新启用 OpenClaw telegram 通道 + 重启。
- OpenClaw 网关是否彻底卸载/停用，切换稳定后再定。

## 风险与回滚
- **双消费者抢 update**：切换前两者不能同时跑 getUpdates；Slice 3 原子切换。
- **headless 时延/失败**：`askClaude` fail-soft，失败回一句"大脑暂时不可用，命令仍可用"。
- 每个 slice 独立可回滚；Slice 1/2 flag 默认关，对现网零影响。

## ⚠ 前置发现：本机没有可调用的 `claude` CLI
排查（2026-06-25）：`claude` 不在 PATH，也不在 npm-global/scoop/常见安装位置。用户现用的
很可能是 **Claude Code 桌面应用**，不对外暴露 `claude` 命令。因此 headless 大脑需要先：
1. 安装 Claude Code CLI（`npm i -g @anthropic-ai/claude-code`，装到 D:\AI\npm-global，
   符合"装 D 盘"约定），或其它官方分发；
2. `claude login` 用现有订阅登录（**交互式 OAuth，需用户本人**）。
登录后 `claude -p "<prompt>"` 即可 headless 出文本回复、复用订阅、不新增计费。
Slice 1 的大脑模块把 CLI 路径参数化（`CLAUDE_BRAIN_CMD`，默认 `claude`）、fail-soft，
代码可先就绪，装好+登录后即生效。

## 待用户确认（回来后）
1. 大脑用 Claude Code headless（复用订阅、不新增计费）——确认；并完成 CLI 安装 + `claude login`。
   （备选：Anthropic API + key，按量计费，对学生不划算，不推荐。）
2. Slice 3 切换需你在手机上实测；约个时间。
3. 自由文本是否要带上下文（最近几条/会话记忆），还是先做"无状态单轮问答"起步（推荐先单轮）。
