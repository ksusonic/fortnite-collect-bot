import type { Session } from "../db";
import * as db from "../db";
import { valueCheckpoint } from "../work";

export type GatheringAction = "join" | "set_time" | "ready" | "away" | "pass";
export interface GatheringDecision {
  action: GatheringAction | "clarify" | "ignore";
  at?: number;
  confirm?: boolean;
  rejoin?: boolean;
}
export interface GatheringPrompt {
  user: number;
  expires: number;
  revision: number;
  decision?: GatheringDecision;
  invalidated?: boolean;
}
export interface GatheringState {
  notified_at?: number;
  close_reason?: "cancelled" | "evening_end";
  prompts: Record<string, GatheringPrompt>;
  revisions: Record<string, number>;
}
export function gatheringState(session: Session): GatheringState {
  return (session.gathering ??= { prompts: {}, revisions: {} });
}
export function eveningEnd(created: number): number {
  return Math.floor((created + 10800) / 86400) * 86400 + 86400 - 10800;
}
export function clock(at: number): string {
  return new Date((at + 10800) * 1000).toISOString().slice(11, 16);
}
export function validTime(
  at: number,
  now: number,
  sessionCreated = now,
): boolean {
  return Number.isFinite(at) && at >= now && at < eveningEnd(sessionCreated);
}
/** null = not a deterministic time expression; NaN = recognizable but invalid. */
export function parseGatheringTime(raw: string, now: number): number | null {
  const text = raw.trim().toLowerCase().replaceAll("ё", "е");
  if (/^(сейчас|прямо сейчас)$/.test(text)) return now;
  const absolute = /^(?:в\s+)?(\d{1,2})(?::(\d{2}))?$/.exec(text);
  if (absolute) {
    const hour = Number(absolute[1]),
      minute = Number(absolute[2] ?? 0);
    if (hour > 23 || minute > 59) return NaN;
    return eveningEnd(now) - 86400 + hour * 3600 + minute * 60;
  }
  const relative =
    /^через\s+(?:(\d+(?:[.,]\d+)?)\s*(минут[уы]?|мин|м|час(?:а|ов)?|ч)|(полтора(?: часа)?|полчаса|час|два часа))$/.exec(
      text,
    );
  if (!relative) return null;
  const minutes = relative[1]
    ? Number(relative[1].replace(",", ".")) *
      (relative[2]!.startsWith("ч") ? 60 : 1)
    : relative[3] === "полчаса"
      ? 30
      : relative[3]!.startsWith("полтора")
        ? 90
        : relative[3] === "два часа"
          ? 120
          : 60;
  return minutes > 0 ? now + minutes * 60 : NaN;
}
export function mentionsOtherDay(text: string): boolean {
  return /(?:^|[^а-яё])(завтра|послезавтра|вчера|позавчера)(?=$|[^а-яё])/iu.test(
    text,
  );
}
export function availability(
  session: Session,
  user: number,
): number | undefined {
  const explicit = session.availability?.get(user);
  if (explicit !== undefined) return explicit;
  const legacy = session.player_slots.get(user);
  if (legacy === "now") return session.created_at;
  if (legacy && /^\d{2}:\d{2}$/.test(legacy))
    return parseGatheringTime(legacy, session.created_at) ?? undefined;
  return undefined;
}
export function rosterTimes(session: Session) {
  const squad = [...session.go_players.keys()].slice(0, 4);
  const times = squad.map((id) => availability(session, id));
  const known = times.filter(
    (at): at is number => at !== undefined && Number.isFinite(at),
  );
  const rounded = (at: number) => {
    const result = Math.ceil(at / 300) * 300;
    return result < eveningEnd(session.created_at) ? result : at;
  };
  const ready = squad.filter((id) => session.ready_players?.has(id)).length;
  return {
    squad,
    ready,
    unknown: squad.length - known.length,
    start: known.length
      ? ready > 0 || Math.min(...known) <= session.created_at
        ? Math.min(...known)
        : rounded(Math.min(...known))
      : undefined,
    all: known.length ? rounded(Math.max(...known)) : undefined,
  };
}
export function messageLink(chat: number, message: number): string {
  return `https://t.me/c/${String(chat).replace(/^-100/, "")}/${message}`;
}

