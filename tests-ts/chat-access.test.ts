vi.mock("../src/bot/transport", async (original) => ({
  ...(await original<typeof import("../src/bot/transport")>()),
  scopedFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Update } from "grammy/types";
import { invocation, migrate, raw } from "../src/bot/storage";
import {
  createBot,
  enqueue,
  executeItem,
  processUpdate,
} from "../src/bot/runtime";
import {
  isChatApproved,
  isGeneralAdmin,
  isOwnerInit,
} from "../src/bot/services/chat-access";

function update(id: number, text: string, user = 42, chat = -10): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 2000,
      chat: { id: chat, type: "group", title: "friends" },
      from: { id: user, is_bot: false, first_name: "User" },
      text,
      entities: [
        { type: "bot_command", offset: 0, length: text.split(" ")[0]!.length },
      ],
    },
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("accepts only the configured owner and a real group init command", () => {
  vi.stubEnv("ADMIN_USER_ID", "42");
  expect(isGeneralAdmin(42)).toBe(true);
  expect(isGeneralAdmin(7)).toBe(false);
  expect(isOwnerInit(update(1, "/init@fort_test_bot"))).toBe(true);
  expect(isOwnerInit(update(1, "/init", 7))).toBe(false);
  expect(isOwnerInit(update(1, "/initialize"))).toBe(false);
  const anonymous = update(1, "/init");
  anonymous.message!.sender_chat = anonymous.message!.chat;
  expect(isOwnerInit(anonymous)).toBe(false);
  vi.stubEnv("ADMIN_USER_ID", "");
  expect(isOwnerInit(update(1, "/init"))).toBe(false);
});

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("durable owner approval", () => {
  const calls: string[] = [];
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !["localhost", "127.0.0.1"].includes(target.hostname) ||
      target.pathname !== "/fortnite_test"
    )
      throw new Error("disposable localhost fortnite_test required");
    process.env.DATABASE_URL = url;
    process.env.DATABASE_LOCAL_TEST = "1";
    await migrate();
  });
  beforeEach(async () => {
    calls.length = 0;
    vi.stubEnv("ADMIN_USER_ID", "42");
    vi.stubEnv("BOT_TOKEN", "123:test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit) => {
        const method = String(input).split("/").at(-1)!;
        calls.push(method);
        const body = JSON.parse(String(init.body));
        const result =
          method === "getMe"
            ? {
                id: 123,
                is_bot: true,
                first_name: "Bot",
                username: "fort_test_bot",
                can_join_groups: true,
                can_read_all_group_messages: true,
                supports_inline_queries: false,
              }
            : method === "sendMessage"
              ? {
                  message_id: 100 + calls.length,
                  date: 2000,
                  chat: { id: body.chat_id, type: "group" },
                  text: body.text,
                }
              : true;
        return new Response(JSON.stringify({ ok: true, result }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    await invocation(null, () =>
      raw(
        "TRUNCATE afk_mutes,chat_fort_titles,approved_chats,roast_profiles,roast_state,chat_features,work_steps,work_items,service_state,sessions,responses,epic_links,squad_snapshots CASCADE",
      ),
    );
  });
  it("ignores unauthorized messages before storing them or calling Telegram", async () => {
    for (const payload of [
      update(1, "/fort", 7),
      update(2, "/init", 7),
      update(3, "/stats"),
    ])
      expect(await processUpdate(payload)).toBe("complete");
    expect(calls).toEqual([]);
    expect(
      await invocation(
        null,
        async () => (await raw("SELECT * FROM work_items")).rows,
      ),
    ).toEqual([]);
    expect(await invocation(-10, () => isChatApproved(-10))).toBe(false);
  });
  it("persists approval, replays init safely, and enables only that chat", async () => {
    const payload = update(1, "/init@fort_test_bot");
    expect(await processUpdate(payload)).toBe("complete");
    expect(await invocation(-10, () => isChatApproved(-10))).toBe(true);
    expect(await invocation(-11, () => isChatApproved(-11))).toBe(false);
    expect(calls.filter((c) => c === "sendMessage")).toHaveLength(1);
    await processUpdate(payload);
    expect(calls.filter((c) => c === "sendMessage")).toHaveLength(1);
    await processUpdate(update(2, "/init"));
    expect(
      await invocation(
        null,
        async () => (await raw("SELECT approved_by FROM approved_chats")).rows,
      ),
    ).toEqual([{ approved_by: 42 }]);
    await processUpdate(update(3, "/stats", 7));
    expect(calls.filter((c) => c === "sendMessage")).toHaveLength(3);
  });
  it("activates an existing chat without losing sessions, responses, AFK, titles or Epic links", async () => {
    await invocation(-10, async () => {
      await raw(
        "INSERT INTO sessions(chat_id,message_id,initiator_id,initiator_name,created_at,fort_title) VALUES (-10,90,7,'User',now(),'Saved FORT')",
      );
      await raw(
        "INSERT INTO responses(chat_id,message_id,user_id,user_name,response,responded_at,joined_at) VALUES (-10,90,7,'User','go',now(),now())",
      );
      await raw(
        "INSERT INTO afk_mutes(chat_id,user_id,muted_until) VALUES (-10,7,now()+interval '1 day')",
      );
      await raw(
        "INSERT INTO chat_fort_titles(chat_id,title) VALUES (-10,'Saved FORT')",
      );
      await raw(
        "INSERT INTO epic_links(chat_id,user_id,user_name,epic_name,epic_account_id,linked_at) VALUES (-10,7,'User','Epic','account',now())",
      );
      await raw(
        "INSERT INTO chat_features(chat_id,feature,enabled) VALUES (-10,'roast',true)",
      );
    });
    const tables = [
      "sessions",
      "responses",
      "afk_mutes",
      "chat_fort_titles",
      "epic_links",
    ];
    const contents = () =>
      invocation(-10, async () =>
        Promise.all(
          tables.map(
            async (table) =>
              (await raw(`SELECT * FROM ${table} WHERE chat_id=-10`)).rows,
          ),
        ),
      );
    const before = await contents();
    await processUpdate(update(1, "/stats", 7));
    expect(calls).toEqual([]);
    await processUpdate(update(2, "/init"));
    expect(await contents()).toEqual(before);
    expect(await invocation(-10, () => isChatApproved(-10))).toBe(true);
    await processUpdate(update(3, "/stats", 7));
    expect(calls.filter((c) => c === "sendMessage")).toHaveLength(2);
  });
  it("does not approve init addressed to another bot or sent privately", async () => {
    await processUpdate(update(1, "/init@other_bot"));
    const privateUpdate = update(2, "/init");
    privateUpdate.message!.chat = {
      id: 42,
      type: "private",
      first_name: "Owner",
    };
    await processUpdate(privateUpdate);
    expect(await invocation(-10, () => isChatApproved(-10))).toBe(false);
    expect(calls.filter((c) => c === "sendMessage")).toHaveLength(0);
  });
  it("blocks queued background sends in an unapproved chat", async () => {
    await invocation(-10, async () => {
      await enqueue("blocked-status", "status", -10, { text: "notification" });
      expect(
        await executeItem(
          {
            id: "blocked-status",
            kind: "status",
            chat_id: -10,
            status: "pending",
            payload: { text: "notification" },
          },
          createBot(),
        ),
      ).toBe("complete");
    });
    expect(calls).toEqual([]);
  });
});
