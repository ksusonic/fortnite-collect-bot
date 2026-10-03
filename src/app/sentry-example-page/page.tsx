"use client";

import * as Sentry from "@sentry/nextjs";
import { useState } from "react";

export default function SentryExamplePage() {
  const [sent, setSent] = useState(false);
  const development = process.env.NODE_ENV === "development";
  return (
    <main>
      <h1>Sentry verification</h1>
      <p>
        {development
          ? "Send a frontend and backend test error, then check the Sentry project."
          : "Interactive diagnostics are available in local development."}
      </p>
      {development && (
        <button
          type="button"
          onClick={async () => {
            await Sentry.startSpan(
              { name: "Sentry verification", op: "test" },
              async () => {
                await fetch("/api/sentry-example-api");
                Sentry.captureException(
                  new Error("Sentry frontend verification"),
                );
              },
            );
            setSent(true);
          }}
        >
          Send test errors
        </button>
      )}
      {sent && <p>Test errors submitted. Verify receipt in Sentry.</p>}
      <a
        href="https://kiskis.sentry.io/issues/?project=4512190824513616"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open Sentry issues
      </a>
    </main>
  );
}
