# S3 openai.mjs 特征化测试与拆分方案

本文基于当前 `src/openai.mjs` 静态阅读产出。当前文件共 529 行，不是 CLI 入口；唯一导出是 `buildDigest({ title, gameNews, mailMessages })`。当前上游入口是 `src/index.mjs`：先 `loadEnv()`，再 `fetchGameNews()`、`collectMailDrops()`，把 `title`、`gameNews`、`mailMessages` 传入 `buildDigest()`，最后归档摘要并发送 Telegram。

## 1. 模块职责概述

`openai.mjs` 目前承担的是“把已收集好的游戏资讯和邮件消息整理成每日摘要”的职责，但内部混合了多类逻辑：

1. Gmail/Outlook snapshot 展开：从 `mailMessages` 中的 `file` 或 `body` 读取原文，把 Gmail 表格和 Outlook markdown snapshot 解析成真实邮件项。
2. 邮件归一化：补齐 key、去重、过滤无法读取的消息、按日期倒序排序，并分成 school/personal 两类。
3. 学校邮件、个人邮件、游戏资讯的分类、标题翻译、条目格式化。
4. 从个人邮件和学校邮件生成待办候选。
5. 生成确定性摘要 `deterministicDigest`。
6. 在环境变量允许时构造 prompt，调用本地 Ollama 或 OpenAI Responses API，再用结构校验决定是否采用 LLM 输出。

`buildDigest()` 的输入输出契约：

- 输入：`{ title, gameNews, mailMessages }`。
- `title` 是摘要标题字符串。
- `gameNews` 是上游 RSS/Google News 已抓取的数组，当前只消费 `title`、`source`、`pubDate`、`link`、`query`、`game`、`sourceType`。
- `mailMessages` 是上游 `collectMailDrops()` 产出的数组，当前依赖 `category`、`file`、`body`、`subject`、`from`、`date`、`modifiedAt`、`labels`、`key` 等字段。
- 输出：`Promise<string>`，返回适合 Telegram 阅读的纯文本摘要。

是否真调用外部 LLM/网络：

- 默认不调用 LLM/网络：`ENABLE_AI_DIGEST` 默认按 `false` 处理，直接返回确定性摘要。
- 即使不调用 LLM，归一化阶段也可能读取本地文件：当 `mailMessages` 中有 Gmail/Outlook snapshot 文件路径且文件存在时，会通过 `fs.existsSync()` / `fs.readFileSync()` 读取。
- 当 `ENABLE_AI_DIGEST=true` 且 `LOCAL_AI_PROVIDER` 默认为或设置为 `ollama` 时，会调用 `generateWithOllama({ prompt })`；`src/local-ai.mjs` 里该函数用 `fetch()` 请求 `OLLAMA_BASE_URL`，默认 `http://127.0.0.1:11434/api/generate`。
- Ollama 返回文本但结构不合格时，直接回退确定性摘要；Ollama 抛错时，只有 `ENABLE_OPENAI_FALLBACK=true` 且 `OPENAI_API_KEY` 存在才继续走 OpenAI，否则返回确定性摘要并附加一行本地 AI 不可用提示。
- 当走 OpenAI fallback 时，会用全局 `fetch()` 请求 `https://api.openai.com/v1/responses`，模型为 `OPENAI_MODEL || "gpt-5-mini"`，body 为 `{ model, input: prompt }`。非 2xx 响应会 throw；2xx 响应经 `outputText()` 抽取文本，再由 `digestLooksReasonable()` 决定采用或回退确定性摘要。

入口数据流应保持为：

```text
src/index.mjs
  loadEnv()
  fetchGameNews() -> gameNews
  collectMailDrops() -> mailMessages
  buildDigest({ title, gameNews, mailMessages }) -> digest
  archive + sendTelegramMessage()
```

拆分目标不是改变摘要内容，而是先锁住当前行为，再让 `openai.mjs` 只保留薄兼容入口和默认依赖组装。

