import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { requestJsonWithRetry } from "../src/telegram/http.mjs";

// 造一个可控的 https.request：按预设的状态码序列逐次应答。
function fakeRequest(statusCodes, calls) {
  return (url, options, handler) => {
    calls.push({ url: String(url), method: options.method });
    const statusCode = statusCodes[calls.length - 1] ?? 200;
    const req = new EventEmitter();
    req.write = () => {};
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      const response = new EventEmitter();
      response.statusCode = statusCode;
      setImmediate(() => {
        response.emit("data", Buffer.from(JSON.stringify({ ok: statusCode === 200 })));
        response.emit("end");
      });
      handler(response);
    };
    return req;
  };
}

test("发送遇到 500 会重试，第三次成功就当作成功", async () => {
  // 没有重试的时候，一次抖动或 429 就把那条回复永久丢掉：命令其实执行了，
  // 结果永远不会来，而且 offset 已落盘、Telegram 不重投，等也没用。
  const calls = [];
  const result = await requestJsonWithRetry(
    "https://api.telegram.org/botX/sendMessage",
    { method: "POST", requestImpl: fakeRequest([500, 500, 200], calls) },
    { delayMs: 1, sleep: async () => {} }
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 3, "应当正好试三次");
});

test("三次都失败就抛出去，不无限重试", async () => {
  const calls = [];
  await assert.rejects(
    () => requestJsonWithRetry(
      "https://api.telegram.org/botX/sendMessage",
      { method: "POST", requestImpl: fakeRequest([500, 500, 500], calls) },
      { delayMs: 1, sleep: async () => {} }
    ),
    /500/
  );
  assert.equal(calls.length, 3, "不能超过三次");
});

test("退避是递增的 —— 1 倍、2 倍", async () => {
  const calls = [];
  const waits = [];
  await requestJsonWithRetry(
    "https://api.telegram.org/botX/sendMessage",
    { method: "POST", requestImpl: fakeRequest([429, 429, 200], calls) },
    { delayMs: 1000, sleep: async (ms) => { waits.push(ms); } }
  );

  assert.deepEqual(waits, [1000, 2000]);
});

test("一次就成功时不会有多余的请求", async () => {
  const calls = [];
  await requestJsonWithRetry(
    "https://api.telegram.org/botX/sendMessage",
    { method: "POST", requestImpl: fakeRequest([200], calls) },
    { delayMs: 1, sleep: async () => {} }
  );
  assert.equal(calls.length, 1);
});
