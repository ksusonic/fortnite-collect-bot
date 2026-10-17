import {
  logEvent,
  errorFields,
  withRequestLogs,
  requestLogId,
} from "./logging";
import { diagnosticTags } from "../sentry-options";
import * as Sentry from "@sentry/nextjs";
import { timingSafeEqual } from "node:crypto";
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function authenticate(provided: string | null, variable: string) {
  const expected = process.env[variable];
  if (!expected) throw new HttpError(503, "endpoint is not configured");
  const left = Buffer.from(provided ?? ""),
    right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    throw new HttpError(401, "unauthorized");
}
export function adminAuth(request: Request) {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) throw new HttpError(401, "unauthorized");
  authenticate(value.slice(7), "CRON_SECRET");
}
export async function endpoint(
  factory: () => Promise<unknown>,
  operation = "http",
): Promise<Response> {
  return withRequestLogs(operation, async () => {
    const started = performance.now();
    logEvent("info", "request.started");
    const headers = {
      "Cache-Control": "no-store",
      "X-Request-ID": requestLogId()!,
    };
    try {
      const result = await factory();
      const response = Response.json(result, { headers });
      logEvent("info", "request.completed", {
        http_status: 200,
        duration_ms: Math.round(performance.now() - started),
      });
      return response;
    } catch (error) {
      if (error instanceof HttpError) {
        logEvent(error.status >= 500 ? "error" : "warn", "request.rejected", {
          http_status: error.status,
          duration_ms: Math.round(performance.now() - started),
        });
        return Response.json(
          { detail: error.message },
          { status: error.status, headers },
        );
      }
      Sentry.captureException(error, {
        tags: { component: "http", ...diagnosticTags(error) },
      });
      logEvent("error", "request.failed", {
        http_status: 503,
        duration_ms: Math.round(performance.now() - started),
        ...errorFields(error),
      });
      return Response.json(
        { detail: "processing incomplete" },
        { status: 503, headers },
      );
    } finally {
      await Sentry.flush(2000);
    }
  });
}
export function requestSignal(request: Request) {
  return AbortSignal.any([request.signal, AbortSignal.timeout(240000)]);
}
