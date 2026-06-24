import path from "node:path";
import { pathToFileURL } from "node:url";
import { reportFatalSchoolCheckError, runSchoolCheckCli } from "./school/workflow.mjs";

export { zonedParts, dateKeyInZone, minutesInZone, parseClock, dueSlots } from "./school/schedule.mjs";
export { classifySchoolMessage, classifyPersonalMessage, translatePersonalSubject } from "./school/classifiers.mjs";
export { MONTHS, monthNumber, to24Hour, localTimeToUtc, extractYearFallback, extractDeadlinesFromMessage, collectDeadlines } from "./school/deadlines.mjs";
export { runGmailExport, runOutlookExport } from "./school/exporters.mjs";
export { gameKey, countGameSources, translateGameTitle, gamePrefix } from "./school/game-news.mjs";
export { parseGmailSnapshot, parseOutlookSnapshot, personalMessagesFromDrops, schoolMessagesFromDrops } from "./school/mail-drops.mjs";
export { sendOrPrint } from "./school/notifier.mjs";
export { compactLine, parseField, formatSchoolSummary, formatPersonalSummary } from "./school/summaries.mjs";
export { loadState, saveState, statePath } from "./school/state.mjs";
export { reportFatalSchoolCheckError, runSchoolCheckCli };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSchoolCheckCli().catch(reportFatalSchoolCheckError);
}
