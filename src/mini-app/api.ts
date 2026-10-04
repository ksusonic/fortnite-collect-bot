import "server-only";
import { Api, type ApiClientOptions } from "grammy";
import { authenticateViewer } from "./auth";
import { discoverChats, authorizeChat } from "./access";
import { endpoint, HttpError } from "../bot/http";
import { invocation } from "../bot/storage";
import { scopedFetch } from "../bot/transport";
import * as db from "../bot/db";
import {
  weeklyReport,
  gatheringReport,
  teamAnalysis,
  accountProfile,
  lockedChat,
  failureReason,
  FortniteError,
} from "../statistics/service";
import type { Window } from "../statistics/profile";

export async function miniAppEndpoint(request: Request, resource: string) {
  const response = await endpoint(async () => {
    const viewer = authenticateViewer(request);
    const url = new URL(request.url);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(85000),
    ]);
    return invocation(
      null,
      async () => {
        const api = new Api(process.env.BOT_TOKEN!, {
          timeoutSeconds: 8,
          fetch: scopedFetch as unknown as ApiClientOptions["fetch"],
        });
        if (resource === "chats" && request.method === "GET")
          return discoverChats(api, viewer);
        const chat = Number(url.searchParams.get("chat"));
        await authorizeChat(api, chat, viewer.id);
        if (resource === "profile" && request.method === "GET") {
          const user = Number(url.searchParams.get("user") ?? viewer.id);
          if (!Number.isSafeInteger(user))
            throw new HttpError(400, "Некорректный игрок.");
          const links = await db.get_chat_epic_links(chat);
          const link = links.find((candidate) => candidate.user_id === user);
          if (!link)
            return {
              linked: false,
              instruction:
                "Попроси админа связать аккаунт: /linkepicfor @user EpicName",
            };
          const window = url.searchParams.get("window") ?? "season";
          if (window !== "season" && window !== "lifetime")
            throw new HttpError(400, "Некорректный период.");
          try {
            return {
              linked: true,
              name: link.user_name,
              ...(await accountProfile(
                link.epic_account_id,
                window as Window,
                signal,
              )),
            };
          } catch (error) {
            if (
              error instanceof FortniteError ||
              (error instanceof Error && error.message === "provider busy")
            )
              return { linked: true, error: failureReason(error), data: null };
            throw error;
          }
        }
        if (resource === "gatherings" && request.method === "GET")
          return lockedChat(chat, () => gatheringReport(chat));
        if (
          (resource === "weekly" && request.method === "GET") ||
          (resource === "refresh" && request.method === "POST")
        )
          return weeklyReport(chat);
        if (resource === "analysis" && request.method === "GET") {
          // Provider refresh and optional analysis do not hold the bot chat lock.
          const report = await weeklyReport(chat);
          try {
            return { analysis: await teamAnalysis(chat, report) };
          } catch {
            return {
              analysis: null,
              error: "Анализ Grok временно недоступен.",
            };
          }
        }
        throw new HttpError(404, "Маршрут не найден.");
      },
      signal,
    );
  });
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("Vary", "x-telegram-init-data");
  return response;
}
