# S2 school-check.mjs 特征化测试与拆分方案

本文基于当前 `src/school-check.mjs` 静态阅读产出。当前文件共 864 行，是可直接执行的入口脚本：`node src/school-check.mjs`。

## 1. 模块职责概述

`school-check.mjs` 目前同时承担 CLI 入口、环境配置读取、定时槽判断、Outlook/Gmail 导出调用、邮件 drop 解析、学校/个人邮件分类与摘要格式化、游戏资讯抓取与摘要格式化、学校 deadline 抽取与临期提醒、Telegram/控制台发送、状态文件维护、运行摘要日志落盘、顶层失败通知。

入口流程如下：

1. `main()` 先 `loadEnv()`，读取 CLI flags、环境变量默认值、当前时间、时区、定时检查时间、导出参数、提醒窗口等配置。
2. 从 `./data/state/school-check-state.json` 读取状态，补齐 `slots`、`seen*Keys`、`remindedDeadlineKeys`、`schoolCatchup`、`gameCatchup`。
3. 用 `dueSlots()` 判断当前是否落入配置的学校检查时间窗口，并清理过期的 school/game catchup。
4. 若强制学校检查、定时槽到期或 school catchup 活跃，则按需调用 Outlook PowerShell 导出，再从 school mail drop 读取并去重消息。
5. 若强制个人邮件检查或定时槽到期，则按需调用 Gmail PowerShell 导出；Gmail 导出失败只记 warning 和 `personalExportError`，不让主流程失败；之后读取 personal mail drop，过滤已见和低优先级邮件，并按需发送个人摘要。
6. 对学校消息过滤已见，按需发送学校摘要；更新 seen keys、slot 完成记录，并维护 school catchup。
7. 若强制游戏检查、定时槽到期或 game catchup 活跃，则调用 `fetchGameNews()`，过滤已见游戏资讯，按需发送游戏摘要，并维护 game catchup。
8. 从学校消息中抽取 deadline，若距离截止时间在提醒窗口内且未提醒过，则最多发送 5 条临期提醒。
9. 如果是定时槽触发且本轮没有任何 Telegram 消息，按配置发送“定时检查完成”的空摘要。
10. 非 `--dry-run` 时保存状态；无论 dry-run 与否，都会写 `./data/logs/school-check-<timestamp>.json` 运行摘要并 `console.log`。
11. 顶层 `main().catch()` 打印错误，尝试重新 `loadEnv()` 并发送 Telegram 失败通知，最后设置 `process.exitCode = 1`。

因此拆分目标不是改变业务行为，而是先把可测纯逻辑锁住，再把外部依赖和编排层隔离出去。入口最终应只保留“加载环境、调用 workflow、统一 fatal error 处理”的薄层。

## 2. 函数/常量清单