## 2. 函数/常量清单

| 名称 | 行号范围 | 一句话作用 | 分类 |
|---|---:|---|---|
| `DIGEST_SECTION_LIMIT` | 5 | 固定每个摘要栏目最多展示 4 条。 | 纯逻辑 |
| `REQUIRED_SECTIONS` | 6 | LLM 输出必须包含的 4 个栏目名。 | 纯逻辑 |
| `outputText(responseJson)` | 8-21 | 从 OpenAI Responses API JSON 中抽取 `output_text` 或 content 文本。 | 纯逻辑 |
| `fieldValue(block, name)` | 23-26 | 从 Outlook markdown 字段块中解析 `- Name: value`。 | 纯逻辑 |
| `readMessageSource(message)` | 28-33 | 优先从 `message.file` 读文件，失败或无文件时回退 `message.body`。 | I/O或网络副作用 |
| `parseGmailSnapshot(message)` | 35-65 | 解析 Gmail snapshot 表格，过滤 draft/trash/spam，产出 personal message。 | I/O或网络副作用 |
| `parseOutlookSnapshot(message)` | 67-96 | 解析学校 Outlook snapshot markdown，产出 school message。 | I/O或网络副作用 |
| `messageDateMs(message)` | 98-101 | 把 `date` 或 `modifiedAt` 转为可排序毫秒时间，非法日期返回 0。 | 纯逻辑 |
| `normalizeMailMessages(mailMessages)` | 103-132 | 展开 snapshot、补 key、过滤坏消息、去重并按时间倒序排序。 | I/O或网络副作用 |
| `translateSchoolTitle(title)` | 134-157 | 对常见学校/Canvas 邮件标题做中文化和关键词替换。 | 纯逻辑 |
| `compactLine(value)` | 159-161 | 折叠空白并 trim，生成单行文本。 | 纯逻辑 |
| `classifySchoolMessage(message)` | 163-173 | 按 subject/body 正则把学校邮件分成问卷、成绩、作业、考试、Canvas、课程活动或通知。 | 纯逻辑 |
| `classifyPersonalMessage(message)` | 175-225 | 按 subject/from/labels 正则给个人邮件打 kind、important、rank、action。 | 纯逻辑 |
| `formatSchoolItem(message)` | 227-233 | 把一封 school message 格式化为摘要 bullet。 | 纯逻辑 |
| `formatPersonalItem(message)` | 235-241 | 把一封 personal message 格式化为摘要 bullet。 | 纯逻辑 |
| `rankedPersonalMessages(messages)` | 243-250 | 给个人邮件分类后按 rank 和日期降序排序。 | 纯逻辑 |
| `buildTodoItems({ schoolMessages, personalMessages })` | 252-285 | 从重要个人邮件和学校截止/问卷事项生成最多 4 条待办。 | 纯逻辑 |
| `translateGameTitle(title)` | 287-320 | 清理游戏资讯站点后缀，并翻译常见英文标题片段。 | 纯逻辑 |
| `gamePrefix(item)` | 322-331 | 根据 `sourceType` 和 `game` 生成游戏资讯来源前缀。 | 纯逻辑 |
| `formatGameItem(item)` | 333-338 | 把一条游戏资讯格式化为摘要 bullet，链接另起一行。 | 纯逻辑 |
| `buildDeterministicDigest({ title, gameNews, schoolMessages, personalMessages })` | 340-383 | 不调用 LLM，按固定栏目生成完整确定性摘要。 | 纯逻辑 |
| `sectionBulletCount(text, section)` | 385-401 | 统计某个栏目内以 `- ` 开头的 bullet 数。 | 纯逻辑 |
| `digestLooksReasonable(text)` | 403-407 | 校验 LLM 输出是否包含必需栏目、无 snapshot 文件名、每栏不超过 4 条。 | 纯逻辑 |
| `buildDigest({ title, gameNews, mailMessages })` | 409-529 | 归一化输入、生成确定性摘要、按 env 决定是否调用 Ollama/OpenAI，并处理 fallback。 | 编排；外部依赖(LLM/env)；I/O或网络副作用 |

