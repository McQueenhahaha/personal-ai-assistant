import { DIGEST_SECTION_LIMIT } from "./constants.mjs";
import { formatGameItem } from "./games.mjs";
import { formatPersonalItem, rankedPersonalMessages } from "./personal.mjs";
import { formatSchoolItem } from "./school.mjs";
import { buildTodoItems } from "./todos.mjs";

export function buildDeterministicDigest({ title, gameNews, schoolMessages, personalMessages }) {
  const lines = [title, ""];

  lines.push("学校");
  if (schoolMessages.length === 0) {
    lines.push("- 暂无学校邮件文件。把学校邮件导出到 `data/school-mail-drop` 后，我会在这里整理课程、截止日期和重要通知。");
  } else {
    for (const message of schoolMessages.slice(0, DIGEST_SECTION_LIMIT)) {
      lines.push(formatSchoolItem(message));
    }
  }

  lines.push("", "个人邮件");
  if (personalMessages.length === 0) {
    lines.push("- 暂无个人邮件文件。");
  } else {
    const ranked = rankedPersonalMessages(personalMessages);
    const shown = ranked.filter((item) => item.classification.important).slice(0, DIGEST_SECTION_LIMIT);
    const visible = shown.length > 0 ? shown : ranked.slice(0, DIGEST_SECTION_LIMIT);
    for (const { message } of visible) {
      lines.push(formatPersonalItem(message));
    }
    const skippedLowPriority = ranked.filter((item) => !item.classification.important).length;
    if (skippedLowPriority > 0 && visible.length < DIGEST_SECTION_LIMIT) {
      lines.push(`- 已略过 ${skippedLowPriority} 封促销/收据等低优先级邮件。`);
    }
  }

  lines.push("", "游戏资讯");
  if (gameNews.length === 0) {
    lines.push("- 暂无游戏资讯。");
  } else {
    for (const item of gameNews.slice(0, DIGEST_SECTION_LIMIT)) {
      lines.push(formatGameItem(item));
    }
  }

  lines.push("", "待办");
  for (const item of buildTodoItems({ schoolMessages, personalMessages })) {
    lines.push(item);
  }

  return lines.join("\n");
}

