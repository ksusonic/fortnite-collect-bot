import { beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "grammy";
const mock = vi.hoisted(() => ({ raw: vi.fn() }));
vi.mock("../src/bot/storage", () => ({ raw: mock.raw }));
import {
  GROUP_COMMANDS,
  setupBotCommands,
  syncReleaseCommands,
} from "../src/bot/commands";
function bot() {
  const api = {
    setMyCommands: vi.fn().mockResolvedValue(true),
    deleteMyCommands: vi.fn().mockResolvedValue(true),
    getMyCommands: vi
      .fn()
      .mockImplementation(async (args?: { scope?: { type: string } }) =>
        args?.scope?.type === "all_group_chats" ? GROUP_COMMANDS : [],
      ),
  };
  return { api };
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.raw.mockResolvedValue({ rows: [] });
});
it("removes retired commands and verifies the three maintained Telegram scopes", async () => {
  const b = bot();
  expect(GROUP_COMMANDS.map((c) => c.command)).toEqual([
    "fort",
    "afk",
    "rm",
    "stats",
    "teamstats",
  ]);
  await setupBotCommands(b as unknown as Bot);
  expect(b.api.setMyCommands).toHaveBeenCalledWith(GROUP_COMMANDS, {
    scope: { type: "all_group_chats" },
  });
  expect(b.api.deleteMyCommands).toHaveBeenCalledTimes(2);
  expect(b.api.getMyCommands).toHaveBeenCalledTimes(3);
});
it("syncs once per release and records success only after readback", async () => {
  const b = bot();
  await syncReleaseCommands(b as unknown as Bot);
  const marker = JSON.parse(mock.raw.mock.calls[1]![1][0]);
  mock.raw.mockResolvedValue({ rows: [{ value: marker }] });
  await syncReleaseCommands(b as unknown as Bot);
  expect(b.api.setMyCommands).toHaveBeenCalledTimes(1);
  expect(
    mock.raw.mock.calls.filter(([sql]) => sql.startsWith("INSERT")),
  ).toHaveLength(1);
});
it("leaves failed verification retryable instead of marking a release synced", async () => {
  const b = bot();
  b.api.getMyCommands.mockResolvedValue([]);
  await expect(syncReleaseCommands(b as unknown as Bot)).rejects.toThrow(
    "verification failed",
  );
  expect(mock.raw.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
  b.api.getMyCommands.mockImplementation(async (args) =>
    args?.scope?.type === "all_group_chats" ? GROUP_COMMANDS : [],
  );
  await syncReleaseCommands(b as unknown as Bot);
  expect(b.api.setMyCommands).toHaveBeenCalledTimes(2);
});
