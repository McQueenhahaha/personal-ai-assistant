import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canvasGet,
  findAssignments,
  getAssignmentDetail,
  htmlToText,
  listActiveCourses,
  listUpcomingAssignments
} from "../src/canvas/api.mjs";

const nowMs = Date.parse("2026-08-01T00:00:00.000Z");

function jsonResponse(value, { headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}

function fakeCanvas() {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });

    if (url.pathname === "/api/v1/courses" && url.searchParams.get("page") === "2") {
      return jsonResponse([
        { id: 3, course_code: "ENGR2002", name: "Systems Engineering" }
      ]);
    }
    if (url.pathname === "/api/v1/courses") {
      return jsonResponse([
        { id: 1, course_code: "ENGR1001", name: "Engineering Structures" },
        { id: 2, course_code: "SAFE0001", name: "Laboratory Safety Awareness" },
        { id: 4, course_code: "ORIENT1000", name: "Student Induction" },
        { id: 5, course_code: "BENG", name: "Bachelor of Engineering" },
        { id: 6, course_code: "Consent", name: "Sex and Consent for International Students" }
      ], {
        headers: {
          Link: "<https://canvas.test/api/v1/courses?enrollment_state=active&page=2>; rel=\"next\""
        }
      });
    }
    if (url.pathname === "/api/v1/courses/1/assignments") {
      return jsonResponse([
        {
          id: 101,
          name: "Group design report",
          due_at: "2026-08-06T00:00:00.000Z",
          html_url: "https://canvas.test/courses/1/assignments/101",
          points_possible: 35,
          submission: { workflow_state: "unsubmitted", submitted_at: null }
        },
        {
          id: 102,
          name: "Already overdue",
          due_at: "2026-07-31T00:00:00.000Z",
          html_url: "https://canvas.test/courses/1/assignments/102",
          points_possible: 10,
          submission: { workflow_state: "unsubmitted" }
        },
        {
          id: 103,
          name: "Outside window",
          due_at: "2026-08-30T00:00:00.000Z",
          html_url: "https://canvas.test/courses/1/assignments/103",
          points_possible: 5,
          submission: { workflow_state: "unsubmitted" }
        },
        {
          id: 104,
          name: "ENGR1001 Quiz",
          due_at: "2026-08-25T00:00:00.000Z",
          html_url: "https://canvas.test/courses/1/assignments/104",
          points_possible: 10,
          submission: { workflow_state: "unsubmitted" }
        }
      ]);
    }
    if (url.pathname === "/api/v1/courses/3/assignments") {
      return jsonResponse([
        {
          id: 301,
          name: "System engineering group assessment",
          due_at: "2026-08-03T00:00:00.000Z",
          html_url: "https://canvas.test/courses/3/assignments/301",
          points_possible: 20,
          submission: { workflow_state: "graded", submitted_at: "2026-08-01T01:00:00Z" }
        },
        {
          id: 302,
          name: "No due date",
          due_at: null,
          html_url: "https://canvas.test/courses/3/assignments/302",
          points_possible: null,
          submission: null
        }
      ]);
    }
    if (url.pathname === "/api/v1/courses/3/assignments/301") {
      return jsonResponse({
        id: 301,
        name: "System engineering group assessment",
        description: "<p>Build &amp; verify the model.</p><ul><li>Submit one PDF&nbsp;per group.</li></ul><script>ignore()</script>",
        due_at: "2026-08-03T00:00:00.000Z",
        html_url: "https://canvas.test/courses/3/assignments/301",
        points_possible: 20,
        submission: {
          workflow_state: "submitted",
          submitted_at: "2026-08-01T01:00:00.000Z",
          score: null,
          grade: null
        },
        rubric: [{
          id: "criterion-1",
          description: "<b>Requirements</b>",
          long_description: "Trace every requirement &gt; design element",
          points: 8,
          ratings: [{ description: "Complete", long_description: "All traced", points: 8 }]
        }]
      });
    }

    throw new Error(`Unexpected Canvas URL: ${url.href}`);
  };
  return { calls, fetchImpl };
}

