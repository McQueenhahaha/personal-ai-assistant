import { loadEnv } from "../env.mjs";

const MAX_PAGES = 3;

// Heuristic only: keep this list easy to extend when a school adds non-academic courses.
export const NOISE_PATTERNS = [
  /\binduction\b/i,
  /\bsafety\b/i,
  /\bawareness\b/i,
  /\bhow\s*2\b/i,
  /\bsex\s+and\s+consent\b/i,
  /\bbachelor\s+of\s+engineering\b/i
];

export class CanvasApiError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = "CanvasApiError";
    this.status = status;
  }
}

function canvasConfig() {
  loadEnv();
  const token = String(process.env.CANVAS_API_TOKEN || "").trim();
  const baseUrlText = String(process.env.CANVAS_BASE_URL || "").trim();

  if (!token) {
    throw new CanvasApiError("CANVAS_API_TOKEN 未配置，无法读取 Canvas API");
  }
  if (!baseUrlText) {
    throw new CanvasApiError("CANVAS_BASE_URL 未配置，无法读取 Canvas API");
  }

  let baseUrl;
  try {
    baseUrl = new URL(baseUrlText);
  } catch {
    throw new CanvasApiError("CANVAS_BASE_URL 不是有效网址");
  }

  return {
    token,
    baseUrl: new URL(baseUrl.pathname.endsWith("/") ? baseUrl.href : `${baseUrl.href}/`)
  };
}

function nextLink(linkHeader) {
  for (const part of String(linkHeader || "").split(",")) {
    const match = part.match(/<([^>]+)>\s*;[^,]*\brel\s*=\s*"?next"?/i);
    if (match) return match[1];
  }
  return "";
}

export async function canvasGet(pathAndQuery, { fetchImpl = fetch } = {}) {
  const { token, baseUrl } = canvasConfig();
  let requestUrl = new URL(String(pathAndQuery || ""), baseUrl);
  const collected = [];
  let singleResult;
  let sawArray = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (requestUrl.origin !== baseUrl.origin) {
      throw new CanvasApiError("Canvas 分页链接指向了不同站点，已拒绝携带 token 请求");
    }

    let response;
    try {
      response = await fetchImpl(requestUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        }
      });
    } catch (error) {
      throw new CanvasApiError(`Canvas API 网络请求失败：${error.message || String(error)}`);
    }

    if (!response.ok) {
      const label = response.statusText ? ` ${response.statusText}` : "";
      throw new CanvasApiError(`Canvas API 请求失败（${response.status}${label}）`, {
        status: response.status
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new CanvasApiError("Canvas API 返回了无效 JSON");
    }

    if (Array.isArray(payload)) {
      sawArray = true;
      collected.push(...payload);
    } else {
      singleResult = payload;
    }

    const next = nextLink(response.headers.get("link"));
    if (!next) break;
    requestUrl = new URL(next, requestUrl);
  }

  return sawArray ? collected : singleResult;
}

function decodeEntity(entity) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\""
  };
  const body = entity.slice(1, -1);
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const codePoint = Number.parseInt(body.slice(2), 16);
    return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  }
  if (body.startsWith("#")) {
    const codePoint = Number.parseInt(body.slice(1), 10);
    return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  }
  return named[body.toLowerCase()] ?? entity;
}

export function htmlToText(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, " ")
    .replace(/<\/\s*(?:div|p|li|h[1-6]|tr)\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:#\d+|#x[0-9a-f]+|amp|apos|gt|lt|nbsp|quot);/gi, decodeEntity)
    .replace(/\s+/g, " ")
    .trim();
}

function slimCourse(course) {
  return {
    id: course.id,
    code: String(course.course_code || course.sis_course_id || "").trim(),
    name: String(course.name || "").trim()
  };
}

function isAcademicCourse(course) {
  const searchable = `${course.name || ""} ${course.course_code || ""}`;
  return !NOISE_PATTERNS.some((pattern) => pattern.test(searchable));
}

export async function listActiveCourses({ fetchImpl } = {}) {
  const courses = await canvasGet(
    "/api/v1/courses?enrollment_state=active&per_page=100",
    { fetchImpl }
  );
  return courses.filter(isAcademicCourse).map(slimCourse);
}

