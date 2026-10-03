import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = pathToFileURL(resolve("scripts/verify-deployment.mjs")).href;
const deployment =
  "https://fortnite-collect-bot-daniils-projects-0e3d8509.vercel.app";
function verify(url: string, fetchMock: string) {
  return run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `${fetchMock}; await import(${JSON.stringify(script)})`,
    ],
    { env: { DEPLOYMENT_URL: url, NODE_ENV: "test" }, timeout: 10_000 },
  );
}

describe("deployment smoke probes", () => {
  it("checks health and rejects unauthenticated access without sending credentials", async () => {
    const result = await verify(
      deployment,
      `globalThis.fetch = async (url, options) => {
        if (options.headers?.authorization || options.redirect !== 'error') throw new Error('unsafe probe');
        console.log(options.method + ' ' + url.pathname);
        return Response.json(url.pathname === '/health' ? {ok: true} : {}, {status: url.pathname === '/health' ? 200 : 401});
      }`,
    );
    expect(result.stdout).toContain("PASS GET /health: 200");
    expect(result.stdout).toContain("PASS GET /api/admin/inspect: 401");
    expect(result.stdout).toContain("PASS POST /api/telegram/webhook: 401");
    expect(result.stdout).toContain("PASS POST /api/jobs/expiry: 401");
  });

  it("refuses unrelated hosts before making any request", async () => {
    await expect(
      verify(
        "https://example.com",
        "globalThis.fetch = () => { throw new Error('request made'); }",
      ),
    ).rejects.toThrow("expected this project's HTTPS Vercel deployment URL");
  });

  it("reports Vercel firewall rejection separately from application authentication", async () => {
    const result = await verify(
      deployment,
      `globalThis.fetch = async (url) => url.pathname === '/health'
        ? Response.json({ok: true})
        : new Response(null, {status: 403, headers: {'x-vercel-mitigated': 'deny'}})`,
    );
    expect(result.stdout).toContain(
      "Vercel denied access (403; app auth not reached)",
    );
  });

  it("does not accept an unexplained forbidden response", async () => {
    await expect(
      verify(
        deployment,
        `globalThis.fetch = async (url) => url.pathname === '/health'
          ? Response.json({ok: true})
          : new Response(null, {status: 403})`,
      ),
    ).rejects.toThrow("GET /api/admin/inspect");
  });

  it("fails when a protected route permits unauthenticated access", async () => {
    await expect(
      verify(
        deployment,
        "globalThis.fetch = async () => Response.json({ok: true})",
      ),
    ).rejects.toThrow("GET /api/admin/inspect");
  });
});
