/** Explicit maintenance only: startup never changes schemas or webhooks. */
import { createBot } from "./runtime";
import { migrate } from "./storage";
import { importBackup } from "./importer";
import { pathToFileURL } from "node:url";
import { withHttpClient } from "./transport";
import { registerWebhook } from "./webhook";
export { registerWebhook } from "./webhook";

export async function maintain(args: string[]): Promise<void> {
  const [command, argument] = args;
  if (command === "migrate") {
    await migrate();
    return;
  }
  if (command === "import") {
    if (!argument) throw new Error("backup path required");
    console.log(JSON.stringify(await importBackup(argument), null, 2));
    return;
  }
  if (command !== "register-webhook" && command !== "webhook-info")
    throw new Error(
      "usage: pnpm bot migrate|import <backup>|register-webhook <url>|webhook-info",
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
