import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { validateInitData, chatHint } from "../src/mini-app/auth";
import {
  verifyMembership,
  discoverChats,
  authorizeChat,
} from "../src/mini-app/access";
import { statisticsKeyboard } from "../src/bot/mini-app-link";
const state = vi.hoisted(() => ({ raw: vi.fn(), approved: vi.fn() }));
vi.mock("../src/bot/storage", () => ({ raw: state.raw }));
vi.mock("../src/bot/services/chat-access", () => ({
  isChatApproved: state.approved,
}));
beforeEach(() => state.approved.mockResolvedValue(true));
export function signedData(
  values: Record<string, string>,
  token = "test-token",
) {
  const params = new URLSearchParams(values);
  const text = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(text).digest("hex"));
  return params.toString();
}
const signed = (date = 1000) =>
  signedData({
    user: JSON.stringify({ id: 7, first_name: "Tester" }),
    auth_date: String(date),
    start_param: "chat_100",
  });
const api = () => ({
  getMe: vi.fn().mockResolvedValue({ id: 99 }),
  getChatMember: vi
    .fn()
    .mockImplementation(async (_chat: number, user: number) => ({
      status: user === 99 ? "administrator" : "member",
    })),
  getChat: vi
    .fn()
    .mockResolvedValue({ type: "supergroup", title: "Test group" }),
});
afterEach(() => {
  vi.unstubAllEnvs();
  state.raw.mockReset();
});
describe("Mini App authentication", () => {
  it("accepts a Telegram signature and keeps startapp as a hint", () => {
    expect(validateInitData(signed(), "test-token", 1001)).toEqual({
      id: 7,
      startParam: "chat_100",
    });
    expect(chatHint("chat_100")).toBe(-100);
  });
  it("rejects forged signatures, duplicate keys and malformed hashes", () => {
    for (const value of [
      signed().replace("Tester", "Forged"),
      signed() + "&user=%7B%22id%22%3A8%7D",
      signed().replace(/hash=[^&]+/, "hash=00"),
    ])
      expect(() => validateInitData(value, "test-token", 1001)).toThrow();
  });
  it("rejects expired, future and invalid sessions", () => {
    for (const date of [1, 10000, 0])
      expect(() =>
        validateInitData(signed(date), "test-token", 5000),
      ).toThrow();
    expect(() =>
      validateInitData(
        signedData({ auth_date: "1000", user: '{"id":-1}' }),
        "test-token",
        1001,
      ),
    ).toThrow();
  });
  it("does not interpret arbitrary navigation values as chat IDs", () => {
    for (const v of ["-100", "chat_0", "chat_1e5", "chat_99999999999999999"])
      expect(chatHint(v)).toBeNull();
  });
});
describe("live membership authorization", () => {
  it("rejects unapproved historical chats before Telegram access", async () => {
    state.raw.mockResolvedValue({ rowCount: 1 });
    state.approved.mockResolvedValue(false);
    const mock = api();
    await expect(authorizeChat(mock as never, -100, 7)).rejects.toMatchObject({
      status: 403,
    });
    expect(mock.getMe).not.toHaveBeenCalled();
  });
  it("requires bot administrator status before checking the viewer", async () => {
    const mock = api();
    mock.getChatMember.mockResolvedValue({ status: "member" });
    await expect(verifyMembership(mock as never, -100, 7)).rejects.toThrow(
      "администратором",
    );
    expect(mock.getChatMember).toHaveBeenCalledTimes(1);
  });
  for (const status of ["left", "kicked", "restricted"])
    it(`rejects ${status} users`, async () => {
      const mock = api();
      mock.getChatMember.mockImplementation(async (_chat, user) => ({
        status: user === 99 ? "administrator" : status,
      }));
      await expect(verifyMembership(mock as never, -100, 7)).rejects.toThrow(
        "больше не участник",
      );
    });
  it("allows restricted users only if still members", async () => {
    const mock = api();
    mock.getChatMember.mockImplementation(async (_chat, user) => ({
      status: user === 99 ? "administrator" : "restricted",
      is_member: true,
    }));
    await expect(verifyMembership(mock as never, -100, 7)).resolves.toEqual({
      id: -100,
      title: "Test group",
    });
  });
  it("fails closed on Telegram timeouts", async () => {
    const mock = api();
    mock.getChatMember.mockRejectedValue(new Error("timeout"));
    await expect(
      verifyMembership(mock as never, -100, 7),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("rechecks membership after a successful request and rejects a different chat", async () => {
    const mock = api();
    state.raw.mockResolvedValue({ rowCount: 1 });
    await expect(authorizeChat(mock as never, -100, 7)).resolves.toMatchObject({
      id: -100,
    });
    mock.getChatMember.mockImplementation(async (chat, user) => ({
      status: user === 99 ? "administrator" : chat === -100 ? "left" : "kicked",
    }));
    for (const chat of [-100, -200])
      await expect(authorizeChat(mock as never, chat, 7)).rejects.toMatchObject(
        {
          status: 403,
        },
      );
    expect(mock.getMe).toHaveBeenCalledTimes(3);
  });
  it("unknown chats never reach Telegram and known chats still require membership", async () => {
    const mock = api();
    state.raw.mockResolvedValue({ rowCount: 0 });
    await expect(authorizeChat(mock as never, -100, 7)).rejects.toMatchObject({
      status: 403,
    });
    expect(mock.getMe).not.toHaveBeenCalled();
    state.raw.mockResolvedValue({ rowCount: 1 });
    mock.getChatMember.mockImplementation(async (_chat, user) => ({
      status: user === 99 ? "administrator" : "left",
    }));
    await expect(authorizeChat(mock as never, -100, 7)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("discovers participation, initiation and links; forwarded hint requires current membership", async () => {
    const mock = api();
    state.raw
      .mockResolvedValueOnce({ rows: [{ chat_id: -200 }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    mock.getChatMember.mockImplementation(async (chat, user) => ({
      status: user === 99 ? "administrator" : chat === -100 ? "left" : "member",
    }));
    const result = await discoverChats(mock as never, {
      id: 7,
      startParam: "chat_100",
    });
    expect(result.selected).toBe(-200);
    expect(result.chats).toEqual([{ id: -200, title: "Test group" }]);
    expect(state.raw.mock.calls[0]![0]).toContain("initiator_id");
  });
  it("attaches ordinary URL buttons for group launches without granting access", () => {
    vi.stubEnv("MINI_APP_DIRECT_URL", "https://t.me/TestBot/results");
    expect(statisticsKeyboard(-100)?.inline_keyboard[0]?.[0]).toEqual({
      text: "📊 Открыть статистику",
      url: "https://t.me/TestBot/results?startapp=chat_100",
    });
  });
});
