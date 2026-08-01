# Phase 5 — 常开大脑：让助手真正"活过来"

状态：设计定稿（2026-07-09），等待硬件。总工：Claude；实现：Codex。

## 动机（用户原话："受不了两台电脑数据不统一，想让助手真正活过来"）

三个痛点：① macOS 笔记本上用不了助手；② 代码/文档两台机器不同步；③ 助手经常"死机"
（大脑绑在 Windows 游戏本上——打游戏挂起、关机即死）。

## 目标架构

```
🧠 常开低功耗主机（24/7）＝ 助手本体
   Telegram 入口(桥直连 getUpdates) · Claude 问答(claude CLI 订阅)
   Canvas due 提醒 · RSS/游戏资讯 · Gmail(gog) · 全部状态＝唯一事实源
        │ Tailscale 内网（节点地址仅保存在各机本地配置中）
🖥 Windows 电脑 ＝ 卫星执行器（只干物理上离不开它的活）
   Outlook COM 学校邮件 · 游戏进程检测 · /codex(codex CLI 本机订阅) · Windows 维护
💻 macOS 笔记本 ＝ 随身端：git 同步 + Telegram 使唤；不跑运行时
☁️ GitHub ＝ 代码/文档同步总线（仓库 `personal-ai-assistant`）
```

原则：**状态只有一份**（在大脑）；**队列单点消费**不变（每条队列只有一个消费者，
只是消费者分布在两台机器）；Mac 永不跑运行时。

## 组件归属

| 组件 | 去向 | 理由 |
|---|---|---|
| Telegram 桥 + 菜单 + 自由文本 Claude | 🧠 大脑 | 纯网络；这就是"永远在线"的主体 |
| Canvas 提醒 / RSS 游戏资讯 / digest | 🧠 大脑 | 纯网络 |
| Gmail 导出(gog) | 🧠 大脑 | 纯网络（gog Linux 版 + 重新授权） |
| 状态(data/state)、队列文件 | 🧠 大脑 | 唯一事实源 |
| OpenClaw 网关 | ❌ 退役 | 大脑上桥直连 Telegram getUpdates；早前否决直连是怕
切换风险，迁移本身就是切换，正好一步到位 |
| Outlook 学校邮件导出 | 🖥 卫星 | COM 只能在装 Outlook 的 Windows |
| 游戏模式检测/挂起 | 🖥 卫星 | 检测本机进程；今后只挂起卫星自己的活，**大脑不再死** |
| /codex 执行 | 🖥 卫星 | codex CLI 登录在 Windows；改的也是这台机器 |
| Windows 维护(/maint 等) | 🖥 卫星 | 本机操作 |
| Ollama/qwen3、local 队列 | ❌ 顺势退役 | qwen3 已停用；低功耗主机跑不动也不需要 |

## 跨机通信（P5.3 细化）

大脑↔卫星走 Tailscale 内网。首选方案：**卫星拉模式**——卫星上一个常驻 puller 定时
(30s)从大脑拉取"发给 Windows 的任务"（HTTP GET，大脑起一个仅监听 Tailscale IP 的
极简 HTTP 服务），执行完 POST 结果回大脑，由大脑发 Telegram。备选：SSH/scp 文件队列。
Outlook 快照同理由卫星推给大脑。细节在 P5.3 出规格。

## 分阶段

- **P5.0（已完成 2026-07-09）**：本机 9 提交推 GitHub，代码层统一。
- **P5.1（用户）**：准备一台兼容所需 CLI 的低功耗常开主机并接入网络。
- **P5.2**：小主机装 Debian + Tailscale + Node20 + git + claude CLI(登录订阅) + gog；
  clone 仓库；迁移：桥改直连 getUpdates(废弃消息文件轮询)、Canvas/RSS/digest 定时任务
  (cron)、状态文件迁移；Windows 停对应服务。验收：Windows 关机状态下，Telegram
  菜单/问答/提醒全部正常。
- **P5.3**：卫星对接——puller + Outlook 快照上传 + /codex 远程派发 + 维护命令转发；
  游戏挂起只影响卫星活。
- **P5.4**：Mac 端 clone + 环境；可选 SSH 快捷方式。

## 风险与对策

- claude/codex 订阅在新机器登录：各需一次交互登录（用户操作，一次性）。
- Telegram 单消费者：切换时刻大脑桥启用、Windows 桥+OpenClaw 停——原子切换，
  回滚 = 反向开关（与 phase-4 直连草案同一风险，已有预案）。
- PowerShell 脚本不可移植：大脑侧全部用 Node/cron 重写等价物；Windows 专属脚本留卫星。
- .env 拆分：大脑与卫星各持所需密钥子集，互不冗余。

## 决策记录

- 硬件选通用 x86 低功耗主机：兼容 claude/codex/gog 官方二进制，并留有足够内存余量。
- Mac 定位"随身端"而非第二运行时：避免双消费者与状态分叉——这正是本次痛点的反面教材。

