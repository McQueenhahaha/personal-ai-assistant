# Phase 4 — Telegram 自由文本走「队列 + Codex worker」大脑

状态：设计中（2026-06-25）。总工：Claude；实现：Codex。
（取代早前"桥直连 Telegram + Claude headless"草案——那个要拆 OpenClaw、有切换风险；
用户提议复用现成的队列机制，更简单更安全，遂改为本方案。）

## 背景

当前：OpenClaw 当 Telegram 传输管道（qwen3 大脑已停用），桥处理 `/命令`，自由文本
（不带 `/`）目前被**无视、没有回复**。

项目已有一条**完整且验证过的闭环**：`/codex <任务>` → 入 codex 队列
（`data/queues/codex/inbox`）→ `src/codex-auto-worker.mjs` 跑 `codex exec`
→ 结果经 `sendTelegramMessage` 发回 Telegram。

## 决策

**自由文本 = 复用这条队列闭环。** 桥把非命令文本丢进 codex 队列（标 `taskType:
"telegram-chat"`），现有 worker 处理并回复。**不引入 claude CLI、不拆 OpenClaw、
不做危险切换。** 代价：有队列延迟（worker 串行、一次一个），个人低频可接受。

安全：chat 任务在 worker 里用**只回答、禁改动**的 prompt（本机 codex 沙箱只能
`danger-full-access`，无法用只读沙箱，故靠 prompt 兜底）。

## 改动（交 Codex）

1. **删除上一草案的死代码**：`src/brain/claude.mjs`、`test/brain-claude.test.mjs`
   （claude headless 方案已弃用）。
2. **桥 `src/openclaw-telegram-bridge.mjs`**：owner 发来的**非命令、非空**文本，
   入 codex 队列（`createTask`，`taskType:"telegram-chat"`，answer 导向），并回执
   "🤔 收到，正在思考，稍等…"。命令路径不变。
3. **worker `src/codex-auto-worker.mjs`**：
   - `buildPrompt` 按 `taskType==="telegram-chat"` 分支为**只回答 prompt**
     （简体中文简洁回答；**禁止**改文件/系统/配置/装卸软件；需要这些就建议用户改用
     `/codex`）。其它类型走原维护 prompt 不变。导出 `buildPrompt` 以便单测。
   - chat 任务**不发**"已开始/进度"通知，只发最终答案/失败（避免一个问题刷好几条）。
4. **测试**：`buildPrompt` 分支——telegram-chat 含"只回答/不要修改"约束、默认类型含
   原维护措辞。

## 部署
Codex 写完我审 + 自跑 verify，提交后**重启桥**（加载非命令路由）；auto-worker 由
monitor 每次新起进程则自动用新代码，否则一并重启。

## 已知后续（按需）
- chat 任务与 /codex 重活共用一个 inbox、串行；低频够用，将来量大可拆独立 chat 队列。
- 若想换更强/更省的大脑引擎，再议（codex exec 现已够用）。
