import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../bot/http";

export interface Viewer {
  id: number;
  startParam: string | null;
}
export function validateInitData(
  raw: string,
  token: string,
  now = Date.now() / 1000,
  maxAge = 3600,
): Viewer {
  if (!raw || raw.length > 16384)
    throw new HttpError(401, "Открой приложение заново из Telegram.");
  const data = new URLSearchParams(raw);
  const keys = [...data.keys()];
  if (new Set(keys).size !== keys.length)
    throw new HttpError(401, "Некорректная сессия Telegram.");
  const hash = data.get("hash") ?? "";
  if (!/^[a-f0-9]{64}$/i.test(hash))
    throw new HttpError(401, "Некорректная подпись Telegram.");
  data.delete("hash");
  const check = [...data.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex")))
    throw new HttpError(401, "Некорректная подпись Telegram.");
  const date = Number(data.get("auth_date"));
  if (
    !Number.isSafeInteger(date) ||
    date <= 0 ||
    date > now + 30 ||
    now - date > maxAge
  )
    throw new HttpError(401, "Сессия истекла. Открой приложение заново.");
  let user: unknown;
  try {
    user = JSON.parse(data.get("user") ?? "null");
  } catch {
    throw new HttpError(401, "Некорректный пользователь Telegram.");
  }
  if (
    !user ||
    typeof user !== "object" ||
    !("id" in user) ||
    !Number.isSafeInteger(user.id) ||
    Number(user.id) <= 0
  )
    throw new HttpError(401, "Некорректный пользователь Telegram.");
  return { id: Number(user.id), startParam: data.get("start_param") };
}
export function authenticateViewer(request: Request): Viewer {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new HttpError(503, "Приложение пока не настроено.");
  return validateInitData(
    request.headers.get("x-telegram-init-data") ?? "",
    token,
  );
}
export function chatHint(value: string | null): number | null {
  const match = /^chat_([1-9]\d*)$/.exec(value ?? "");
  const id = match ? -Number(match[1]) : NaN;
  return Number.isSafeInteger(id) ? id : null;
}