| 名称 | 行号范围 | 一句话作用 | 分类 |
|---|---:|---|---|
| `DEFAULT_TIME_ZONE` | 9 | 默认学校检查时区，当前为 `Australia/Melbourne`。 | 纯逻辑 |
| `MONTHS` | 10-35 | 英文月份全称/缩写到月份数字的映射。 | 纯逻辑 |
| `hasArg(name)` | 37-39 | 判断当前 CLI 参数中是否包含某个 flag。 | 外部依赖(process.argv) |
| `statePath()` | 41-43 | 返回 school-check 状态文件路径。 | 外部依赖(文件路径) |
| `loadState()` | 45-72 | 读取状态 JSON，文件不存在或解析失败时返回默认状态。 | 外部依赖(文件) |
| `saveState(state)` | 74-82 | 去重并截断状态数组后写回状态 JSON。 | I/O副作用 |
| `zonedParts(date, timeZone)` | 84-105 | 用指定时区把 `Date` 拆成年月日时分秒。 | 纯逻辑 |
| `dateKeyInZone(date, timeZone)` | 107-110 | 生成指定时区的 `YYYY-MM-DD` 日期 key。 | 纯逻辑 |
| `minutesInZone(date, timeZone)` | 112-115 | 计算指定时区当天已过分钟数。 | 纯逻辑 |
| `parseClock(value)` | 117-124 | 解析 `HH:mm` 字符串并归一化 label/分钟数。 | 纯逻辑 |
| `dueSlots({ now, timeZone, times, graceMinutes, state })` | 126-142 | 根据当前时间、配置时间和已完成 slot 状态计算本轮到期 slot。 | 纯逻辑 |
| `runOutlookExport({ days, maxMessages, syncWaitSeconds })` | 144-172 | 调用 `scripts/export-outlook-mail.ps1` 导出 Outlook/RMIT 邮件。 | 外部依赖(Outlook/PowerShell) |
| `runGmailExport({ maxMessages, query, account })` | 174-199 | 调用 `scripts/export-gmail-mail.ps1` 导出 Gmail 邮件。 | 外部依赖(Gmail/PowerShell) |
| `parseField(block, name)` | 201-204 | 从 markdown 块中解析 `- Name: value` 字段。 | 纯逻辑 |
| `parseOutlookSnapshot(file)` | 206-233 | 读取 Outlook snapshot markdown 并转成 school message 列表。 | 外部依赖(文件) |
| `schoolMessagesFromDrops(maxFiles)` | 235-264 | 从 school mail drop 收集消息，兼容 Outlook snapshot，按 key 去重和倒序排序。 | 外部依赖(文件/env/collectMailDrops) |
| `parseGmailSnapshot(file)` | 266-292 | 读取 Gmail snapshot 表格/代码块并转成 personal message 列表，跳过 draft。 | 外部依赖(文件) |
| `personalMessagesFromDrops(maxFiles)` | 294-325 | 从 personal mail drop 收集消息，兼容 Gmail snapshot，跳过 connector 快照噪音并去重排序。 | 外部依赖(文件/env/collectMailDrops) |
| `compactLine(value)` | 327-331 | 折叠空白并 trim，生成单行文本。 | 纯逻辑 |
| `gameKey(item)` | 333-335 | 生成游戏资讯去重 key。 | 纯逻辑 |
| `countGameSources(items)` | 337-344 | 按 `game:sourceType` 统计游戏资讯来源数量。 | 纯逻辑 |
| `translateGameTitle(title)` | 346-364 | 对已知游戏资讯标题做中文化和站点后缀清理。 | 纯逻辑 |
| `gamePrefix(item)` | 366-375 | 根据 game/sourceType 生成摘要里的来源前缀。 | 纯逻辑 |
| `formatGameSummary(items, { slotLabel, timeZone })` | 377-397 | 格式化游戏资讯摘要；当前内部读取 `GAME_CHECK_MAX_ITEMS`。 | 外部依赖(env) |
| `classifySchoolMessage(message)` | 399-409 | 根据 subject/body 正则把学校邮件分为问卷、成绩、作业、考试、活动、Canvas、通知。 | 纯逻辑 |
| `classifyPersonalMessage(message)` | 411-437 | 根据 subject/from/labels 正则把个人邮件分类并标记是否重要。 | 纯逻辑 |
| `translatePersonalSubject(subject)` | 439-450 | 对已知个人邮件 subject 做中文化和转发前缀处理。 | 纯逻辑 |
| `formatPersonalSummary(messages, { slotLabel, timeZone, skippedLowPriority })` | 452-479 | 格式化个人 Gmail 摘要，最多展示 8 封重要邮件并报告略过低优先级数量。 | 纯逻辑 |
| `formatSchoolSummary(messages, { slotLabel, timeZone })` | 481-500 | 格式化 RMIT 学校摘要，最多展示 8 封学校邮件。 | 纯逻辑 |
| `monthNumber(value)` | 502-504 | 把月份字符串映射为数字。 | 纯逻辑 |
| `to24Hour(hour, meridiem)` | 506-513 | 把 12 小时制小时和 am/pm 转成 24 小时制。 | 纯逻辑 |
| `localTimeToUtc({ year, month, day, hour, minute }, timeZone)` | 515-526 | 把指定时区的本地时间转换成 UTC `Date`。 | 纯逻辑 |
| `extractYearFallback(message, now, timeZone)` | 528-532 | 从 message date 抽年份，缺失时回退到当前时区年份。 | 纯逻辑 |
| `extractDeadlinesFromMessage(message, { now, timeZone })` | 534-576 | 从学校消息 subject/body 中识别英文/中文 deadline 文本并生成 deadline 对象。 | 纯逻辑 |
| `collectDeadlines(messages, { now, timeZone })` | 578-586 | 从多封消息抽取 deadline，按 key 去重并按 dueAt 升序排序。 | 纯逻辑 |
| `sendOrPrint(text, dryRun)` | 588-594 | dry-run 时打印，否则发送 Telegram。 | 外部依赖(Telegram/stdout) |
| `main()` | 596-853 | 整体 CLI 编排：读配置、导出/解析/过滤/发送、更新状态、写运行摘要。 | 编排orchestration |
| `main().catch(...)` | 855-864 | 顶层失败处理：打印错误、尝试 Telegram 失败通知、设置退出码。 | 编排orchestration/外部依赖 |

