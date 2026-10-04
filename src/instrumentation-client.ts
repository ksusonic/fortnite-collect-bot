import * as Sentry from "@sentry/nextjs";
import { privacyOptions, SENTRY_DSN } from "./sentry-options";

Sentry.init({
  dsn: SENTRY_DSN,
  ...privacyOptions,
  // Telegram launch URLs contain signed session data. DOM masking does not
  // scrub Replay navigation metadata, so do not install Session Replay.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
});
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