## P5.5 — 游走升级：大脑是角色，不是机器（2026-07-22 用户愿景定稿）

用户原话："不想让助手拘泥于任何一个设备，要一个能在设备间游走的智能体。"
工程翻译：**灵魂与身体分离**。

- **灵魂包** = 代码+文档(已在 GitHub) + 运行状态(队列/会话/提醒记录/租约)。
  状态从"本机 data/ 文件"升级为可同步状态包（首选：私有 git 状态仓，定时+变更时
  push；冲突极少因为同时只有一个大脑在写）。
- **brain-lease 租约** = 灵魂包里的"大脑执照"文件（holder、心跳时间戳、TTL）。
  身体启动时检查：执照过期/空闲 → 抢租约成为大脑（跑桥+定时任务）；被持有 → 只当
  卫星/客户端。心跳定时续约。**杜绝双大脑抢 Telegram（脑裂）**。
- **一键附身** = `npm run become-brain`：拉最新灵魂包 → 抢租约 → 起服务。
  任何装好环境的设备（派/Windows/Mac/未来 VPS）皆可。
- 默认身体仍是树莓派（24/7 最稳）；Windows 是"能力最强的身体"（Outlook/游戏/codex
  仍只有它能干——这些是身体特有技能，注册为 capability，大脑派活时按 capability 路由）。
- 顺序：P5.2 派上线（第一具常开身体）→ P5.5 状态包+租约+become-brain（Codex 分片实现）。

### P5.5 修订（2026-07-23）：Mac 定位升级为"技能卫星"

用户实测 **Mac 上 Codex 的电脑控制(computer-use)明显更强**——这是 Mac 独有 capability。
修订：Mac 不再只是"随身查看端"，而是与 Windows 同模式的**卫星身体**：
- capability: `codex-computer-use`（浏览器/桌面自动化类任务）、mac 自动化
- 大脑按任务所需 capability 路由到在线且具备该能力的身体（Windows=Outlook/游戏/维护，
  Mac=电脑控制，派=常开兜底与纯网络活）
- Mac 仍默认不当大脑（可 become-brain 应急接管）；卫星 agent 与 P5.3 同一套 puller 协议。

---

# P5.5 详细设计（2026-08-01 定稿）— 让助手"一直活着"

## 用户原话（这是需求的本质）
"我一台电脑关闭了，AI 助手还能运行吗？我在一台电脑游戏的时候，我需要他在另一台电脑
继续工作，**这才是这个项目的意义**。"
"我不管这个 ai 到底在哪个电脑搞，我只要任务完成。"

## 现状（诚实评估）
- 大脑只在 Windows：Windows 关机 = 助手死亡
- 游戏模式检测到游戏 → **挂起整个助手**（与用户要的"迁移"完全相反）
- Mac 只是卫星：能接活，但不收 Telegram、不会自主思考

## 目标
**同一时刻恰有一个"大脑"**，但它能在机器间迁移。用户视角始终是一个助手、
一个 Telegram、一段连续记忆，**永远不需要知道大脑在哪台机器上**。

## 核心机制：大脑租约（brain lease）

### 为什么需要租约
Telegram getUpdates 是单消费者：两个大脑同时跑 = 抢消息 + 双重回复（脑裂）。
必须有且只有一个持有者。

### 租约数据（`data/state/brain-lease.json`，两机各存一份并互相同步）
```json
{ "holder": "windows|mac", "heartbeatAt": "ISO", "ttlSeconds": 90, "reason": "startup|handover|takeover" }
```

### 状态机（每个节点上的 brain-supervisor 每 30 秒跑一次）
1. 读本地租约 + 尝试从对端拉取租约（Tailscale 可达时）
2. **我是持有者** → 续约（更新 heartbeatAt）+ 确保大脑服务在跑 + 推状态给对端
3. **对端是持有者且租约新鲜**（heartbeat 在 TTL 内）→ 我当卫星，确保大脑服务已停
4. **对端是持有者但租约过期** → 探测对端是否可达：
   - 可达但没续约 → 说明对端大脑挂了 → **接管**
   - 不可达（关机/睡眠）→ **连续 N 次（默认 3 次 = 90 秒）都不可达才接管**
     （防抖，避免网络抖动造成脑裂）
5. **无人持有** → 抢占（先写先得；两边同时抢时，用节点优先级 windows > mac 打破平局）

### 主动交接（游戏模式的正确行为）
Windows 检测到游戏启动 → **不再挂起助手**，而是：
1. 等待在飞任务结束（沿用现有"等任务跑完再停"逻辑）
2. 推送最新状态到 Mac
3. 写租约 `{holder: "mac", reason: "handover"}` 并推给 Mac
4. 停止本机大脑服务（桥 + worker + 定时任务）
5. Mac 的 supervisor 下一轮发现自己成了持有者 → 启动大脑

游戏结束 → 反向交接（Windows 请求收回；Mac 让出）。
**用户可见效果**：打游戏时助手照常在 Telegram 回你，只是在 Mac 上跑。

