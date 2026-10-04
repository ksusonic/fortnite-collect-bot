import { describe, expect, it } from "vitest";
import { analyticsEvent } from "../src/mini-app/analytics-privacy";

describe("Mini App analytics privacy", () => {
  it("removes signed Telegram data from query and fragment while keeping page counts", () => {
    expect(
      analyticsEvent({
        type: "pageview",
        url: "https://example.com/?tgWebAppData=signed-secret&startapp=chat_100#tgWebAppData=other-secret",
      }),
    ).toEqual({ type: "pageview", url: "https://example.com/" });
  });
  it("fails closed for malformed URLs", () => {
    expect(
      analyticsEvent({ type: "pageview", url: "signed-secret" }),
    ).toBeNull();
  });
});
