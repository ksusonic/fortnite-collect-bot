import { describe, expect, it, vi } from "vitest";
import {
  buildAlert,
  deriveIndicator,
  detectChange,
  fetchStatus,
  type ServerStatus,
} from "../src/bot/status";
const operational: ServerStatus = {
  indicator: "none",
  description: "operational",
  incidents: [],
};
describe("Epic status", () => {
  it("classifies only Fortnite components and incidents", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          components: [
            {
              id: "fort",
              name: "Fortnite",
              group: true,
              components: ["login"],
            },
            { id: "login", name: "Login", status: "degraded_performance" },
            { id: "store", name: "Store", status: "major_outage" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          incidents: [
            { name: "Login affected", components: [{ id: "login" }] },
            {
              name: "Matchmaking",
              components: [{ id: "other", group_id: "fort" }],
            },
            { name: "Store affected", components: [{ id: "store" }] },
          ],
        }),
      );
    expect(await fetchStatus(fetcher)).toEqual({
      indicator: "minor",
      description: "Login: degraded performance",
      incidents: ["Login affected", "Matchmaking"],
    });
    expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
    expect(fetcher.mock.calls[0][1].signal).toBe(
      fetcher.mock.calls[1][1].signal,
    );
  });
  it("returns unavailable when Fortnite is absent or the provider rejects", async () => {
    expect(
      await fetchStatus(
        vi.fn().mockResolvedValue(Response.json({ components: [] })),
      ),
    ).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await fetchStatus(
        vi.fn().mockResolvedValue(new Response("", { status: 503 })),
      ),
    ).toBeNull();
    warn.mockRestore();
  });
  it("selects worst severity and describes component problems", () => {
    expect(
      deriveIndicator([
        { name: "Login", status: "operational" },
        { name: "Matchmaking", status: "partial_outage" },
        { name: "Game", status: "major_outage" },
      ]),
    ).toEqual({
      indicator: "critical",
      problems: ["Matchmaking: partial outage", "Game: major outage"],
    });
  });
  it("keeps initial operational polls silent and detects transitions", () => {
    expect(detectChange(null, operational)).toBeNull();
    expect(detectChange(null, { ...operational, indicator: "minor" })).toBe(
      "degraded",
    );
    expect(
      detectChange(operational, { ...operational, indicator: "critical" }),
    ).toBe("down");
    expect(
      detectChange({ ...operational, indicator: "major" }, operational),
    ).toBe("restored");
    expect(detectChange(operational, operational)).toBeNull();
  });
  it("escapes provider text in Telegram HTML", () => {
    expect(
      buildAlert("down", { ...operational, incidents: ["<login> & outage"] }),
    ).toContain("🔴 &lt;login&gt; &amp; outage");
    expect(buildAlert("restored", operational)).toContain(
      "Можно собираться: /fort",
    );
  });
});