## 灵魂包（共享状态）

### 必须同步的状态（否则会重复处理/丢记忆）
| 文件 | 为什么关键 |
|---|---|
| `openclaw-telegram-bridge-state.json` | 已读消息 key，不同步会重复回复 |
| `telegram-chat-session.json` | 多轮对话会话 id，不同步会失忆 |
| `pending-approvals.json` | 待确认任务 |
| `canvas-reminders-sent.json` | 提醒去重 |
| `school-check-state.json` | 学校检查去重 |
| `data/queues/**` | 任务队列（含未完成任务） |

### 同步策略
- **只有租约持有者写状态**（天然无并发冲突）
- 持有者每次续约时把状态推给对端（rsync over Tailscale/SSH，增量）
- 交接前强制推一次（保证接管方拿到最新）
- 接管方启动大脑前先从本地已同步的副本读取

### 不同步的
`.env`（各机一份，内容可不同）、日志、浏览器 profile（Windows 专属）、
`data/browser-profile`（太大且机器相关）

## Mac 成为完整大脑的前提
| 需要 | 现状 |
|---|---|
| 代码 | ❌ 需部署（**用 Tailscale 上的 git over SSH 从 Windows 拉，避免 Mac 做 GitHub 认证**） |
| Node/claude | ✅ 已装且已登录 |
| `.env`（TG token/Canvas token 等） | ❌ 需安全拷贝（scp，权限 600） |
| Telegram 桥能跑 | ⚠️ 现在桥依赖 OpenClaw 网关写的消息文件 —— **Mac 上没有 OpenClaw** |

### ⚠️ 关键阻塞点：桥的消息来源
当前桥**轮询 OpenClaw 写出的消息文件**，而 OpenClaw 只在 Windows。
Mac 当大脑就收不到消息。
**解法（必做）**：把桥改成**直接 Telegram getUpdates**（phase-4 早前设计过、当时因
"切换有风险"推迟）。现在必须做了 —— 这也顺带让 OpenClaw 彻底退休。
getUpdates 的单消费者约束正好由 brain-lease 保证。

## 实施切片
- **S1 桥直连 Telegram**（前置，最高风险）：桥自己 getUpdates + offset 持久化；
  OpenClaw 退出 Telegram 链路。切换需用户在场（可回滚）。
- **S2 租约核心**：brain-lease.json + supervisor 状态机（纯函数可测）+ 本机
  大脑服务启停。先只在 Windows 跑（单节点也应正常工作）。
- **S3 状态同步**：rsync/scp 推拉 + 交接前强制同步。
- **S4 Mac 成为大脑**：部署代码/.env/LaunchAgent supervisor；实测 Windows 关机后
  Mac 接管。
- **S5 游戏模式改造**：从"挂起"改为"交接给 Mac"；游戏结束后收回。

每片独立可用、可回滚。S1 之前助手行为不变。

## ⚠️ S3 补充：对话记忆必须自己管（2026-08-01 用户提出，设计漏洞修正）

### 用户的问题
"如果在聊天过程中，AI 切换到了另一个电脑，会丢失记忆吗？"

### 查证结果：会丢
| 内容 | 位置 | 换机器后 |
|---|---|---|
| 会话 ID（指针） | `data/state/telegram-chat-session.json` | 可同步 ✅ |
| **对话内容本身** | `~/.claude/projects/<按本机工作目录哈希的目录>/<sessionId>.jsonl`（本机 101MB） | **找不到** ❌ |

现有多轮记忆靠 `claude --session-id/--resume`，内容由 Claude CLI 存在**本机**、
目录名按**本机路径**哈希。接管方拿到 sessionId 却 resume 不到 → **静默失忆**
（助手不会报错，只是突然听不懂上文，比报错更糟）。

原同步清单只列了 `telegram-chat-session.json`，**只同步了指针没同步内容**——设计漏洞。

### 修法：自管对话历史（S3 必做项）
不再依赖 CLI 的 `--resume`，改为**我们自己保存最近 N 轮对话**，每次调用作为上下文传入。
- 新状态文件 `data/state/chat-history.json`：
  `{ turns: [{ role:"user"|"assistant", text, atMs }], updatedAt }`
- 上限：最近 **12 轮** 或 **6000 字符**（先到先裁），超出从最旧丢弃
- 闲置超时（沿用 `CHAT_SESSION_IDLE_MINUTES`，默认 30 分钟）→ 清空历史，开新话题
- 调用时把历史渲染成紧凑上下文块拼进 prompt；**不再传 `--session-id/--resume`**
- 该文件进灵魂包同步清单（跟着大脑走）

### 收益（不止解决同步）
- 记忆与执行引擎解耦：将来换 Claude/Codex/别的模型都不受影响
- 可审计：能直接看到助手"记得什么"
- 无隐藏状态：不依赖任何 CLI 的内部存储格式

代价：每次多传少量上下文 token —— 对个人助手可忽略。
