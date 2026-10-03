import { diagnosticCode } from "../sentry-options";
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
): Promise<Response> {
  try {
    return Response.json(await factory(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof HttpError)
      return Response.json({ detail: error.message }, { status: error.status });
    const code = diagnosticCode(error);
    Sentry.captureException(error, {
      tags: { component: "http", ...(code ? { error_code: code } : {}) },
    });
    console.error(
      "endpoint failed",
      error instanceof Error ? error.name : "Error",
      code ?? "unclassified",
    );
    return Response.json({ detail: "processing incomplete" }, { status: 503 });
  } finally {
    await Sentry.flush(2000);
  }
}
export function requestSignal(request: Request) {
  return AbortSignal.any([request.signal, AbortSignal.timeout(240000)]);
}
