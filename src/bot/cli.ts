/** Explicit maintenance only: startup never changes schemas or webhooks. */
import { createBot } from "./runtime";
import { migrate } from "./storage";
import { importBackup } from "./importer";
import { pathToFileURL } from "node:url";
import { scopedFetch, httpSignal, withHttpClient } from "./transport";
import { registerWebhook } from "./webhook";
import { setupBotCommands } from "./commands";
export { registerWebhook } from "./webhook";

export async function maintain(args: string[]): Promise<void> {
  const [command, argument] = args;
  if (command === "configure-commands") {
    await withHttpClient(() => setupBotCommands(createBot()));
    return;
  }
  if (command === "migrate") {
    await migrate();
    return;
  }
  if (command === "import") {
    if (!argument) throw new Error("backup path required");
    console.log(JSON.stringify(await importBackup(argument), null, 2));
    return;
  }
  if (command === "configure-mini-app") {
    if (!argument) throw new Error("production URL required");
    const base = new URL(argument);
    if (base.protocol !== "https:")
      throw new Error("production URL must use HTTPS");
    const app = new URL("/", base);
    await withHttpClient(async () => {
      const response = await scopedFetch(app, {
        signal: httpSignal(20000),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("mini app health check failed");
      await response.body?.cancel();
      await createBot().api.setChatMenuButton({
        menu_button: {
          type: "web_app",
          text: "Статистика",
          web_app: { url: app.toString() },
        },
      });
    });
    return;
  }
  if (command !== "register-webhook" && command !== "webhook-info")
    throw new Error(
      "usage: pnpm bot migrate|import <backup>|register-webhook <url>|webhook-info|configure-mini-app <url>|configure-commands",
    );
  const info =
    command === "register-webhook"
      ? await registerWebhook(argument ?? "")
      : await withHttpClient(() => createBot().api.getWebhookInfo());
  console.log(JSON.stringify(info, null, 2));
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  maintain(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "maintenance failed",
    );
    process.exitCode = 1;
  });
}
