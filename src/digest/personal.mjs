import { compactLine } from "./text.mjs";

export function classifyPersonalMessage(message) {
  const text = `${message.subject}\n${message.from}\n${message.labels || ""}`.toLowerCase();

  if (/security alert|verification code|2-step|password|sign-?in|logged in|someone signed|verify your device|identity was just linked|third-party .*application/.test(text)) {
    return {
      kind: "Urgent",
      important: true,
      rank: 0,
      action: "核对账号安全"
    };
  }
  if (/please review|review and confirm|confirm repayment|completion required|required|please .*sign|direct debit|upcoming payment|claim details|form|questionnaire|complete the survey|action required/.test(text)) {
    return {
      kind: "Needs reply",
      important: true,
      rank: 1,
      action: "需要处理/确认"
    };
  }
  if (/application|interview|recruit|residential advisor|seek recommendations|new jobs|job alert/.test(text)) {
    return {
      kind: "FYI",
      important: true,
      rank: 2,
      action: "留意求职/机会信息"
    };
  }
  if (/document|academic statement|accounts successfully linked|finalised|receipt|statement|payment receipt|wifi login|rental agreement/.test(text)) {
    return {
      kind: "FYI",
      important: true,
      rank: 3,
      action: "留档或查看"
    };
  }
  if (/order confirmation|discount|sale|offer|promotion|uber|yakiniku|machida|afterpay|revolut|epic games|优惠|促销|折扣|订餐|生鲜|最多可省/.test(text)) {
    return {
      kind: "Noise",
      important: false,
      rank: 9,
      action: "低优先级"
    };
  }

  return {
    kind: "FYI",
    important: true,
    rank: 4,
    action: "留意"
  };
}

export function formatPersonalItem(message) {
  const classification = classifyPersonalMessage(message);
  const subject = compactLine(message.subject);
  const from = compactLine(message.from);
  const date = compactLine(message.date);
  return `- [${classification.kind}] ${classification.action}：${subject}${from ? `｜${from}` : ""}${date ? `｜${date}` : ""}`;
}
