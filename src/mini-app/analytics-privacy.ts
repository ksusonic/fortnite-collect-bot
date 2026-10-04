import type { BeforeSendEvent } from "@vercel/analytics/next";

/** Keep page counts without transmitting Telegram launch data or chat hints. */
export function analyticsEvent(event: BeforeSendEvent): BeforeSendEvent | null {
  try {
    const url = new URL(event.url);
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return { ...event, url: url.toString() };
  } catch {
    return null;
  }
}
