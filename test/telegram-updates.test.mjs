import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchUpdates, nextOffset, parseUpdates } from "../src/telegram/updates.mjs";

test("parseUpdates converts and sorts Telegram text messages", () => {
  const messages = parseUpdates([
    {
      update_id: 12,
      message: { message_id: 9, date: 200, chat: { id: -123 }, text: "later" }
    },
    {
      update_id: 10,
      message: { message_id: 8, date: 100, chat: { id: 456 }, text: "first" }
    },
    {
      update_id: 11,
      message: { message_id: 7, date: 200, chat: { id: -123 }, text: "earlier tie" }
    }
  ]);

  assert.deepEqual(messages, [
    { key: "456:8", chatId: "456", messageId: 8, date: 100, text: "first" },
    { key: "-123:7", chatId: "-123", messageId: 7, date: 200, text: "earlier tie" },
    { key: "-123:9", chatId: "-123", messageId: 9, date: 200, text: "later" }
  ]);
});

test("parseUpdates ignores updates without message text", () => {
  assert.deepEqual(parseUpdates([
    { update_id: 1, message: { message_id: 1, date: 1, chat: { id: 2 }, photo: [] } },
    { update_id: 2, edited_message: { message_id: 2, date: 2, chat: { id: 2 }, text: "edited" } },
    { update_id: 3, callback_query: { data: "button" } }
  ]), []);
});

test("nextOffset keeps the current offset for an empty update list", () => {
  assert.equal(nextOffset([], 42), 42);
});

test("nextOffset advances past the largest update id", () => {
  assert.equal(nextOffset([
    { update_id: 8 },
    { update_id: 12 },
    { update_id: 10 }
  ], 4), 13);
});

test("fetchUpdates sends long-polling parameters and returns raw updates", async () => {
  const expected = [{ update_id: 21, message: { text: "hello" } }];
  let requestedUrl;
  const fetchImpl = async (url) => {
    requestedUrl = new URL(url);
    return {
      ok: true,
      async json() {
        return { ok: true, result: expected };
      }
    };
  };

  assert.equal(await fetchUpdates({
    token: "test-token",
    offset: 17,
    timeoutSeconds: 31,
    fetchImpl
  }), expected);
  assert.equal(requestedUrl.pathname, "/bottest-token/getUpdates");
  assert.equal(requestedUrl.searchParams.get("offset"), "17");
  assert.equal(requestedUrl.searchParams.get("timeout"), "31");
  assert.deepEqual(JSON.parse(requestedUrl.searchParams.get("allowed_updates")), ["message"]);
});

test("fetchUpdates propagates network errors", async () => {
  const networkError = new Error("offline");
  await assert.rejects(
    fetchUpdates({
      token: "test-token",
      offset: 0,
      fetchImpl: async () => { throw networkError; }
    }),
    networkError
  );
});

test("fetchUpdates throws on HTTP errors", async () => {
  await assert.rejects(
    fetchUpdates({
      token: "test-token",
      offset: 0,
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        async text() { return "bad gateway"; }
      })
    }),
    /Telegram getUpdates failed 502: bad gateway/
  );
});