## 3. 拆分方案

建议统一放到 `src/school/` 下，先保持函数名和行为，再逐步改善依赖注入。拆分后 `src/school-check.mjs` 只做 CLI 入口：

```js
import { runSchoolCheckCli, reportFatalSchoolCheckError } from "./school/workflow.mjs";

runSchoolCheckCli().catch(reportFatalSchoolCheckError);
```

建议模块如下：

| 新模块 | 放入内容 | 对外导出 |
|---|---|---|
| `src/school/config.mjs` | CLI flag 判断、env 默认值读取、运行配置组装。把 `hasArg` 改成可传 `argv` 的纯函数；保留 `DEFAULT_TIME_ZONE`。 | `DEFAULT_TIME_ZONE`, `hasArg(argv, name)`, `readSchoolCheckConfig({ argv, env })` |
| `src/school/state.mjs` | 状态文件路径、默认状态、状态 shape 补齐、load/save。 | `defaultSchoolCheckState()`, `statePath()`, `normalizeState(state)`, `loadState()`, `saveState(state)` |
| `src/school/schedule.mjs` | 时区拆解和 slot 计算。 | `zonedParts`, `dateKeyInZone`, `minutesInZone`, `parseClock`, `dueSlots` |
| `src/school/exporters.mjs` | Outlook/Gmail PowerShell 调用。把 `spawnSync` 作为默认依赖，便于后续测试 args。 | `runOutlookExport`, `runGmailExport` |
| `src/school/mail-parsers.mjs` | 纯文本解析层。先从现有 file parser 中抽出 content parser。 | `parseField`, `parseOutlookSnapshotContent`, `parseGmailSnapshotContent` |
| `src/school/mail-drops.mjs` | 文件读取、`collectMailDrops` 调用、drop 去重排序。 | `parseOutlookSnapshot`, `parseGmailSnapshot`, `schoolMessagesFromDrops`, `personalMessagesFromDrops` |
| `src/school/classifiers.mjs` | 学校/个人邮件分类和 subject 翻译。 | `classifySchoolMessage`, `classifyPersonalMessage`, `translatePersonalSubject` |
| `src/school/deadlines.mjs` | deadline 相关月份、时间转换、抽取、去重排序。 | `MONTHS`, `monthNumber`, `to24Hour`, `localTimeToUtc`, `extractYearFallback`, `extractDeadlinesFromMessage`, `collectDeadlines` |
| `src/school/game-summary.mjs` | 游戏资讯 key、来源统计、标题翻译、来源前缀、摘要格式化。`formatGameSummary` 的 max items 应由参数传入，避免内部读 env。 | `gameKey`, `countGameSources`, `translateGameTitle`, `gamePrefix`, `formatGameSummary` |
| `src/school/summaries.mjs` | 通用文本压缩、学校/个人/临期/空检查摘要格式化。 | `compactLine`, `formatSchoolSummary`, `formatPersonalSummary`, `formatDeadlineReminder`, `formatEmptyCheckSummary` |
| `src/school/notifier.mjs` | dry-run 打印或 Telegram 发送。 | `sendOrPrint` |
| `src/school/workflow.mjs` | 主流程编排。接受默认依赖，也允许测试注入 fake exporters、fake news fetcher、fake notifier、fake clock。 | `runSchoolCheck`, `runSchoolCheckCli`, `reportFatalSchoolCheckError` |

拆分原则：

- 第一轮只移动代码，不改正则、不改中文文案、不改默认 env 名称/默认值。
- 纯逻辑模块之间可直接 import；I/O 模块只在 `workflow.mjs` 或明确的 adapter 中使用。
- `workflow.mjs` 是唯一知道“Outlook/Gmail/游戏/状态/Telegram”如何串起来的地方；其他模块不读 `process.argv`，尽量不直接读 `process.env`。
- `formatGameSummary` 当前读取 `envNumber("GAME_CHECK_MAX_ITEMS", 8)`，拆分时应改为 `formatGameSummary(items, { slotLabel, timeZone, maxItems })`，由 config/workflow 传入，避免格式化函数隐藏外部依赖。

