import { checkProductionDatabase } from "../src/bot/readiness";
import { diagnosticCode } from "../src/sentry-options";

try {
  await checkProductionDatabase();
} catch (error) {
  // Never print connection strings, SQL, parameters or provider error messages.
  console.error(
    "Production database preflight failed; apply and verify the release's Supabase migrations before deploying.",
    diagnosticCode(error) ?? "DATABASE_UNAVAILABLE",
  );
  process.exitCode = 1;
}
