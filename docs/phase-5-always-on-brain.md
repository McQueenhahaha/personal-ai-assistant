# Phase 5 — 常开大脑：让助手真正"活过来"

状态：设计定稿（2026-07-09），等待硬件。总工：Claude；实现：Codex。

## 动机（用户原话："受不了两台电脑数据不统一，想让助手真正活过来"）

三个痛点：① MacBook 上用不了助手；② 代码/文档两台机器不同步；③ 助手经常"死机"
（大脑绑在 Windows 游戏本上——打游戏挂起、关机即死）。

## 目标架构

```
🧠 常开小主机（N100，家里 24/7）＝ 助手本体
   Telegram 入口(桥直连 getUpdates) · Claude 问答(claude CLI 订阅)
   Canvas due 提醒 · RSS/游戏资讯 · Gmail(gog) · 全部状态＝唯一事实源
        │ Tailscale 内网（已有：Windows 已在网 100.86.222.93）
🖥 Windows 游戏本 ＝ 卫星执行器（只干物理上离不开它的活）
   Outlook COM 学校邮件 · 游戏进程检测 · /codex(codex CLI 本机订阅) · Windows 维护
💻 MacBook ＝ 随身端：git 同步 + Telegram 使唤；不跑运行时
☁️ GitHub ＝ 代码/文档同步总线（私库 McQueenhahaha/personal-ai-assistant）
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
| Ollama/qwen3、local 队列 | ❌ 顺势退役 | qwen3 已停用；N100 跑不动也不需要 |

## 跨机通信（P5.3 细化）

大脑↔卫星走 Tailscale 内网。首选方案：**卫星拉模式**——卫星上一个常驻 puller 定时
(30s)从大脑拉取"发给 Windows 的任务"（HTTP GET，大脑起一个仅监听 Tailscale IP 的
极简 HTTP 服务），执行完 POST 结果回大脑，由大脑发 Telegram。备选：SSH/scp 文件队列。
Outlook 快照同理由卫星推给大脑。细节在 P5.3 出规格。

## 分阶段

- **P5.0（已完成 2026-07-09）**：本机 9 提交推 GitHub，代码层统一。
- **P5.1（用户）**：购置 N100 迷你主机（16G RAM / 256G+ SSD，¥500–800），接家里网。
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

- 硬件选 N100 迷你主机而非树莓派：x86 兼容性（claude/codex/gog 官方二进制全支持）、
  16G 内存余量、整机含电源外壳、功耗 ~6-10W。
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
