import "server-only";
import { adminAuth, endpoint } from "@/bot/http";
import { registerWebhook } from "@/bot/webhook";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  return endpoint(async () => {
    adminAuth(request);
    return registerWebhook(process.env.PUBLIC_BASE_URL ?? "");
  });
}
