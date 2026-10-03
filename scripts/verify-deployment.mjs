// Read-only probes: no credentials, Telegram updates, jobs or database writes.
import assert from "node:assert/strict";

const target = process.env.DEPLOYMENT_URL;
assert(target, "DEPLOYMENT_URL is required");
const base = new URL(
  target.startsWith("https://") ? target : `https://${target}`,
);
assert(
  base.protocol === "https:" &&
    base.hostname.startsWith("fortnite-collect-") &&
    base.hostname.endsWith("-daniils-projects-0e3d8509.vercel.app") &&
    !base.username &&
    !base.password &&
    !base.port &&
    base.pathname === "/" &&
    !base.search &&
    !base.hash,
  "expected this project's HTTPS Vercel deployment URL",
);

const probes = [
  { path: "/health", method: "GET", status: 200 },
  { path: "/api/admin/inspect", method: "GET", status: 401 },
  { path: "/api/telegram/webhook", method: "POST", status: 401 },
  { path: "/api/jobs/expiry", method: "POST", status: 401 },
];
for (const { path, method, status } of probes) {
  // Retry transient deployment/network failures within a fixed overall bound.
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(new URL(path, base), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        ...(method === "POST"
          ? { body: "{}", headers: { "content-type": "application/json" } }
          : {}),
      });
      if (path === "/health") {
        assert.equal(response.status, status, `${method} ${path}`);
        assert.deepEqual(await response.json(), { ok: true });
      } else {
        const mitigated =
          response.status === 403 &&
          response.headers.get("x-vercel-mitigated") === "deny";
        await response.body?.cancel();
        if (mitigated) {
          console.log(
            `PASS ${method} ${path}: Vercel denied access (403; app auth not reached)`,
          );
          break;
        }
        assert.equal(response.status, status, `${method} ${path}`);
      }
      console.log(`PASS ${method} ${path}: ${status}`);
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