## 3. 拆分方案

建议统一放到 `src/digest/` 下，先保持函数名、文案、正则、默认 env 行为不变。`src/openai.mjs` 继续作为兼容入口导出 `buildDigest()`，但最终只负责组装默认依赖并调用 digest workflow。

| 新模块 | 放入内容 | 对外导出 |
|---|---|---|
| `src/digest/constants.mjs` | 摘要栏目限制和必需栏目。 | `DIGEST_SECTION_LIMIT`, `REQUIRED_SECTIONS` |
| `src/digest/text.mjs` | 通用文本压缩。 | `compactLine` |
| `src/digest/mail.mjs` | snapshot 字段解析、文件/body 原文读取、Gmail/Outlook snapshot 解析、日期排序、邮件归一化。拆分时优先从现有 parser 中抽出纯 `parse*Content()`。 | `fieldValue`, `readMessageSource`, `parseGmailSnapshotContent`, `parseOutlookSnapshotContent`, `parseGmailSnapshot`, `parseOutlookSnapshot`, `messageDateMs`, `normalizeMailMessages` |
| `src/digest/school.mjs` | 学校标题翻译、学校邮件分类、学校 bullet 格式化。 | `translateSchoolTitle`, `classifySchoolMessage`, `formatSchoolItem` |
| `src/digest/personal.mjs` | 个人邮件分类、个人 bullet 格式化、个人邮件排序。 | `classifyPersonalMessage`, `formatPersonalItem`, `rankedPersonalMessages` |
| `src/digest/games.mjs` | 游戏标题翻译、来源前缀、游戏 bullet 格式化。 | `translateGameTitle`, `gamePrefix`, `formatGameItem` |
| `src/digest/todos.mjs` | 待办生成逻辑。 | `buildTodoItems` |
| `src/digest/deterministic.mjs` | 固定栏目确定性摘要生成。 | `buildDeterministicDigest` |
| `src/digest/ai.mjs` | OpenAI response 文本抽取、prompt 构造、LLM 输出校验、Ollama/OpenAI 调用编排。默认依赖仍使用现有 `generateWithOllama`、全局 `fetch`、`process.env`。 | `outputText`, `sectionBulletCount`, `digestLooksReasonable`, `buildDigestPrompt`, `tryBuildAiDigest` |

拆分后 `src/openai.mjs` 可以收敛成薄入口：

```js
import { normalizeMailMessages } from "./digest/mail.mjs";
import { buildDeterministicDigest } from "./digest/deterministic.mjs";
import { tryBuildAiDigest } from "./digest/ai.mjs";

export async function buildDigest({ title, gameNews, mailMessages }, deps = {}) {
  const normalizedMailMessages = normalizeMailMessages(mailMessages, deps);
  const schoolMessages = normalizedMailMessages.filter((item) => item.category === "school");
  const personalMessages = normalizedMailMessages.filter((item) => item.category === "personal");
  const deterministicDigest = buildDeterministicDigest({ title, gameNews, schoolMessages, personalMessages });

  return tryBuildAiDigest({
    title,
    gameNews,
    schoolMessages,
    personalMessages,
    deterministicDigest,
    deps
  });
}
```

上面只是目标形态示意，实施时不应一次性大改。第一轮拆分应保持 `buildDigest({ title, gameNews, mailMessages })` 的现有调用方式兼容；`deps` 只作为测试可选参数加入，默认路径必须完全等价于当前行为。

## 4. 特征化测试目标

当前 `openai.mjs` import 时不会自动执行主流程，测试性好于 `school-check.mjs`。但大多数辅助函数没有导出，且 `buildDigest()` 混合了文件读取、env、LLM 调用和格式化。建议先用 public `buildDigest()` 黑盒测试锁住最重要输出，再用最小 named export 或拆前临时 seam 锁住纯逻辑函数。