/** A replay uses the original transition, even if its SQL already committed. */
export async function changePlayer(
  session: Session,
  user: number,
  name: string,
  decision: GatheringDecision,
  now: number,
): Promise<string | null> {
  const plan = await valueCheckpoint("gathering-transition-v2", () => {
    if (session.is_closed || now >= eveningEnd(session.created_at))
      return { error: "Вечер завершён. Создай новый сбор: /fort." };
    if (decision.action === "ignore" || decision.action === "clarify")
      return { error: "Укажи время: например, 19:30 или через 20 минут." };
    if (
      decision.at !== undefined &&
      !validTime(decision.at, now, session.created_at)
    )
      return {
        error: "Нужно время сегодня, не раньше текущего и до полуночи МСК.",
      };
    if (decision.action === "set_time" && decision.at === undefined)
      return { error: "Укажи время: например, 19:30." };
    if (
      decision.action !== "pass" &&
      !session.go_players.has(user) &&
      session.go_players.size >= 8
    )
      return { error: "Резерв заполнен." };
    if (decision.action === "away" && !session.go_players.has(user))
      return { error: "Ты пока не записан в сбор." };
    if (
      (decision.action === "pass" && session.pass_players.has(user)) ||
      (decision.action === "join" && session.go_players.has(user)) ||
      (decision.action === "ready" && session.ready_players?.has(user)) ||
      (decision.action === "set_time" &&
        session.go_players.has(user) &&
        !session.ready_players?.has(user) &&
        availability(session, user) === decision.at)
    )
      return { noop: true };
    const go = new Map(session.go_players),
      pass = new Map(session.pass_players);
    const times = new Map(
      [...go.keys()].flatMap((id) => {
        const at = availability(session, id);
        return at === undefined ? [] : [[id, at] as [number, number]];
      }),
    );
    const ready = new Set(session.ready_players);
    if (decision.action === "pass") {
      go.delete(user);
      times.delete(user);
      ready.delete(user);
      pass.set(user, name);
    } else {
      pass.delete(user);
      go.set(user, name);
      ready.delete(user);
      times.delete(user);
      if (decision.action === "ready") {
        ready.add(user);
        times.set(user, now);
      } else if (decision.at !== undefined) times.set(user, decision.at);
    }
    const state = structuredClone(gatheringState(session));
    state.revisions[user] = (state.revisions[user] ?? 0) + 1;
    for (const [id, prompt] of Object.entries(state.prompts))
      if (prompt.user === user || prompt.expires <= now)
        state.prompts[id] = { ...prompt, invalidated: true };
    return {
      go: [...go],
      pass: [...pass],
      times: [...times],
      ready: [...ready],
      state,
      complete: !session.is_complete && go.size >= 4,
      response:
        decision.action === "pass" ? ("pass" as const) : ("go" as const),
      at: times.get(user) ?? null,
      isReady: ready.has(user),
    };
  });
  if ("error" in plan) return plan.error!;
  if ("noop" in plan) return null;
  await db.save_response(session.message_id, user, name, plan.response, {
    chat_id: session.chat_id,
    time_slot: plan.at === null ? null : clock(plan.at),
    available_at: plan.at,
    ready: plan.isReady,
    became_complete: plan.complete,
  });
  session.go_players = new Map(plan.go);
  session.pass_players = new Map(plan.pass);
  session.availability = new Map(plan.times);
  session.ready_players = new Set(plan.ready);
  session.player_slots = new Map(plan.times.map(([id, at]) => [id, clock(at)]));
  session.gathering = plan.state;
  if (plan.complete) {
    session.is_complete = true;
    session.completed_at = now;
  }
  await db.save_session(session);
  return null;
}
