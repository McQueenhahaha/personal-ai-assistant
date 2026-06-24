# 阶段一规格：质量基线 (Quality Baseline)

**执行者**：Codex　**评审者**：Claude（总工）　**目标周期**：一个 ~5h token 阶段
**总目标**：建立测试 / lint / 安全扫描 / git 规范基线，使后续每个改动都"写得出验收检查"。
**前置阅读**：[ENGINEERING.md](./ENGINEERING.md) 第 2、4、6 节。

## 全局约束

- 不改动任何现有 `src/*.mjs` 的**业务逻辑**；本阶段只**新增**测试/配置文件 + 改 `package.json` 的 scripts/devDeps。
- 不引入重型测试框架（用内置 `node:test`）。ESLint 可作为 devDependency。
- 测试必须用临时目录（`os.tmpdir()` + `fs.mkdtempSync`），**不得**写进仓库内 `data/`，结束后清理。
- 不碰 `.env`、`data/`、`.openclaw/`、凭据。

---

## 任务 1.1 — 测试骨架

**做什么**
- `package.json` 增加 `"test": "node --test"`。
- 新建 `test/` 目录，约定测试文件命名 `test/<module>.test.mjs`。
- 加一个最小冒烟测试 `test/smoke.test.mjs`（断言 `true`）确认 runner 工作。

**验收**
- `npm test` 退出码 0，能发现并运行 `test/` 下的测试。

---

## 任务 1.2 — 覆盖队列状态机 `src/queue.mjs`

这是所有 worker 复用的核心，纯文件系统逻辑，最高优先。为每个导出函数写 ≥1 测试，统一用临时 inbox 目录。

**逐函数验收点**
- `queueDirs(inboxPath)`：返回的 `root/inbox/processing/outbox/done/failed` 路径布局正确。
- `ensureQueue`：递归创建上述 6 个目录。
- `listPendingTasks`：只返回扩展名 ∈ `.json/.txt/.md` 的文件，且按 `mtime` 升序。
- `claimTask`：把文件从 `inbox` 移到 `processing`，原文件不再存在。
- `readTask`：`.json` 解析 `title/priority/source/taskType/prompt` 及缺省回退；`.txt` 走纯文本分支（`taskType="general"`）。
- `writeResult`：任务文件移到 `done/`（或 `status` 指定目录），`outbox/` 生成含 `Task:/ID:/Completed:` 头部的 `.result.txt`。
- `writeFailure`：任务文件移到 `failed/`，`outbox/` 生成 `.error.txt` 含错误栈。
- `createTask`：标题被 sanitize（非 `[a-z0-9_-]` 替换为 `-`、截断 80 字），写出可被 `readTask` 读回的合法 JSON。

**验收**
- `npm test` 全绿；`queue.mjs` 每个导出函数都有断言覆盖。

---

## 任务 1.3 — 覆盖配置助手 `src/env.mjs`

**逐函数验收点**
- `loadEnv`：解析 `KEY=VALUE`，忽略空行与 `#` 注释，正确处理引号包裹的值（用临时 `.env` 文件，不碰真 `.env`）。
- `envList`：按分隔符拆分为数组，空值回退到 `fallback`。
- `envNumber`：非法/缺失值回退到 `fallback`。
- `resolveFromCwd`：相对路径解析为基于 cwd 的绝对路径。
- `timestampForFile`：对固定 `Date` 输入产出确定、文件名安全的字符串。

**验收**
- `npm test` 全绿。

> 1.2/1.3 之外的模块（`rss`/`openai`/`school-check` 等）本阶段**不**强求测试——它们涉及网络/外部导出，放到 P2 解耦后再补。本阶段只确立模式 + 盖住纯逻辑核心。

---

## 任务 1.4 — ESLint flat config

**做什么**
- 新建 `eslint.config.mjs`（flat config，目标 ESM + Node ≥22，`sourceType: module`）。
- 规则保守起步：`no-unused-vars`(warn)、`no-undef`、`eqeqeq`、`no-var` 等；不强加风格大改。
- `package.json` 增加 `"lint": "eslint src test"`，ESLint 进 devDependencies。

**现有违规怎么处理（Codex 修，总工审）**
- 改代码是 Codex 的活，违规由 Codex 修复，**但分类提交以便评审、并按下面排序避免烧额度**：
  - **真 bug**（真未用变量、应为 `===`、`no-undef` 等）→ 现在修，归到 `fix:` commit。
  - **纯风格/格式类**：仅对本阶段已被测试覆盖的 `queue.mjs`/`env.mjs` 可顺手修（有测试兜底）；对**未测试的大模块**（`school-check.mjs`/`openai.mjs`/`rss.mjs` 等）**不要** `eslint --fix` 一把梭——挪到 P2（那时它们正好要拆分+补测试），否则在无测试保护下大面积 reformat 既有回归风险又费 token。
- 交付说明列出：违规总数、按文件分布、本阶段修了哪些、挪到 P2 的清单。

**验收**
- `npm run lint` 可运行；`fix:` commit 的 diff 可逐条追溯到真 bug；大模块无大面积无关 reformat。

---

## 任务 1.5 — Semgrep 安全扫描

**做什么**
- 不进 npm 依赖。新增 `scripts/security-scan.ps1`：调用 `semgrep --config auto src scripts`（优先 `uvx semgrep`，回退已装二进制）。
- 在 [ENGINEERING.md](./ENGINEERING.md) 或本目录补一句运行方式。

**验收**
- 脚本能跑出结果；交付时附**三类化**清单（高危/中/低或误报），不要求清零，但高危需在交付说明逐条解释或修复。

---

## 任务 1.6 — Git 规范落地

**做什么**
- 本阶段所有改动在新分支 `phase-1/quality-baseline` 上完成。
- commit 粒度：一个任务一组 commit；信息清晰（如 `test: cover queue.mjs state machine`）。
- 不要把 `data/`、`.env` 等纳入提交（核对 `.gitignore` 已覆盖）。

**验收**
- 分支历史可读；`git status` 干净（无意外纳入的 runtime 文件）。

---

## 阶段交付清单（Codex 提交时回报）

1. `npm test` 输出（全绿截图/文本）。
2. `npm run lint` 输出 + 现有违规清单。
3. Semgrep 三类化结果。
4. 改动文件列表 + 每个 commit 说明。
5. 任何偏离本规格的地方及原因。