## 4. 特征化测试目标

当前 `school-check.mjs` 没有导出，且 import 时会立刻执行 `main().catch()`。因此单元测试前需要先建立很薄的测试 seam：优先用 CLI dry-run/check-only 测试锁住入口行为；随后把顶层执行改成“仅直接运行时触发”，再导出或抽出纯函数做单元测试。这个 seam 本身必须通过 CLI smoke 测试证明 `node src/school-check.mjs` 行为不变。

### 4.1 可先锁住的纯逻辑函数

首批可写特征化单元测试的纯函数共 22 个：

`zonedParts`, `dateKeyInZone`, `minutesInZone`, `parseClock`, `dueSlots`, `parseField`, `compactLine`, `gameKey`, `countGameSources`, `translateGameTitle`, `gamePrefix`, `classifySchoolMessage`, `classifyPersonalMessage`, `translatePersonalSubject`, `formatPersonalSummary`, `formatSchoolSummary`, `monthNumber`, `to24Hour`, `localTimeToUtc`, `extractYearFallback`, `extractDeadlinesFromMessage`, `collectDeadlines`。

代表性用例如下，测试里应尽量断言完整返回值或完整输出字符串，避免重构时悄悄改文案：

| 函数 | 代表性输入 | 期望输出/断言 |
|---|---|---|
| `zonedParts` | `new Date("2026-06-24T00:30:05Z")`, `Australia/Melbourne` | `{ year: 2026, month: 6, day: 24, hour: 10, minute: 30, second: 5 }` |
| `dateKeyInZone` | 同上 | `"2026-06-24"` |
| `minutesInZone` | 同上 | `630` |
| `parseClock` | `"9:05"` | `{ hour: 9, minute: 5, total: 545, label: "09:05" }` |
| `parseClock` | `"24:00"` 或 `"bad"` | `null` |
| `dueSlots` | `now=2026-06-24T00:35:00Z`, `times=["10:30"]`, `graceMinutes=25`, 空 state | `[{ key: "2026-06-24 10:30", label: "10:30" }]` |
| `dueSlots` | 同上但 `state.slots["2026-06-24 10:30"]` 已存在 | `[]` |
| `parseField` | block 含 `- From: Alice`，name 为 `From` | `"Alice"` |
| `parseField` | block 不含字段 | `""` |
| `compactLine` | `"  a\n\t b   c  "` | `"a b c"` |
| `gameKey` | `{ game: "War Thunder", title: "Update", link: "HTTPS://X" }` | `"war thunder|update|https://x"` |
| `countGameSources` | 两条 `{ game: "War Thunder", sourceType: "official-site" }` 和一条空对象 | `{ "War Thunder:official-site": 2, "unknown:unknown": 1 }` |
| `translateGameTitle` | `"Development Sound Mods - Bilibili"` | `"开发日志：声音 Mod"` |
| `gamePrefix` | `{ sourceType: "official-site", game: "War Thunder" }` | `"战雷官方"` |
| `gamePrefix` | `{ game: "Escape from Tarkov" }` | `"塔科夫"` |
| `classifySchoolMessage` | subject `"CES survey"`, body 空 | `"问卷/反馈"` |
| `classifySchoolMessage` | subject `"Assignment 1 due"`, body 空 | `"作业/测验"` |
| `classifyPersonalMessage` | subject `"Security alert"`, from `"Google"` | `{ kind: "账号安全", important: true }` |
| `classifyPersonalMessage` | subject `"Uber receipt"`, from `"Uber"` | `{ kind: "低优先级", important: false }` |
| `translatePersonalSubject` | `"Security alert"` | `"Google 安全提醒"` |
| `translatePersonalSubject` | `"Fw: hello"` | `"转发：hello"` |
| `formatPersonalSummary` | 一封 Security alert，slotLabel `10:30`，skippedLowPriority `2` | 输出含标题、`[账号安全] Google 安全提醒`、`已略过 2 封...`、`时区：Australia/Melbourne` |
| `formatSchoolSummary` | 空 messages，slotLabel `手动` | 当前行为是不追加时区：`RMIT 学校检查（墨尔本时间 手动）\n\n- 暂无新的学校事项。` |
| `formatSchoolSummary` | 9 封学校消息 | 只展示前 8 封，且每行分类由 `classifySchoolMessage` 决定 |
| `monthNumber` | `"Sept"` / `"bad"` | `9` / `undefined` |
| `to24Hour` | `(12, "am")`, `(12, "pm")`, `(7, "pm")` | `0`, `12`, `19` |
| `localTimeToUtc` | `{ 2026-06-24 10:30 }`, `Australia/Melbourne` | `2026-06-24T00:30:00.000Z` |
| `extractYearFallback` | message date 含 `2025` | `2025` |
| `extractYearFallback` | message date 无年份，now 为 2026 年墨尔本时间 | `2026` |
| `extractDeadlinesFromMessage` | body `"Assignment due June 24, 2026 at 11:30 pm"` | 一条 deadline，`dueLocal` 为 `2026-06-24 23:30`，`dueAt` 为 `2026-06-24T13:30:00.000Z` |
| `extractDeadlinesFromMessage` | body `"24 June 2026 at 23:30 deadline"` | 反向日期格式也能抽出同一天 23:30 |
| `collectDeadlines` | 两封消息含重复 key deadline | 按 key 去重，并按 `dueAt` 升序 |