test("canvasGet follows at most three same-origin next pages", async () => {
  process.env.CANVAS_API_TOKEN = "test-token-value";
  process.env.CANVAS_BASE_URL = "https://canvas.test";
  const pages = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    const page = Number(url.searchParams.get("page") || 1);
    pages.push(page);
    return jsonResponse([page], {
      headers: {
        Link: `<https://canvas.test/api/v1/items?page=${page + 1}>; rel="next"`
      }
    });
  };

  assert.deepEqual(await canvasGet("/api/v1/items?page=1", { fetchImpl }), [1, 2, 3]);
  assert.deepEqual(pages, [1, 2, 3]);
});

test("listActiveCourses follows pagination and heuristically removes noise courses", async (t) => {
  const oldToken = process.env.CANVAS_API_TOKEN;
  const oldBaseUrl = process.env.CANVAS_BASE_URL;
  process.env.CANVAS_API_TOKEN = "test-token-value";
  process.env.CANVAS_BASE_URL = "https://canvas.test";
  t.after(() => {
    if (oldToken == null) delete process.env.CANVAS_API_TOKEN;
    else process.env.CANVAS_API_TOKEN = oldToken;
    if (oldBaseUrl == null) delete process.env.CANVAS_BASE_URL;
    else process.env.CANVAS_BASE_URL = oldBaseUrl;
  });
  const { calls, fetchImpl } = fakeCanvas();

  assert.deepEqual(await listActiveCourses({ fetchImpl }), [
    { id: 1, code: "ENGR1001", name: "Engineering Structures" },
    { id: 3, code: "ENGR2002", name: "Systems Engineering" }
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls.every(({ options }) => options.method === "GET"), true);
  assert.equal(calls.every(({ options }) => options.headers.Authorization === "Bearer test-token-value"), true);
});

test("listUpcomingAssignments sorts, excludes overdue/out-of-window items, and reports submission", async () => {
  process.env.CANVAS_API_TOKEN = "test-token-value";
  process.env.CANVAS_BASE_URL = "https://canvas.test";
  const { fetchImpl } = fakeCanvas();

  const assignments = await listUpcomingAssignments({ withinDays: 21, nowMs, fetchImpl });

  assert.deepEqual(assignments.map(({ id }) => id), [301, 101]);
  assert.equal(assignments[0].courseCode, "ENGR2002");
  assert.equal(assignments[0].submitted, true);
  assert.equal(assignments[0].pointsPossible, 20);
  assert.equal(assignments[1].submitted, false);
  assert.equal("courseId" in assignments[0], false);
});

test("HTML conversion and getAssignmentDetail return compact plain objects", async () => {
  process.env.CANVAS_API_TOKEN = "test-token-value";
  process.env.CANVAS_BASE_URL = "https://canvas.test";
  const { fetchImpl } = fakeCanvas();

  assert.equal(htmlToText("<p>A&nbsp;&amp; B</p><br> C &#x2713;"), "A & B C ✓");
  const detail = await getAssignmentDetail(3, 301, { fetchImpl });
  assert.equal(detail.description, "Build & verify the model. Submit one PDF per group.");
  assert.equal(detail.submission.submitted, true);
  assert.equal(detail.rubric[0].description, "Requirements");
  assert.equal(detail.rubric[0].longDescription, "Trace every requirement > design element");
  assert.deepEqual(detail.rubric[0].ratings[0], {
    description: "Complete",
    longDescription: "All traced",
    points: 8
  });
});

test("findAssignments matches a natural-language course and assignment query", async () => {
  process.env.CANVAS_API_TOKEN = "test-token-value";
  process.env.CANVAS_BASE_URL = "https://canvas.test";
  const { fetchImpl } = fakeCanvas();

  const candidates = await findAssignments("system engineering 的 group assessment 要干嘛", {
    nowMs,
    fetchImpl
  });
  assert.equal(candidates[0].courseId, 3);
  assert.equal(candidates[0].id, 301);
  assert.equal(candidates[0].name, "System engineering group assessment");

  const outsideWindow = await findAssignments("outside window", { nowMs, fetchImpl });
  assert.equal(outsideWindow[0].id, 103);

  const courseOnly = await findAssignments("ENGR1001 最近的作业", { nowMs, fetchImpl });
  assert.equal(courseOnly[0].id, 101);
});