下面的期望输出是基于静态阅读的预测；真正实施时应以当前代码实际输出为准，先跑一次失败/通过结果再固定。

### 4.1 可先锁住的纯逻辑函数

首批可写特征化单元测试的纯函数共 17 个：

`outputText`, `fieldValue`, `messageDateMs`, `translateSchoolTitle`, `compactLine`, `classifySchoolMessage`, `classifyPersonalMessage`, `formatSchoolItem`, `formatPersonalItem`, `rankedPersonalMessages`, `buildTodoItems`, `translateGameTitle`, `gamePrefix`, `formatGameItem`, `buildDeterministicDigest`, `sectionBulletCount`, `digestLooksReasonable`。

| 函数 | 代表性输入 | 期望输出/断言 |
|---|---|---|
| `outputText` | `{ output_text: " hello \n" }` | `"hello"` |
| `outputText` | `{ output: [{ content: [{ text: "a" }, { output_text: "b" }] }] }` | `"a\nb"` |
| `fieldValue` | block 含 `- From: Alice`，name 为 `From` | `"Alice"` |
| `fieldValue` | block 不含对应字段 | `""` |
| `messageDateMs` | `{ date: "2026-06-24T00:00:00Z" }` | `Date.parse("2026-06-24T00:00:00Z")` |
| `messageDateMs` | `{ date: "bad", modifiedAt: "also bad" }` | `0` |
| `translateSchoolTitle` | `"Assignment Graded: Quiz"` | `"作业/测验已评分：测验"` |
| `translateSchoolTitle` | `"Reminder: Assignment is due tonight"` | `"提醒：作业 今晚截止"` |
| `compactLine` | `"  a\n\t b   c  "` | `"a b c"` |
| `classifySchoolMessage` | `{ subject: "CES survey", body: "" }` | `"问卷/反馈"` |
| `classifySchoolMessage` | `{ subject: "Submission reminder", body: "deadline tonight" }` | `"作业/测验"` |
| `classifyPersonalMessage` | `{ subject: "Security alert", from: "Google" }` | `{ kind: "Urgent", important: true, rank: 0, action: "核对账号安全" }` |
| `classifyPersonalMessage` | `{ subject: "50% discount", from: "Uber" }` | `{ kind: "Noise", important: false, rank: 9, action: "低优先级" }` |
| `formatSchoolItem` | assignment message，from/date 均存在 | 输出形如 `- [作业/测验] ...｜<from>｜<date>` |
| `formatPersonalItem` | Security alert message | 输出形如 `- [Urgent] 核对账号安全：Security alert｜Google｜<date>` |
| `rankedPersonalMessages` | 一封 Noise 日期较新、一封 Urgent 日期较旧 | Urgent 仍排在 Noise 前面 |
| `rankedPersonalMessages` | 两封同 rank FYI，不同 date | date 较新的排前面 |
| `buildTodoItems` | Urgent 个人邮件 | 包含 `- 先核对账号/登录安全：<subject>` |
| `buildTodoItems` | 无重要个人邮件、无作业/考试/问卷学校邮件 | `["- 暂无明确待办。"]` |
| `translateGameTitle` | `"Development Sound Mods - War Thunder"` | `"开发日志：声音 Mod"` |
| `gamePrefix` | `{ sourceType: "official-site", game: "War Thunder" }` | `"战雷官方"` |
| `gamePrefix` | `{ sourceType: "tarkov-official", game: "Escape from Tarkov" }` | `"塔科夫官方"` |
| `formatGameItem` | game item 含 source 和 link | bullet 第一行含 `[来源] 标题｜source`，第二行缩进两个空格加 link |
| `buildDeterministicDigest` | 空 `gameNews/schoolMessages/personalMessages` | 包含固定 4 个栏目；学校为空时提示导出学校邮件；待办为暂无明确待办 |
| `buildDeterministicDigest` | 每类输入超过 4 条 | 每个栏目最多展示 4 条 |
| `sectionBulletCount` | `学校` 下两条 bullet，下一栏目一条 | 对 `学校` 返回 `2` |
| `digestLooksReasonable` | 缺少任一必需栏目 | `false` |
| `digestLooksReasonable` | 文本含 `gmail-snapshot-2026` 或某栏目超过 4 条 | `false` |

