import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestJson } from "../src/telegram/http.mjs";

function fakeRequest({ statusCode = 200, responseBody = "{}", timeout = false } = {}) {
  const calls = [];
  const requestImpl = (url, options, onResponse) => {
    const call = { url, options, writes: [] };
    calls.push(call);
    const request = new EventEmitter();
    request.write = (chunk) => call.writes.push(Buffer.from(chunk));
    request.setTimeout = (timeoutMs, onTimeout) => {
      call.timeoutMs = timeoutMs;
      if (timeout) queueMicrotask(onTimeout);
    };
    request.destroy = (error) => {
      call.destroyError = error;
      queueMicrotask(() => request.emit("error", error));
    };
    request.end = () => {
      if (timeout) return;
      const response = new EventEmitter();
      response.statusCode = statusCode;
      queueMicrotask(() => {
        onResponse(response);
        if (responseBody) response.emit("data", responseBody);
        response.emit("end");
      });
    };
    return request;
  };
  return { calls, requestImpl };
}

function restoreFamily(value) {
  if (value === undefined) delete process.env.TELEGRAM_IP_FAMILY;
  else process.env.TELEGRAM_IP_FAMILY = value;
}

test("requestJson builds a JSON POST with IPv4 and timeout defaults", async (t) => {
  const previousFamily = process.env.TELEGRAM_IP_FAMILY;
  t.after(() => restoreFamily(previousFamily));
  delete process.env.TELEGRAM_IP_FAMILY;
  const fake = fakeRequest({ responseBody: JSON.stringify({ ok: true }) });

  assert.deepEqual(await requestJson("https://api.telegram.org/bot-token/sendMessage", {
    method: "POST",
    headers: { "X-Test": "yes" },
    body: { text: "hello" },
    requestImpl: fake.requestImpl
  }), { ok: true });

  const [call] = fake.calls;
  assert.equal(call.url.href, "https://api.telegram.org/bot-token/sendMessage");
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.family, 4);
  assert.equal(call.options.headers["X-Test"], "yes");
  assert.equal(call.options.headers["Content-Type"], "application/json");
  assert.equal(call.options.headers["Content-Length"], 16);
  assert.equal(Buffer.concat(call.writes).toString("utf8"), JSON.stringify({ text: "hello" }));
  assert.equal(call.timeoutMs, 30000);
});

test("requestJson uses TELEGRAM_IP_FAMILY and lets an explicit family override it", async (t) => {
  const previousFamily = process.env.TELEGRAM_IP_FAMILY;
  t.after(() => restoreFamily(previousFamily));
  process.env.TELEGRAM_IP_FAMILY = "6";
  const fake = fakeRequest();

  await requestJson("https://api.telegram.org/test", { requestImpl: fake.requestImpl });
  await requestJson("https://api.telegram.org/test", {
    family: 4,
    requestImpl: fake.requestImpl
  });

  assert.equal(fake.calls[0].options.family, 6);
  assert.equal(fake.calls[1].options.family, 4);
});

test("requestJson sends a multipart Buffer without JSON encoding it", async () => {
  const fake = fakeRequest();
  const body = Buffer.from("--boundary\r\nfile bytes\r\n--boundary--\r\n");

  await requestJson("https://api.telegram.org/test", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=boundary" },
    body,
    requestImpl: fake.requestImpl
  });

  assert.equal(fake.calls[0].options.headers["Content-Length"], body.length);
  assert.deepEqual(Buffer.concat(fake.calls[0].writes), body);
});

test("requestJson destroys and rejects a timed-out request", async () => {
  const fake = fakeRequest({ timeout: true });

  await assert.rejects(
    requestJson("https://api.telegram.org/test", {
      timeoutMs: 25,
      requestImpl: fake.requestImpl
    }),
    /timed out after 25ms/
  );
  assert.match(fake.calls[0].destroyError.message, /timed out after 25ms/);
});

test("requestJson rejects non-2xx responses with a body snippet", async () => {
  const fake = fakeRequest({ statusCode: 502, responseBody: "bad gateway" });

  await assert.rejects(
    requestJson("https://api.telegram.org/test", { requestImpl: fake.requestImpl }),
    /failed 502: bad gateway/
  );
});

test("requestJson reports invalid JSON responses", async () => {
  const fake = fakeRequest({ responseBody: "not-json" });

  await assert.rejects(
    requestJson("https://api.telegram.org/test", { requestImpl: fake.requestImpl }),
    /response was not valid JSON: not-json/
  );
});
