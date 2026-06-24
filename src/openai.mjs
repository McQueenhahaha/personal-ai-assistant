import { buildDigest, digestLooksReasonable, outputText, sectionBulletCount } from "./digest/ai.mjs";

export { buildDigest, digestLooksReasonable, outputText, sectionBulletCount };

export { buildDeterministicDigest } from "./digest/deterministic.mjs";
export { DIGEST_SECTION_LIMIT, REQUIRED_SECTIONS } from "./digest/constants.mjs";
export { compactLine } from "./digest/text.mjs";
export { classifyPersonalMessage, formatPersonalItem, rankedPersonalMessages } from "./digest/personal.mjs";
export { buildTodoItems } from "./digest/todos.mjs";
export { classifySchoolMessage, formatSchoolItem, translateSchoolTitle } from "./digest/school.mjs";
export { formatGameItem, gamePrefix, translateGameTitle } from "./digest/games.mjs";
export {
  fieldValue,
  readMessageSource,
  parseGmailSnapshot,
  parseOutlookSnapshot,
  messageDateMs,
  normalizeMailMessages
} from "./digest/mail.mjs";
