import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pg"],
};
export default withSentryConfig(config, {
  org: "kiskis",
  project: "fort-collect-bot",
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: { disable: process.env.VERCEL !== "1" },
  release:
    process.env.VERCEL === "1"
      ? undefined
      : { create: false, finalize: false, setCommits: false },
  widenClientFileUpload: true,
  tunnelRoute: "/monitoring",
  webpack: { treeshake: { removeDebugLogging: true } },
});
