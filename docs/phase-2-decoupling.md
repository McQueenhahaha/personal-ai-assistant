# 阶段二规格：解耦与平台抽象 (Decoupling & Platform Abstraction)

**执行者**：Codex　**评审者**：Claude（总工）
**总目标**：抽出可配置的项目根/路径层、拆分巨型模块，为 P3（可观测性）与 P5（Mac 运行时）铺路。
**铁律**：全程保持 `npm test` 全绿、`npm run lint` 0 error；每一步改动都要可被测试或 diff 验证。
**前置阅读**：[ENGINEERING.md](./ENGINEERING.md)、[PORTABILITY_AUDIT.md](./PORTABILITY_AUDIT.md)。

## 切片总览（按风险从低到高，逐刀放行）

| 刀 | 内容 | 风险 | 依赖 |
|---|---|---|---|
| **S1** | 项目根可配置化 + 清死代码 | 低（机械） | — |
| **S2** | `school-check.mjs`(864行) 特征化测试 → 按职责拆分 | 中高 | S1 |
| **S3** | `openai.mjs`(641行) 特征化测试 → 按职责拆分 | 中高 | S1 |

> S2/S3 的原则：**先补特征化测试（characterization test）锁住当前行为，再拆**。无测试不重构。

---

## 切片 S1（本刀执行）

### 任务 S1.A — 项目根可配置化

**背景**：`PORTABILITY_AUDIT.md` 指出 `src/codex-auto-worker.mjs` 与 `src/openclaw-telegram-bridge.mjs` 的 prompt 文本里硬编码了默认工作目录 `D:\AI\personal-ai-assistant`，阻碍跨平台。

**做什么**
- 在 `src/env.mjs` 新增 `projectRoot()`：返回 `process.env.PROJECT_ROOT`（若设置且非空）否则 `process.cwd()`，统一经 `path.resolve` 规整。
- 把上述两个文件 prompt 里硬编码的 `D:\AI\personal-ai-assistant` 默认工作目录，改为动态注入 `projectRoot()` 的值。
- 全仓 `src/` 再 grep 一遍 `personal-ai-assistant` 字面量，若 src 内还有运行时硬编码路径一并改（仅限 Node 运行时代码；`.ps1`/docs/skills 本刀不动）。

**验收**
- 新增 `test/env.test.mjs` 用例覆盖 `projectRoot()`：设了 `PROJECT_ROOT` 用之、未设回退 `process.cwd()`（用 restore 还原 env，勿污染）。
- `src/` 内不再有 `D:\AI\personal-ai-assistant` 字面量（除注释/示例外）。
- 改动后 prompt 仍语义正确（默认工作目录 = 运行时实际根）。

### 任务 S1.B — 清除已确认死代码

**背景**：P1 lint 报出 `src/openai.mjs` 4 处 `no-unused-vars`，经全仓引用核查为真死代码（仅 `buildDigest` 为导出，其余未被调用）。

**做什么**
- 删除 `src/openai.mjs` 中确认未使用的：`fallbackDigest`、`chinesePersonalHighlights`、`outlookSnapshotHighlights`，以及未使用的局部 `subject`（行号以当前 lint 报告为准，删前再确认 0 外部引用、非导出）。
- 只删这 4 个孤儿，**不顺手重构** `openai.mjs` 其它部分（拆分留 S3）。

**验收**
- `npm run lint` → **0 error / 0 warning**。
- `npm test` 仍全绿（这两个模块本无测试，删死代码不应影响现有测试）。

### S1 硬约束
- 只动 `src/env.mjs`、`src/codex-auto-worker.mjs`、`src/openclaw-telegram-bridge.mjs`、`src/openai.mjs`、`test/env.test.mjs`。
- 不改 queue/其它模块行为；不装依赖；不执行 git commit；不碰 `.env`/`data/`/`.openclaw/`。
- 删死代码只删 lint 确认且引用为 0 的那几个，不扩大。

### S1 交付报告（中文）
改了哪些文件、`projectRoot()` 实现与接入点、删了哪些死代码、`npm test` 与 `npm run lint` 结果。
