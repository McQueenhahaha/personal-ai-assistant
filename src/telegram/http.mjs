import { request as httpsRequest } from "node:https";

const ERROR_BODY_LIMIT = 1000;

function resolveFamily(family) {
  const configured = family ?? process.env.TELEGRAM_IP_FAMILY ?? 4;
  const numeric = Number(configured);
  if (numeric !== 4 && numeric !== 6) {
    throw new TypeError("Telegram IP family must be 4 or 6");
  }
  return numeric;
}

function hasHeader(headers, name) {
  const expected = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === expected);
}

function responseSnippet(body) {
  return body.slice(0, ERROR_BODY_LIMIT);
}

/**
 * 带重试的发送。
 *
 * 没有它的时候，一次网络抖动或 429 限流就把那条回复**永久**丢掉：命令其实
 * 执行了（/sfc_scan 真跑了、Codex 真改了代码），只是结果永远不会来。而且
 * offset 现在是先落盘再处理（at-most-once），Telegram 不会重投，等也没用。
 * 桥这边更狠 —— send 抛出后连"命令执行失败"那条回执本身也发不出去，
 * 最后只在本机日志里留一行。
 *
 * 429 是真实存在的形状：/study 的结果按 3500 字分片连发、/digest 长文分片，
 * 都会在一两秒内连打好几条 sendMessage。
 *
 * **刻意不塞进 requestJson 本身**：fetchUpdates 也用它，而拉取那条链路已经有
 * consecutiveFailures 计数和告警阈值，双层重试会把阈值语义搅乱。
 *
 * 不解析 429 的 retry_after：单聊天机器人的 retry_after 通常 1~3 秒，
 * 1s/2s 两次退避已经覆盖，为它加解析属于投机设计。
 */
export async function requestJsonWithRetry(url, options = {}, {
  attempts = 3,
  delayMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestJson(url, options);
    } catch (error) {
      lastError = error;
      // 最后一次失败就把原错误原样抛出去，不要包一层 —— 上层还要靠它的文字判断。
      if (attempt === attempts) break;
      await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

export async function requestJson(url, {
  method = "GET",
  body,
  headers = {},
  timeoutMs = 30000,
  family,
  requestImpl = httpsRequest
} = {}) {
  const requestHeaders = { ...headers };
  let payload;

  if (body !== undefined) {
    payload = Buffer.isBuffer(body) || typeof body === "string"
      ? body
      : JSON.stringify(body);
    if (!Buffer.isBuffer(body) && typeof body !== "string" && !hasHeader(requestHeaders, "content-type")) {
      requestHeaders["Content-Type"] = "application/json";
    }
    if (!hasHeader(requestHeaders, "content-length")) {
      requestHeaders["Content-Length"] = Buffer.byteLength(payload);
    }
  }

  return new Promise((resolve, reject) => {
    let req;
    try {
      req = requestImpl(new URL(url), {
        method,
        headers: requestHeaders,
        family: resolveFamily(family)
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`Telegram HTTP request failed ${statusCode}: ${responseSnippet(responseBody)}`));
            return;
          }

          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(new Error(
              `Telegram HTTP response was not valid JSON: ${responseSnippet(responseBody)}`,
              { cause: error }
            ));
          }
        });
        response.on("error", reject);
      });
    } catch (error) {
      reject(error);
      return;
    }

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      const error = new Error(`Telegram HTTP request timed out after ${timeoutMs}ms`);
      req.destroy(error);
      reject(error);
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
