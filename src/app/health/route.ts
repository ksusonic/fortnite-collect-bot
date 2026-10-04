import "server-only";
import { endpoint } from "@/bot/http";
import { checkDatabase } from "@/bot/readiness";
export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";
export function GET() {
  return endpoint(async () => {
    await checkDatabase();
    return { ok: true };
  });
}
