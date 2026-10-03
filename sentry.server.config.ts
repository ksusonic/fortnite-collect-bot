import * as Sentry from "@sentry/nextjs";
import { privacyOptions, SENTRY_DSN } from "./src/sentry-options";

Sentry.init({ dsn: SENTRY_DSN, ...privacyOptions });
