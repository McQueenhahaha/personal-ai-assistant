import { compactLine } from "./text.mjs";

export function translateSchoolTitle(title) {
  return title
    .replace(/^Recent Canvas notifications$/i, "Canvas 近期通知")
    .replace(/^Assignment Graded:\s*/i, "作业/测验已评分：")
    .replace(/^Assignment graded:\s*/i, "作业/测验已评分：")
    .replace(/^Assignment Due Date Changed:\s*/i, "作业截止日期已更改：")
    .replace(/^Submission posted:\s*/i, "提交记录已发布：")
    .replace(/^You have been added to a class team/i, "你已被加入课程 Microsoft Teams")
    .replace(/^Update:\s*/i, "更新：")
    .replace(/^Reminder:\s*/i, "提醒：")
    .replace(/^All engineering students are invited to/i, "工程学生邀请：")
    .replace(/a STEM social\/industry event on 18 May\s+12-?\s*3pm in Storey Hall/i, "5 月 18 日 12:00-15:00 在 Storey Hall 的 STEM 社交/行业活动")
    .replace(/^New Colombo Plan Scholarships Opportunities/i, "New Colombo Plan 奖学金机会")
    .replace(/^Assessment support edition/i, "评估/作业支持专期")
    .replace(/^Week ten:/i, "第 10 周：")
    .replace(/^Wrapping up week/i, "本周总结：第")
    .replace(/\bjust sent you a message in Canvas\b/i, "刚在 Canvas 给你发了消息")
    .replace(/\bis due tonight\b/i, "今晚截止")
    .replace(/\bis due on\b/i, "截止于")
    .replace(/\bFeedback Quiz\b/gi, "反馈测验")
    .replace(/\bQuiz\b/gi, "测验")
    .replace(/\bAssignment\b/gi, "作业")
    .trim();
}

export function classifySchoolMessage(message) {
  const subject = String(message.subject || "").toLowerCase();
  const text = `${message.subject}\n${message.body || ""}`.toLowerCase();
  if (/\bces\b|survey|questionnaire|complete your .*feedback|give your feedback/.test(subject)) return "问卷/反馈";
  if (/graded|feedback|marks?|score/.test(text)) return "成绩/反馈";
  if (/assignment|quiz|assessment|due|deadline|submission/.test(text)) return "作业/测验";
  if (/exam|test/.test(text)) return "考试";
  if (/message for|canvas|lms/.test(text)) return "Canvas";
  if (/lecture|seminar|event|workshop|social|scholarship|opportunit/.test(subject)) return "课程/活动";
  return "通知";
}

export function formatSchoolItem(message) {
  const kind = classifySchoolMessage(message);
  const subject = translateSchoolTitle(compactLine(message.subject));
  const from = compactLine(message.from);
  const date = compactLine(message.date);
  return `- [${kind}] ${subject}${from ? `｜${from}` : ""}${date ? `｜${date}` : ""}`;
}
