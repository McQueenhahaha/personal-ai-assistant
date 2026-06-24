export function classifySchoolMessage(message) {
  const subject = String(message.subject || "").toLowerCase();
  const text = `${message.subject}\n${message.body}`.toLowerCase();
  if (/\bces\b|survey|questionnaire|complete your .*feedback|give your feedback/.test(subject)) return "问卷/反馈";
  if (/graded|feedback|marks?|score/.test(text)) return "成绩/反馈";
  if (/assignment|quiz|assessment|due|deadline|submission/.test(text)) return "作业/测验";
  if (/exam|test/.test(text)) return "考试";
  if (/lecture|lector|seminar|event|workshop|social|scholarship|opportunit/.test(subject)) return "课程/活动";
  if (/canvas|lms/.test(text)) return "Canvas";
  return "通知";
}

export function classifyPersonalMessage(message) {
  const text = `${message.subject}\n${message.from}\n${message.labels || ""}`.toLowerCase();

  if (/security alert|2-step|verification|password|sign-?in|account/.test(text)) {
    return { kind: "账号安全", important: true };
  }
  if (/xref|survey|questionnaire|form|complete the survey/.test(text)) {
    return { kind: "问卷/需确认", important: true };
  }
  if (/anz|bank|interest|statement|payment|invoice|bill/.test(text)) {
    return { kind: "财务", important: true };
  }
  if (/seek|indeed|job|application|interview|recruit/.test(text)) {
    return { kind: "求职", important: true };
  }
  if (/kaggle|course|workshop|webinar|challenge|capstone/.test(text)) {
    return { kind: "学习/活动", important: true };
  }
  if (/gaijin|war thunder|golden eagles|activated a code/.test(text)) {
    return { kind: "游戏账户/消费", important: true };
  }
  if (/order confirmation|receipt|uber|revolut|afterpay|discount|sale|offer|promotion/.test(text)) {
    return { kind: "低优先级", important: false };
  }

  return { kind: "个人邮件", important: true };
}

export function translatePersonalSubject(subject) {
  return String(subject || "")
    .replace(/^Security alert$/i, "Google 安全提醒")
    .replace(/^2-Step Verification turned on$/i, "Google 两步验证已开启")
    .replace(/^We’re updating our interest rates$/i, "ANZ 利率更新")
    .replace(/^We'?re updating our Terms and Privacy Policy$/i, "条款和隐私政策更新")
    .replace(/^Machida Shoten Order Confirmation$/i, "Machida Shoten 订单确认")
    .replace(/^Gaijin\.Net Store: You acquired/i, "Gaijin 商店：你获得了")
    .replace(/^Gaijin\.Net Store: You have activated a code$/i, "Gaijin 商店：你已激活兑换码")
    .replace(/^Fw:\s*/i, "转发：")
    .trim();
}