`parseGmailSnapshot()`、`parseOutlookSnapshot()` 和 `normalizeMailMessages()` 当前不是纯函数，因为会读取本地文件。建议先抽出 `parseGmailSnapshotContent(content, sourceMessage)` 和 `parseOutlookSnapshotContent(content, sourceMessage)`，再补纯单测。代表性行为包括：Gmail 跳过 `ID\t` 表头、跳过 `DRAFT/TRASH/SPAM`、key 为 `gmail|<id>` 小写；Outlook 只解析含 `## ` 的 markdown section，缺失 `From` 时使用 `unknown sender`，key 为 `school|received|from|subject` 小写。

### 4.2 I/O、LLM、env 的隔离方式

| 当前函数/区域 | 难测原因 | 建议隔离方式 |
|---|---|---|
| `readMessageSource` | 直接用 `fs.existsSync` / `fs.readFileSync` 读取本地文件。 | 接受 `{ existsSync, readFileSync }` 或更窄的 `readTextFileIfExists(file)` 依赖；默认仍用 `fs`。 |
| `parseGmailSnapshot`, `parseOutlookSnapshot` | 解析逻辑和文件读取绑在一起。 | 先抽纯 content parser；wrapper 只负责读取 source。 |
| `normalizeMailMessages` | 可能触发 snapshot 文件读取，并依赖 `path.basename` 判断文件名。 | 注入 `parseGmailSnapshot`、`parseOutlookSnapshot` 或 `readMessageSource`；保留默认 parser。 |
| `buildDigest` 的 env 判断 | 直接读 `process.env.ENABLE_AI_DIGEST`、`LOCAL_AI_PROVIDER`、`ENABLE_OPENAI_FALLBACK`、`OPENAI_API_KEY`、`OPENAI_MODEL`。 | `tryBuildAiDigest(..., { env })` 接收 env 对象；默认 `process.env`。 |
| Ollama 路径 | `generateWithOllama()` 内部会用 `fetch()` 请求本地 Ollama，结果不稳定。 | 在 `tryBuildAiDigest` 中注入 `generateWithOllama` fake；只测试“成功且 reasonable”、“成功但 unreasonable”、“抛错且无 fallback”、“抛错且走 OpenAI”。 |
| OpenAI fallback 路径 | 依赖真实 API key 和网络，非 2xx 会 throw。 | 注入 `fetch` fake 和 `env.OPENAI_API_KEY`；断言 URL、method、headers、body、非 ok throw、ok 后 `outputText` 解析和 fallback。 |
| prompt 构造 | prompt 文本很长，且和 compact payload 结构强绑定。 | 抽 `buildDigestPrompt()`，用 snapshot 测试锁住硬性规则、栏目模板、JSON payload 字段名。 |

## 5. 安全增量顺序

建议分 8 小步执行，每步保持 `npm test` 全绿；边界步骤再跑 `npm run lint` 和仓库已有 check 命令。若基线已有失败，先记录现状，不把 S3 拆分和既有失败混在一起。

