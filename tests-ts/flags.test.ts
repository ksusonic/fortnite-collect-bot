import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  evaluate: vi.fn(),
  shutdown: vi.fn(),
  createClient: vi.fn(),
}));
vi.mock("@vercel/flags-core", () => ({ createClient: mocks.createClient }));
vi.mock("../src/bot/work", () => ({
  externalCheckpoint: async (_name: string, factory: () => Promise<unknown>) =>
    factory(),
}));
import { getRoastPolicy } from "../src/bot/flags";
import { DEFAULT_ROAST_POLICY } from "../src/bot/services/roast-policy";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockReturnValue({
    evaluate: mocks.evaluate,
    shutdown: mocks.shutdown,
  });
});
it("reads policy without background tasks and closes the SDK client", async () => {
  const policy = { ...DEFAULT_ROAST_POLICY, proactiveAllowed: false };
  mocks.evaluate.mockResolvedValue({ value: policy });
  expect(await getRoastPolicy()).toEqual(policy);
  expect(mocks.createClient).toHaveBeenCalledWith(
    undefined,
    expect.objectContaining({
      stream: false,
      polling: false,
      disableMetrics: true,
    }),
  );
  expect(mocks.shutdown).toHaveBeenCalledOnce();
});
it("falls back and closes the client on network errors or invalid flags", async () => {
  mocks.evaluate.mockRejectedValue(new Error("unavailable"));
  expect(await getRoastPolicy()).toEqual(DEFAULT_ROAST_POLICY);
  mocks.evaluate.mockResolvedValue({
    value: { defaults: { proactive: "yes" } },
  });
  expect(await getRoastPolicy()).toEqual(DEFAULT_ROAST_POLICY);
  expect(mocks.shutdown).toHaveBeenCalledTimes(2);
});
