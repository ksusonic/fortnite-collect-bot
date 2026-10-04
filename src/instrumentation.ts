import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    // VERCEL_REGION is runtime-only, so builds and local development cannot
    // register the production webhook. Every cold start checks for drift.
    if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_REGION) {
      try {
        const [{ createBot }, { ensureStartupWebhook }, { withHttpClient }] =
          await Promise.all([
            import("./bot/runtime"),
            import("./bot/webhook"),
            import("./bot/transport"),
          ]);
        await withHttpClient(
          () => ensureStartupWebhook(createBot()),
          AbortSignal.timeout(20_000),
        );
      } catch (error) {
        Sentry.captureException(error, {
          tags: { component: "telegram_webhook_startup" },
        });
        console.error(
          "Telegram webhook startup reconciliation failed",
          error instanceof Error ? error.name : "Error",
        );
      }
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
