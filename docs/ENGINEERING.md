# 工程框架与升级路线（总工程师文档）

本文件是 `personal-ai-assistant` 的工程"宪法"：定义项目北极星、协作分工、阶段节奏、评审门槛与升级路线。
分工模型：**Claude（总工）负责架构 / 阶段规格 / 代码评审，Codex 负责按规格写代码与跑验证。**

---

## 1. 北极星 (North Star)

本地优先的个人助手：以 Telegram 为手机端入口，推送简体中文摘要；简单任务走本地 Ollama，
复杂任务走本地 Codex 自动队列并回推进度；聚合学校邮件 / 个人 Gmail / 游戏新闻；
做有界的 Windows 维护。**Windows 是主运行时，Mac 仅作开发/控制克隆，同一时间只有一台消费队列。**

## 2. 工程原则（对评审直接生效）

1. **GitHub-first**：接到需求先搜成熟可靠的现成方案，能复用就复用，没有才自己写。
2. **安全用成熟工具**：Semgrep / SonarQube / Bandit / ESLint，不手写安全检查逻辑。
3. **Token 经济**：不重复读文件、批量命令、回复精简、`rg` 代替 `find | grep`。
4. **Karpathy 准则**：想清楚再写 / 最简实现 / 外科手术式改动 / 目标驱动（写得出验收检查）。
5. **状态安全**：`.env`、tokens、`.openclaw/`、`data/` 永不进 Git；队列消费单点，防重复消费。

## 3. 协作流程（按风险分流）

不是每个改动都值得走完整的 spec→Codex→审查仪式——按改动的**风险/体量**选车道，避免大马拉小车：

| 车道 | 适用 | 谁实现 | 流程 |
|---|---|---|---|
| **A 直接** | 琐碎/机械/配置（lint 规则、单行修正、常量/路径、文档、改个脚本参数） | 总工直接做 | 改 → 自验 → 提交 |
| **B 标准** | 一般功能/测试/可控重构（有面积但风险可控） | Codex | 规格 → Codex → 总工审 diff + 自跑验证 → 提交 |
| **C 加固** | 大改/高风险/安全敏感（拆巨型模块、动队列/凭据/路径、安全相关） | Codex + 强审 | 规格(含特征化测试要求) → Codex → 总工对抗式审查(自跑测试 + 独立核查 + 必要时二次验证) → 提交 |

- **角色不焊死**：某段硬实现若总工更拿手，可反转为「总工写、Codex 做对抗式复核」。谁强谁干硬活，另一个做独立复核。
- **阶段单位**：一次约 5 小时 token 额度 = 一个阶段；阶段内再切成 slice，逐刀放行。
- **每阶段交付物**：`docs/phase-N-*.md`（规格）+ 对应分支的实现 + 全绿的 `npm test` / `npm run lint`。

**四条铁律（三车道都适用）**
1. **审查者绝不轻信自述**：凡报"通过"，总工必亲自跑 `npm test`/`npm run lint` 且读 diff 验真。
2. **切片 + checkpoint**：逐刀放行，每刀是干净 checkpoint，绝不半途留坏状态。
3. **额度纪律**：撞限流/低额度即停在刀边界，报进度 + 排恢复提醒；不精确卡 % 但保守。
4. **无测试不重构**：改既有逻辑前先有测试（或本刀先补特征化测试）兜底。

**Codex 不得**：改 `.env`/凭据/`data/`/`.openclaw/`；删既有 dead code（除非规格明确授权）；做规格外"顺手优化"；执行 `git commit`（提交统一由总工把关）。

**运行约定**：驱动 Codex 用 `codex exec -s danger-full-access`（这台 Windows 上 `workspace-write` 沙箱失效，报 `spawn setup refresh`）；护栏靠 prompt 硬约束 + 事后 `git diff`。

## 4. 评审门槛 (Definition of Done)

合并前每条都要满足：

- [ ] 改动的每一行都能追溯到当前阶段规格的某条任务。
- [ ] 新增/改动逻辑有对应测试；`npm test` 全绿。
- [ ] `npm run lint` 无新增告警。
- [ ] 安全扫描（Semgrep）无新增高危；新依赖经过 GitHub-first 评估。
- [ ] 无新增 Windows 绝对路径硬编码（除非该文件本就是 Windows 专属脚本）。
- [ ] commit 粒度合理、信息清晰；一个逻辑改动一个 commit。

## 5. 升级路线（依赖排序）

| 阶段 | 主题 | 目标 | 前置 |
|---|---|---|---|
| **P1** | 质量基线 | 测试框架 + 核心模块测试 + ESLint + Semgrep + git 规范。让"Codex 写、总工审"有可验收的抓手 | — |
| **P2** | 解耦与平台抽象 | 拆分 `school-check`/`openai` 巨型模块；抽出 path/config/platform 适配层，Windows 脚本与跨平台 Node 运行时解耦 | P1 测试保护重构 |
| **P3** | 可观测性 | 结构化日志 + 长任务（Codex/Windows 维护）状态遥测，对应 README future goal | P1 |
| **P4** | 功能扩展 | 官方 Outlook/Gmail 连接器、Canvas 式项目/任务视图、Codex workspace 远程交接 | P2/P3 |
| **P5** | Mac 运行时 | clone-and-run 的 Mac profile，替换 PowerShell/Outlook/调度/游戏监视 | P2 平台拆分 |

路线随每阶段评审结论调整；P1 必须先行，因为没有测试基线后续重构与功能都缺乏验收手段。

## 6. 技术选型决定（P1）

- **测试**：Node 内置 `node:test` + `node --test`。Node 已要求 `>=22.14`，**零新增运行时依赖**，契合项目刻意的单依赖设计。
- **Lint**：ESLint flat config，作为 devDependency。
- **安全**：Semgrep 经 CLI 运行（`uvx semgrep` / 独立二进制），**不进 npm 依赖树**。
- **不引入** vitest/jest 等重型框架，除非内置 `node:test` 被证明不够用。
