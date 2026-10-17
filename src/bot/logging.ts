import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { diagnosticCode, diagnosticTags } from "../sentry-options";

const context = new AsyncLocalStorage<{
  request_id: string;
  operation: string;
}>();
type Fields = {
  duration_ms?: number;
  status?: string;
  http_status?: number;
  work_ref?: string;
  work_kind?: string;
  method?: string;
  error_code?: string;
  telegram_error_code?: string;
  error_type?: string;
};
/** Stable queue correlation without exposing IDs embedded in durable work keys. */
export function workReference(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}
export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Fields = {},
) {
  console[level](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: "fortnite-collect-bot",
      ...context.getStore(),
      event,
      ...fields,
    }),
  );
}
export function errorFields(error: unknown): Fields {
  const name = error instanceof Error ? error.name : "Error";
  const errorType = [
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "AbortError",
    "TimeoutError",
    "HttpError",
    "GrammyError",
    "AmbiguousOutcome",
  ].includes(name)
    ? name
    : "Error";
  return {
    error_type: errorType,
    error_code: diagnosticCode(error) ?? "unclassified",
    ...diagnosticTags(error),
  };
}
export function withRequestLogs<T>(
  operation: string,
  factory: () => Promise<T>,
) {
  return context.run({ request_id: randomUUID(), operation }, factory);
}

export function requestLogId(): string | undefined {
  return context.getStore()?.request_id;
}
