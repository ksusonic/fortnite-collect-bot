import { afterEach, expect, it, vi } from "vitest";

vi.mock("../sentry.server.config", () => ({}));
vi.mock("../src/bot/runtime", () => ({ createBot: vi.fn() }));
vi.mock("../src/bot/storage", () => ({ raw: vi.fn() }));
vi.mock("../src/bot/transport", () => ({ withHttpClient: vi.fn() }));

import { register } from "../src/instrumentation";
import { createBot } from "../src/bot/runtime";
import { raw } from "../src/bot/storage";
import { withHttpClient } from "../src/bot/transport";

afterEach(() => vi.unstubAllEnvs());

it("initializes production instrumentation without Telegram or database calls", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VERCEL_REGION", "fra1");
  await register();
  expect(createBot).not.toHaveBeenCalled();
  expect(raw).not.toHaveBeenCalled();
  expect(withHttpClient).not.toHaveBeenCalled();
});
