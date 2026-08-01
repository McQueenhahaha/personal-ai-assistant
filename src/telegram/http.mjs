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