`formatGameSummary` 当前不完全纯，因为内部读取 `envNumber("GAME_CHECK_MAX_ITEMS", 8)`。可以先加受控 env restore 的特征化测试，或在拆分时先把 `maxItems` 参数化后再按纯函数测试。需要锁住的当前行为包括：空列表时提前返回且不追加时区；有 item 时输出最多 `GAME_CHECK_MAX_ITEMS` 条，带来源、日期和链接。

### 4.2 I/O 和外部依赖的隔离方式

| 当前函数/区域 | 难测原因 | 建议隔离方式 |
|---|---|---|
| `runOutlookExport`, `runGmailExport` | 依赖 PowerShell、Outlook/Gmail、本机账号状态。 | 放入 `exporters.mjs`，把 `spawnSync` 作为可注入依赖；单元测试只断言命令、参数、cwd、非 0 状态时错误消息。 |
| `parseOutlookSnapshot(file)`, `parseGmailSnapshot(file)` | 直接读文件。 | 先抽 `parseOutlookSnapshotContent(content, file)` 和 `parseGmailSnapshotContent(content, file)` 做纯测试；文件 wrapper 只做 `readFileSync`。 |
| `schoolMessagesFromDrops`, `personalMessagesFromDrops` | 依赖 `collectMailDrops`、目录、`process.env`、文件系统。 | 将 drop dirs 从 config 传入，并允许注入 `collectMailDrops`；去重/过滤排序可用 fake drops 测。 |
| `fetchGameNews` 调用区域 | 网络/RSS/Google News 结果不稳定。 | 在 `workflow.mjs` 中注入 `fetchGameNews`；workflow 测试用固定 fake game items。 |
| `sendOrPrint` 和顶层 catch | 依赖 Telegram 和 stdout/stderr。 | `notifier.mjs` 中保留 adapter；workflow 测试注入 fake `sendTelegramMessage` 和 fake logger。 |
| `loadState`, `saveState`, 日志写入 | 依赖 `data/state` 和 `data/logs`。 | `state.mjs` 支持传入 path resolver 或在测试里使用 temp cwd；状态 shape 和截断逻辑单独测。 |
| `main()` | 同时读 env/argv、调用外部导出、网络、文件、Telegram。 | 提炼为 `runSchoolCheck({ now, config, state, deps })`，CLI 层只组装真实依赖；workflow 测试全用 fake deps。 |

## 5. 安全增量顺序

建议分 8 小步执行，每步都保持 `npm test` 全绿；涉及源码变更的步骤也应跑 `npm run lint` 和 `npm run check`。

