import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { schemaContract } from "./bot/schema-contract";
type SentryOptions = NonNullable<
  Parameters<typeof import("@sentry/nextjs").init>[0]
>;
type StreamedSpanJSON = Parameters<
  NonNullable<SentryOptions["beforeSendSpan"]>
>[0];
type TransactionEvent = Parameters<
  NonNullable<SentryOptions["beforeSendTransaction"]>
>[0];

export const SENTRY_DSN =
  "https://a997a7108b8315cf576e410c980f856a@o4510234774929408.ingest.de.sentry.io/4512190824513616";
const diagnosticCodes = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "57014", // query cancellation / statement timeout
  "55P03", // lock unavailable
  "40P01", // deadlock
  "42P01", // missing table
  "42703", // missing column
  "42883", // missing function
  "42501", // insufficient privilege
  "28P01", // authentication failure
  "25P02", // transaction aborted
  "23505", // unique constraint
  "DATABASE_SCHEMA_NOT_READY",
]);
export function diagnosticCode(error: unknown, depth = 0): string | undefined {
  if (error instanceof Error && error.message === "Query read timeout")
    return "PG_QUERY_READ_TIMEOUT";
  if (!error || typeof error !== "object" || depth > 2) return;
  if (
    "code" in error &&
    typeof error.code === "string" &&
    diagnosticCodes.has(error.code)
  )
    return error.code;
  const wrapped =
    "error" in error ? error.error : "cause" in error ? error.cause : undefined;
  return diagnosticCode(wrapped, depth + 1);
}
export function diagnosticTags(error: unknown): Record<string, string> {
  const code = diagnosticCode(error);
  const tags: Record<string, string> = code ? { error_code: code } : {};
  if (code === "42P01" && error instanceof Error) {
    const relation = error.message.match(
      /relation "(?:fortnite_bot\.)?([a-z_]+)" does not exist/,
    )?.[1];
    if (relation && Object.hasOwn(schemaContract, relation))
      tags.database_relation = relation;
  }
  return tags;
}
export function sanitizeText(text: string): string {
  return text
    .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]+/gi, (value) => {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/bot[^/]+/g, "/bot[Filtered]");
      } catch {
        return "[Filtered URL]";
      }
    })
    .replace(/\/(?:file\/)?bot\d+:[A-Za-z0-9_-]+/g, "/bot[Filtered]")
    .replace(/\?[^\s"'<>]+/g, "")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[Filtered token]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [Filtered]");
}
const spanKeys = new Set([
  "sentry.op",
  "sentry.origin",
  "sentry.kind",
  "sentry.sample_rate",
  "http.request.method",
  "http.response.status_code",
  "db.system",
  "db.system.name",
  "db.operation",
  "db.operation.name",
]);
function spanData<T>(data: Record<string, T>) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => spanKeys.has(key))
      .map(([key, value]) => [
        key,
        typeof value === "string" ? sanitizeText(value) : value,
      ]),
  ) as Record<string, T>;
}
export function sanitizeSpan(span: StreamedSpanJSON): StreamedSpanJSON {
  const database =
    Object.keys(span.attributes).some((key) => key.startsWith("db.")) ||
    String(span.attributes["sentry.op"] ?? "").startsWith("db");
  return {
    ...span,
    name: database ? "Database operation" : sanitizeText(span.name),
    attributes: spanData(span.attributes),
    links: undefined,
  };
}
export function sanitizeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (
    breadcrumb.category === "console" ||
    breadcrumb.category?.startsWith("ui.")
  )
    return null;
  return {
    ...breadcrumb,
    message:
      ["http", "fetch"].includes(breadcrumb.category ?? "") &&
      breadcrumb.message
        ? sanitizeText(breadcrumb.message)
        : undefined,
    data: undefined,
  };
}
export function sanitizeEvent(event: ErrorEvent): ErrorEvent;
export function sanitizeEvent(event: TransactionEvent): TransactionEvent;
export function sanitizeEvent(
  event: ErrorEvent | TransactionEvent,
): ErrorEvent | TransactionEvent {
  const clean = { ...event };
  delete clean.user;
  delete clean.extra;
  delete clean.request;
  const trace = clean.contexts?.trace;
  clean.contexts = trace
    ? {
        trace: {
          trace_id: trace.trace_id,
          span_id: trace.span_id,
          parent_span_id: trace.parent_span_id,
          op: trace.op,
          status: trace.status,
          origin: trace.origin,
          data: spanData(trace.data ?? {}),
        },
      }
    : undefined;
  if (clean.message) clean.message = "Application diagnostic";
  delete clean.logentry;
  if (clean.transaction) clean.transaction = sanitizeText(clean.transaction);
  clean.breadcrumbs = clean.breadcrumbs
    ?.map(sanitizeBreadcrumb)
    .filter((item): item is Breadcrumb => item !== null);
  clean.exception = clean.exception
    ? {
        ...clean.exception,
        values: clean.exception.values?.map((exception) => ({
          ...exception,
          mechanism: exception.mechanism
            ? { ...exception.mechanism, data: undefined }
            : undefined,
          value: exception.type ?? "Application error",
          stacktrace: exception.stacktrace
            ? {
                ...exception.stacktrace,
                frames: exception.stacktrace.frames?.map((frame) => ({
                  ...frame,
                  vars: undefined,
                  filename: frame.filename
                    ? sanitizeText(frame.filename)
                    : undefined,
                  abs_path: frame.abs_path
                    ? sanitizeText(frame.abs_path)
                    : undefined,
                })),
              }
            : undefined,
        })),
      }
    : undefined;
  if ("spans" in clean)
    clean.spans = clean.spans?.map((span) => ({
      ...span,
      description:
        span.op?.startsWith("db") ||
        Object.keys(span.data).some((key) => key.startsWith("db."))
          ? "Database operation"
          : span.description
            ? sanitizeText(span.description)
            : undefined,
      data: spanData(span.data),
      links: undefined,
    }));
  return clean;
}
export const privacyOptions = {
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  enableLogs: true,
  logsFlushIntervalMs: 0,
  dataCollection: {
    userInfo: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    httpBodies: [],
    httpHeaders: false,
    cookies: false,
    urlQueryParams: false,
    stackFrameVariables: false,
  },
  beforeSend: sanitizeEvent,
  beforeSendSpan: sanitizeSpan,
  beforeBreadcrumb: sanitizeBreadcrumb,
};