1. **基线确认**：不改业务代码，跑 `npm test`，记录当前 `src/openai.mjs` 行数、唯一导出、`buildDigest` 调用点和默认 env 行为。
2. **public contract 特征化**：只通过 `buildDigest()` 写黑盒测试，固定 `ENABLE_AI_DIGEST=false`，用内存 `body` 消息和少量 `gameNews` 锁住确定性摘要栏目、顺序、每栏 4 条限制、待办生成和低优先级统计。
3. **最小测试 seam**：在不搬代码的前提下导出首批纯逻辑函数，或用等价的内部测试入口；先证明 `buildDigest()` 黑盒测试仍通过。
4. **纯函数特征化**：给 17 个纯函数补单测，断言完整对象或完整字符串；对正则分类类函数特别锁住优先级顺序。
5. **抽 snapshot content parser**：把 Gmail/Outlook parser 拆成纯 content parser + 文件 wrapper；补 parser 单测后再跑 `buildDigest()` 黑盒测试，确认 snapshot 展开行为不变。
6. **先搬低风险纯模块**：按 `text`、`school`、`personal`、`games`、`todos`、`deterministic`、`ai` 中的纯校验函数顺序移动。每搬一个模块只更新 import/export，不改文案和正则。
7. **搬 I/O 与 LLM adapter**：移动 `mail.mjs` 的文件读取 wrapper，并把 `tryBuildAiDigest()` 改为可注入 `env`、`fetch`、`generateWithOllama`。默认依赖必须仍等价于当前 `process.env`、全局 `fetch` 和现有 `generateWithOllama`。
8. **收拢薄入口**：让 `src/openai.mjs` 只保留 `buildDigest()` 的兼容导出和默认依赖组装。最后跑 `npm test`、lint/check，并用一次 `src/index.mjs` 级别 smoke 或 mock 依赖测试确认上游调用契约没变。

## 6. 风险与注意点

- **prompt 文本必须保持不变**：硬性规则、输出模板、栏目名、JSON payload 字段名、`personalLowPriorityCount`、`todoCandidates` 等都属于 LLM 行为契约。第一轮不要重写 prompt。
- **默认不启用 AI 的行为必须保持**：`ENABLE_AI_DIGEST` 不为 `"true"` 时直接返回确定性摘要，不应触发 Ollama/OpenAI。
- **Ollama fallback 语义必须保持**：Ollama 输出不 reasonable 时直接确定性回退；Ollama 抛错且没有 OpenAI fallback/key 时，返回确定性摘要并追加 `本地 AI 提示：Ollama 暂时不可用（...）。`
- **OpenAI fallback 参数不能顺手改**：endpoint 是 `/v1/responses`，默认模型是 `"gpt-5-mini"`，body 只有 `{ model, input: prompt }`，非 ok 响应当前会 throw。
- **`digestLooksReasonable()` 是 LLM 输出闸门**：必须包含 4 个栏目，不能出现 `gmail-snapshot-*` / `outlook-<school>-snapshot-*` 文件名，每栏 bullet 数不能超过 4。
- **snapshot 解析细节不能漂移**：Gmail 解析 tab 分隔行、跳过 `DRAFT/TRASH/SPAM`、key 为 `gmail|id`；Outlook 解析 `## ` section、`From` 缺失为 `unknown sender`、`Received` 缺失回退 message date。
- **归一化去重和排序要保持**：按 key 首次出现保留，过滤空 subject 和 `Could not read`，最终按 `messageDateMs` 倒序。
- **分类正则顺序就是业务行为**：个人邮件中 `receipt` 规则早于促销/uber/noise 规则；学校邮件中问卷、成绩、作业、考试、Canvas、课程活动的顺序也会影响结果。
- **确定性摘要文案和空态要锁住**：栏目顺序、空学校邮件提示、空个人邮件提示、空游戏资讯提示、待办空态、链接换行和空行都可能影响 Telegram 阅读效果。
- **不要合并 school-check 的相似逻辑**：`school-check.mjs` 里有相似但不完全相同的分类、翻译和摘要逻辑。S3 只拆 `openai.mjs`，不要抽共享分类模块，否则会扩大回归面。
- **测试不要读取真实凭据或真实数据目录**：未来测试应使用 temp fixtures 或内存 fake，不读取 `.env`、真实 `data/`、`.openclaw/`，也不触发真实 Ollama/OpenAI 网络。