1. **基线确认**：不改业务代码，先跑 `npm test`、`npm run lint`、`npm run check` 记录当前状态。若已有失败，先记录，不把 S2 拆分和既有失败混在一起。
2. **入口特征化 smoke**：新增 CLI 级测试，用 temp cwd + `--dry-run --check-only --force-school/--force-personal` + temp mail drop，证明不触发 Outlook/Gmail/Telegram，也不写真实 `data/`。断言 stdout 摘要和 temp `data/logs` JSON 关键字段。
3. **建立 import-safe seam**：把顶层 `main().catch()` 改成仅直接运行时触发，并保留 CLI 行为；用第 2 步测试证明直接运行仍正常。
4. **导出并测试首批纯函数**：先给 schedule/classifier/deadline/formatter/game key 等纯函数加 named export，写 `node:test` 特征化测试。此步不移动代码，只锁行为。
5. **拆纯逻辑模块**：按 `schedule.mjs`、`classifiers.mjs`、`deadlines.mjs`、`game-summary.mjs`、`summaries.mjs` 顺序移动函数；每移一个模块就更新 import/export 并跑测试。优先低耦合、无 I/O 的模块。
6. **拆文本解析与 mail drop**：先抽 content parser 并补测试，再移动文件读取/drop 聚合 wrapper。保持 key 生成、去重、排序、跳过 draft/connector snapshot 的行为不变。
7. **拆 I/O adapter**：移动 state、exporters、notifier；引入依赖注入但默认依赖仍是当前 `fs`、`spawnSync`、`sendTelegramMessage`。用 fake deps 测错误路径，尤其 Gmail export error 只 warning 不 fail。
8. **收拢 workflow 与薄入口**：把 `main()` 主体收进 `workflow.mjs` 的 `runSchoolCheckCli()`/`runSchoolCheck()`；`src/school-check.mjs` 只保留入口调用和 fatal error wiring。最后跑 `npm test`、`npm run lint`、`npm run check`，并用一次 dry-run/check-only CLI smoke 验证端到端输出。

## 6. 风险与注意点

- **当前文件 import 会执行主流程**：这是补单元测试前最大的测试性障碍。直接给测试 import 源文件会触发 env、文件、网络/Telegram 路径，必须先用 CLI smoke 锁住，再建立 import-safe seam。
- **`--dry-run` 仍会写运行摘要日志**：当前只跳过 `saveState(state)`，但仍创建 `data/logs` 并写 JSON。拆分时不能误以为 dry-run 完全无文件副作用。
- **`--check-only` 只跳过 Outlook/Gmail 导出**：仍会读取已有 drop、生成摘要、写日志；这个行为需要保留。
- **Gmail 导出失败不应让主流程失败**：当前 catch 后 warning，并把错误写入 `personalExportError`。不能改成 throw。
- **seen key 更新范围很重要**：学校/个人/游戏都会把本轮读取到的所有 items 加入 seen，不只是发送过的新增 items。
- **状态数组截断长度必须保持**：`seenMessageKeys`、`seenPersonalKeys`、`seenGameKeys` 保留 2000；`remindedDeadlineKeys` 保留 1000。
- **catchup 语义容易回归**：school catchup 只在定时槽、新消息为 0、非 force 且配置分钟数大于 0 时启动；active school catchup 遇到新消息会清空。game catchup 在定时 game check 后启动，当前没有“遇到新资讯后清空”的对称逻辑，拆分时先保持现状。
- **空摘要格式存在早返回差异**：`formatSchoolSummary([])` 和 `formatGameSummary([])` 当前不会追加 `时区：...`，而个人摘要会追加时区；这可能看起来不一致，但第一轮拆分必须锁住。
- **正则顺序就是业务优先级**：例如学校邮件先判 CES/问卷，再判成绩、作业、考试等；个人邮件低优先级在多类重要规则之后。调整顺序会改变分类。
- **`formatGameSummary` 隐式读 env**：这是格式化函数里的隐藏外部依赖，拆分时应参数化，但要先用测试确认最大展示条数行为。
- **时间与时区测试要固定 Date**：deadline 和 slot 逻辑依赖 `Intl.DateTimeFormat`、时区和 DST；测试应使用明确 UTC 字符串和 `Australia/Melbourne`，避免本机时区影响。
- **不要提前合并 `openai.mjs` 的相似分类逻辑**：仓库里存在相似但不完全相同的分类规则。S2 只拆 `school-check.mjs`，不要顺手抽共享分类模块，否则风险和变更面会扩大。
- **路径和 env 名称不能改**：`SCHOOL_MAIL_DROP_DIR`、`PERSONAL_MAIL_DROP_DIR`、`GMAIL_EXPORT_QUERY`、`GOG_ACCOUNT`、`SCHOOL_CHECK_*`、`GAME_*` 等现有配置名和默认值都属于外部契约。
