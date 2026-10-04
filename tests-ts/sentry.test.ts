import { afterEach, describe, expect, it, vi } from "vitest";
import {
  diagnosticCode,
  diagnosticTags,
  privacyOptions,
  sanitizeBreadcrumb,
  sanitizeEvent,
  sanitizeSpan,
  sanitizeText,
  SENTRY_DSN,
} from "../src/sentry-options";
import { GET } from "../src/app/api/sentry-example-api/route";

afterEach(() => vi.unstubAllEnvs());
describe("Sentry privacy", () => {
  it("identifies only allowlisted database relations without exposing the error text", () => {
    const error = Object.assign(
      new Error('relation "fortnite_bot.approved_chats" does not exist'),
      { code: "42P01" },
    );
    expect(diagnosticTags(error)).toEqual({
      error_code: "42P01",
      database_relation: "approved_chats",
    });
    expect(
      diagnosticTags(
        Object.assign(
          new Error('relation "private_user_data" does not exist'),
          { code: "42P01" },
        ),
      ),
    ).toEqual({ error_code: "42P01" });
    expect(
      diagnosticTags(
        Object.assign(new Error("private SQL"), {
          code: "DATABASE_SCHEMA_NOT_READY",
        }),
      ),
    ).toEqual({ error_code: "DATABASE_SCHEMA_NOT_READY" });
  });
  it("reports only recognized infrastructure error codes", () => {
    expect(
      diagnosticCode(
        Object.assign(new Error("private payload"), {
          code: "SELF_SIGNED_CERT_IN_CHAIN",
        }),
      ),
    ).toBe("SELF_SIGNED_CERT_IN_CHAIN");
    expect(diagnosticCode({ code: "private-message" })).toBeUndefined();
    expect(diagnosticCode(new Error("Query read timeout"))).toBe(
      "PG_QUERY_READ_TIMEOUT",
    );
    expect(diagnosticCode({ code: "57014" })).toBe("57014");
    expect(diagnosticCode({ code: "unknown" })).toBeUndefined();
    expect(
      diagnosticCode({ error: { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } } }),
    ).toBe("UND_ERR_CONNECT_TIMEOUT");
    const circular: { error?: unknown } = {};
    circular.error = circular;
    expect(diagnosticCode(circular)).toBeUndefined();
    expect(diagnosticCode(new Error("private payload"))).toBeUndefined();
  });
  it("keeps the selected project and disables private data collection", () => {
    expect(new URL(SENTRY_DSN).pathname).toBe("/4512190824513616");
    expect(privacyOptions.sendDefaultPii).toBe(false);
    expect(privacyOptions.tracesSampleRate).toBe(0.1);
    expect(privacyOptions.enableLogs).toBe(true);
    expect(privacyOptions.logsFlushIntervalMs).toBe(0);
    expect(privacyOptions.dataCollection).toMatchObject({
      httpBodies: [],
      httpHeaders: false,
      cookies: false,
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    });
  });
  it("strips URL credentials, Telegram tokens, query strings and bearer tokens", () => {
    const token = "123456:abcdefghijklmnopqrstuvwxyz_ABCD";
    const input = `https://api.telegram.org/bot${token}/sendMessage?chat_id=42 https://user:secret@db.example.com/path?token=private postgresql://owner:password@db.example.com/bot Bearer abc123 ${token}`;
    const clean = sanitizeText(input);
    for (const privateText of [
      token,
      "secret",
      "password",
      "private",
      "abc123",
      "chat_id",
    ])
      expect(clean).not.toContain(privateText);
    expect(clean).toContain("api.telegram.org/bot[Filtered]/sendMessage");
    expect(sanitizeText(`POST /bot${token}/sendMessage?chat_id=42`)).toBe(
      "POST /bot[Filtered]/sendMessage",
    );
  });
  it("preserves stack locations while removing event payloads and exception texts", () => {
    const event = sanitizeEvent({
      type: undefined,
      request: {
        headers: { authorization: "secret" },
        data: { text: "private-message" },
      },
      user: { username: "Alice" },
      extra: { chat_id: 42 },
      message: "Alice private-message",
      contexts: {
        custom: { payload: "private-message" },
        trace: {
          trace_id: "trace",
          span_id: "span",
          data: { "db.query.text": "INSERT private-message" },
        },
      },
      exception: {
        values: [
          {
            type: "GrammyError",
            value: "Alice private-message",
            mechanism: {
              type: "generic",
              handled: true,
              data: { payload: "private-message" },
            },
            stacktrace: {
              frames: [
                {
                  filename: "src/bot/runtime.ts",
                  function: "executeItem",
                  lineno: 44,
                  vars: { token: "secret" },
                },
              ],
            },
          },
        ],
      },
    });
    const payload = JSON.stringify(event);
    for (const privateText of [
      "Alice",
      "private-message",
      "secret",
      "chat_id",
      "INSERT",
    ])
      expect(payload).not.toContain(privateText);
    expect(event.exception?.values?.[0].value).toBe("GrammyError");
    expect(event.exception?.values?.[0].stacktrace?.frames?.[0]).toMatchObject({
      filename: "src/bot/runtime.ts",
      function: "executeItem",
      lineno: 44,
    });
  });
  it("removes SQL and bound values from streamed spans", () => {
    const result = sanitizeSpan({
      name: "SELECT private-message",
      attributes: {
        "sentry.op": "db",
        "db.query.text": "SELECT private-message",
        "db.query.parameters": ["Alice"],
        "db.system.name": "postgresql",
      },
      trace_id: "trace",
      span_id: "span",
      status: "ok",
      start_timestamp: 1,
      is_segment: false,
    });
    expect(result.name).toBe("Database operation");
    expect(result.attributes).toEqual({
      "sentry.op": "db",
      "db.system.name": "postgresql",
    });
    expect(JSON.stringify(result)).not.toContain("Alice");
  });
  it("drops console and UI breadcrumbs and all breadcrumb payloads", () => {
    expect(
      sanitizeBreadcrumb({ category: "console", message: "private-message" }),
    ).toBeNull();
    expect(
      sanitizeBreadcrumb({ category: "ui.click", message: "Alice" }),
    ).toBeNull();
    expect(
      sanitizeBreadcrumb({
        category: "custom",
        message: "Alice",
        data: { token: "secret" },
      }),
    ).toEqual({ category: "custom", message: undefined, data: undefined });
  });
  it("removes SQL and HTTP secrets from transaction spans", () => {
    const result = sanitizeEvent({
      type: "transaction",
      spans: [
        {
          span_id: "db",
          trace_id: "trace",
          status: "ok",
          start_timestamp: 1,
          description: "SELECT Alice",
          data: {
            "db.system.name": "postgresql",
            "db.query.text": "SELECT Alice",
          },
        },
        {
          span_id: "http",
          trace_id: "trace",
          status: "ok",
          start_timestamp: 1,
          op: "http.client",
          description:
            "POST /bot123456:abcdefghijklmnopqrstuvwxyz_ABCD/sendMessage?chat_id=42",
          data: {
            "http.request.method": "POST",
            "http.request.body": "private-message",
          },
        },
      ],
    });
    expect(result.spans?.[0].description).toBe("Database operation");
    expect(result.spans?.[1].description).toBe(
      "POST /bot[Filtered]/sendMessage",
    );
    expect(JSON.stringify(result)).not.toMatch(
      /Alice|private-message|chat_id|abcdefghijklmnopqrstuvwxyz/,
    );
  });
  it("keeps the generated error endpoint local to development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await GET()).status).toBe(404);
    vi.stubEnv("NODE_ENV", "development");
    await expect(GET()).rejects.toThrow("Sentry backend verification");
  });
});
