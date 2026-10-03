import "server-only";
import { authenticate, endpoint, HttpError, requestSignal } from "@/bot/http";
import { processUpdate, validateUpdate } from "@/bot/runtime";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  return endpoint(async () => {
    authenticate(
      request.headers.get("x-telegram-bot-api-secret-token"),
      "TELEGRAM_WEBHOOK_SECRET",
    );
    let payload: unknown;
    try {
      payload = await request.json();
      validateUpdate(payload);
    } catch {
      throw new HttpError(400, "invalid update");
    }
    const result = await processUpdate(payload, requestSignal(request));
    if (result === "ambiguous") return { ok: true, review_required: true };
    if (result !== "complete")
      throw new HttpError(503, "processing incomplete");
    return { ok: true };
  });
}