function isSubmitted(submission) {
  if (!submission || typeof submission !== "object") return false;
  if (submission.submitted_at) return true;
  return ["submitted", "graded", "pending_review"].includes(submission.workflow_state);
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function slimAssignment(course, assignment) {
  const parsedDueAtMs = Date.parse(assignment.due_at || "");
  return {
    courseId: course.id,
    courseCode: course.code,
    courseName: course.name,
    id: assignment.id,
    name: String(assignment.name || "").trim(),
    dueAtMs: Number.isFinite(parsedDueAtMs) ? parsedDueAtMs : null,
    url: String(assignment.html_url || ""),
    submitted: isSubmitted(assignment.submission),
    pointsPossible: finiteNumber(assignment.points_possible)
  };
}

async function loadCourseAssignments({ fetchImpl, courses }) {
  const activeCourses = courses || await listActiveCourses({ fetchImpl });
  const perCourse = await Promise.all(activeCourses.map(async (course) => {
    const courseId = encodeURIComponent(course.id);
    const assignments = await canvasGet(
      `/api/v1/courses/${courseId}/assignments?order_by=due_at&include%5B%5D=submission&per_page=100`,
      { fetchImpl }
    );
    return assignments.map((assignment) => slimAssignment(course, assignment));
  }));

  return perCourse.flat();
}

async function loadUpcomingAssignments({ withinDays, nowMs, fetchImpl, courses }) {
  const cutoffMs = nowMs + (Math.max(0, Number(withinDays) || 0) * 86400000);
  return (await loadCourseAssignments({ fetchImpl, courses }))
    .filter(({ dueAtMs }) => Number.isFinite(dueAtMs) && dueAtMs > nowMs && dueAtMs <= cutoffMs)
    .sort((a, b) => a.dueAtMs - b.dueAtMs);
}

function publicAssignment(assignment) {
  const publicFields = { ...assignment };
  delete publicFields.courseId;
  return publicFields;
}

export async function listUpcomingAssignments({
  withinDays = 21,
  nowMs = Date.now(),
  fetchImpl,
  courses
} = {}) {
  const assignments = await loadUpcomingAssignments({ withinDays, nowMs, fetchImpl, courses });
  return assignments.map(publicAssignment);
}

function slimRubric(rubric) {
  if (!Array.isArray(rubric)) return [];
  return rubric.map((criterion) => ({
    id: criterion.id,
    description: htmlToText(criterion.description),
    longDescription: htmlToText(criterion.long_description),
    pointsPossible: finiteNumber(criterion.points),
    ratings: Array.isArray(criterion.ratings)
      ? criterion.ratings.map((rating) => ({
          description: htmlToText(rating.description),
          longDescription: htmlToText(rating.long_description),
          points: finiteNumber(rating.points)
        }))
      : []
  }));
}

function slimSubmission(submission) {
  const value = submission && typeof submission === "object" ? submission : null;
  return {
    submitted: isSubmitted(value),
    state: String(value?.workflow_state || "unsubmitted"),
    submittedAtMs: value?.submitted_at ? Date.parse(value.submitted_at) : null,
    gradedAtMs: value?.graded_at ? Date.parse(value.graded_at) : null,
    score: finiteNumber(value?.score),
    grade: value?.grade == null ? null : String(value.grade)
  };
}

export async function getAssignmentDetail(courseId, assignmentId, { fetchImpl } = {}) {
  const assignment = await canvasGet(
    `/api/v1/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}?include%5B%5D=submission`,
    { fetchImpl }
  );
  const dueAtMs = Date.parse(assignment.due_at || "");
  return {
    id: assignment.id,
    name: String(assignment.name || "").trim(),
    description: htmlToText(assignment.description),
    rubric: slimRubric(assignment.rubric),
    submission: slimSubmission(assignment.submission),
    dueAtMs: Number.isFinite(dueAtMs) ? dueAtMs : null,
    url: String(assignment.html_url || ""),
    pointsPossible: finiteNumber(assignment.points_possible)
  };
}

function normalizedTerms(text) {
  const ignored = new Set(["canvas", "帮我", "看下", "看一下", "查看", "最近", "要求", "什么", "怎么"]);
  return String(text || "")
    .toLowerCase()
    .match(/[a-z]{2,}|\d+|[\u3400-\u9fff]{2,}/g)
    ?.filter((term) => !ignored.has(term)) || [];
}

function matchScore(query, assignment) {
  const input = String(query || "").toLowerCase();
  const queriedCourseCodes = input.match(/\b[a-z]{4}\d{4}\b/g) || [];
  const courseCode = assignment.courseCode.toLowerCase();
  const courseName = assignment.courseName.toLowerCase();
  const assignmentName = assignment.name.toLowerCase();
  let score = 0;

  if (courseCode && input.includes(courseCode)) score += 100;
  if (assignmentName.length >= 4 && input.includes(assignmentName)) score += 60;
  const terms = normalizedTerms(query).filter(
    (term) => !queriedCourseCodes.some((queriedCode) => queriedCode.includes(term))
  );
  for (const term of terms) {
    if (assignmentName.includes(term)) score += 12;
    if (courseName.includes(term)) score += 8;
    if (courseCode.includes(term)) score += 8;
  }
  return score;
}

export async function findAssignments(query, {
  fetchImpl,
  nowMs = Date.now(),
  courses,
  assignments
} = {}) {
  const activeCourses = courses || await listActiveCourses({ fetchImpl });
  const searchableAssignments = assignments || await loadCourseAssignments({
    fetchImpl,
    courses: activeCourses
  });
  const courseByCode = new Map(activeCourses.map((course) => [course.code.toLowerCase(), course]));

  return searchableAssignments
    .map((assignment) => {
      const course = courseByCode.get(assignment.courseCode.toLowerCase());
      return {
        ...assignment,
        courseId: course?.id,
        matchScore: matchScore(query, assignment)
      };
    })
    .filter(({ courseId, matchScore: score }) => courseId != null && score > 0)
    .sort((a, b) => {
      const scoreDifference = b.matchScore - a.matchScore;
      if (scoreDifference !== 0) return scoreDifference;

      const aFuture = Number.isFinite(a.dueAtMs) && a.dueAtMs >= nowMs;
      const bFuture = Number.isFinite(b.dueAtMs) && b.dueAtMs >= nowMs;
      if (aFuture !== bFuture) return aFuture ? -1 : 1;
      if (aFuture) return a.dueAtMs - b.dueAtMs;

      const aPast = Number.isFinite(a.dueAtMs);
      const bPast = Number.isFinite(b.dueAtMs);
      if (aPast !== bPast) return aPast ? -1 : 1;
      return aPast ? b.dueAtMs - a.dueAtMs : 0;
    });
}
