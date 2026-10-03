import * as Sentry from "@sentry/nextjs";
import { privacyOptions, SENTRY_DSN } from "./sentry-options";

Sentry.init({
  dsn: SENTRY_DSN,
  ...privacyOptions,
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
      networkDetailAllowUrls: [],
    }),
  ],
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1,
});
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
