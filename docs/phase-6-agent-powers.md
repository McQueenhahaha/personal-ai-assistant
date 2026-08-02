# Phase 6 — 给助手真正的手脚（工具 / 浏览器 / 电脑控制）

状态：规格定稿 2026-07-31。总工：Claude；实现：Codex。
依据：4 路并行实测调研（workflow wf_c5d36fc8-745），结论均为本机实证而非推断。

## 用户诉求（原话与实际场景）

"ai智能助手没有办法使用 computer use 或者 chrome 插件…而且它没有足够的权限"

从队列历史看到的真实卡点：
- "帮我看下 **Canvas** 上 system engineering 的 group assessment 要干嘛" → 需带登录态的浏览器
- "通过 **B站** 学习更新我断箭的地图理解" → 需上网读内容
- "你在**本地**找下这个的相关内容" → 需文件读取/搜索
- "**你别用 md 文件我看不了**" → /study 的输出 UX 失误（手机看不了 .md）

## 诊断（根因在我，非能力缺失）

`src/brain/claude.mjs` 里写死了：
`--append-system-prompt "仅用你已有的知识简洁回答用户；不要使用任何工具、不要读写文件或运行命令"`
—— 这是当初为"远程无人值守安全"加的嘴套。助手不是没权限，是被我禁用了。

## 实测结论（调研证据）

1. **裸 `claude -p` 不会卡住也不报错，而是静默拒绝需审批的工具**（exit 0, is_error=false）
   → 必须显式给权限参数，否则表现为"装作干了但什么也没做"，最坑。
2. **会话隔离不是问题**：worker loop / bridge / ollama 全部 `SessionId=1`（用户交互会话），
   可截屏、可注入输入 → **computer use 在本机技术上可行**，无需改成服务。
3. **Playwright MCP 端到端跑通**：`npx -y @playwright/mcp@0.0.78 --browser chrome
   --executable-path <chrome>` 配合 `claude -p --mcp-config`，headless Claude 真的打开了浏览器，
   **不需要 `playwright install`**（复用系统 Chrome）。
4. **Chrome 136+ 安全限制**：`--remote-debugging-port` 对**默认用户资料**已被禁止
   → 无法附身用户正在用的 Chrome。**必须用专属资料目录**。
5. Claude 本身具备视觉，截图交给它即可 → **本地视觉模型 qwen3-vl 非必需**（见"不做清单"）。

## 权限模型（四档，确定性分类，不由模型自觉）

原则：**权限由执行器参数决定，prompt 只解释规则，拦截落在工具层。**

| 档 | 能力 | 执行器参数 | 确认 |
|---|---|---|---|
| **T0 只读** | 查状态/读文件/搜索/回答 | claude 只读工具集 | 否 |
| **T1 沙箱写**（默认） | 改本项目代码/文档、跑测试、整理 data/ | `--add-dir <项目根>` + 危险工具 disallow | 否 |
| **T2 特权** | 装卸软件、改计划任务/注册表、动项目外目录、**任何 computer-use 点击**、发邮件/提交表单 | 挂起 → Telegram 确认 → 一次性授权 | **是** |
| **T3 禁止** | 付款转账、改账号密码/2FA、关 Defender/防火墙、递归删用户数据、外发 .env/token、改护栏自身 | 工具层直接拒，**无确认路径** | 永不 |

## 分阶段实施

### A1 — 松绑 + 分级（Codex，最高优先级，收益最大）
- `src/security/policy.mjs`（新，纯函数可测）：任务文本 → 档位判定 + 危险动作黑名单匹配
- `src/brain/claude.mjs`：`runClaudeText/runClaudeChat` 增加 `capability` 选项
  （`answer-only` 保留给纯闲聊；`assist` = T1：开工具、`--add-dir` 项目根、disallow 危险工具）
- worker：`telegram-chat` 走 `assist`；命中 T2/T3 的走挂起或拒绝
- 验收：TG 问"帮我在本地找 XX 文件"能真的找到并回答

### A2 — 浏览器（Codex）
- `@playwright/mcp` 经 `--mcp-config` 挂载，`--browser chrome --executable-path`
- **专属 Chrome 资料目录** `data/browser-profile/`（隔离主浏览器；用户在其中登录一次
  Canvas/B站，凭据长期有效）
- 新命令 `/web <任务>`（或让 assist 档自动可用）
- 验收：TG 发"看下 Canvas 上 XX 作业要求"能真的读回内容

### A3 — 确认流 + 审计 + 刹车（Codex）
- T2 任务挂起，Telegram 发确认卡片，用户回 `/ok <id>` 才执行（带超时自动作废）
- 每次远程操控写审计日志；`/stop` 一条命令停掉一切
- 凭据防泄漏：复用 `redactSensitive`，扩展到 Claude 输出路径

### A4 — computer use（最后做，最脆弱）
- 截图（已验证可行）+ 鼠标键盘注入，包成最小工具供 Claude 调用
- 全部归 T2（每次点击都要确认）——GUI 自动化误操作代价最高

### 顺手修（并入 A1）
- `/study` 与长回复：**默认发文字**（分段），`.md` 文件作为附加而非唯一形式

## 不做清单（调研后否决）

- **本地视觉模型 qwen3-vl:8b**：Claude 自带视觉且更强，不进架构。
  ~~6.1GB 已下载先留着不删。~~ **2026-08-02 已 `ollama rm` 删除**（零代码引用，释放 6.1GB）。
  仍保留 `qwen3:8b`——`/digest` 的 AI 摘要与 `/local` 依赖 `src/local-ai.mjs`，删了会静默降级。
- **附身用户默认 Chrome 资料**：Chrome 136+ 安全限制，且风险高（银行/私人标签页）。
- **把 worker 改成 Windows 服务**：会失去桌面会话，反而做不了 computer use。

## 仍待现场验证

- `claude -p` 给权限的确切 flag 组合（`--permission-mode` vs `--dangerously-skip-permissions`
  vs `--settings`）在**非交互 spawn** 下的真实行为——A1 实施时必须实测，
  不能只看 --help。
- Playwright MCP 在 worker 的非交互进程里能否稳定存活（研究时是手工启动验证的）。
