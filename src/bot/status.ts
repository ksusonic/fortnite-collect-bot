/** Epic Games status polling. Broadcasts are enqueued durably by jobs.ts. */
import { httpSignal, scopedFetch } from "./transport";
export const POLL_INTERVAL = 180;
export const ALERT_START_HOUR = 18;
export const ALERT_MIN_INTERVAL_SEC = 300;
export const COMPONENTS_API =
  "https://status.epicgames.com/api/v2/components.json";
export const INCIDENTS_API =
  "https://status.epicgames.com/api/v2/incidents/unresolved.json";
export type Indicator = "none" | "minor" | "major" | "critical";
export type Change = "down" | "degraded" | "restored";
export interface ServerStatus {
  indicator: Indicator;
  description: string;
  incidents: string[];
}
interface Component {
  id: string;
  name: string;
  status: string;
  group?: boolean;
  components?: string[];
  group_id?: string;
}
const indicators: Record<string, Indicator> = {
  operational: "none",
  under_maintenance: "minor",
  degraded_performance: "minor",
  partial_outage: "major",
  major_outage: "critical",
};
const severity: Record<Indicator, number> = {
  none: 0,
  minor: 1,
  major: 2,
  critical: 3,
};
export function deriveIndicator(
  components: Pick<Component, "name" | "status">[],
) {
  let indicator: Indicator = "none";
  const problems: string[] = [];
  for (const component of components) {
    const current = indicators[component.status] ?? "none";
    if (severity[current] > severity[indicator]) indicator = current;
    if (component.status !== "operational")
      problems.push(
        `${component.name}: ${component.status.replaceAll("_", " ")}`,
      );
  }
  return { indicator, problems };
}
export async function fetchStatus(
  fetcher: typeof fetch = scopedFetch,
): Promise<ServerStatus | null> {
  // One shared deadline bounds both sequential provider calls and their body reads.
  const signal = httpSignal(20_000);
  try {
    const response = await fetcher(COMPONENTS_API, {
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Epic status HTTP ${response.status}`);
    }
    const data = (await response.json()) as { components?: Component[] };
    const components = data.components ?? [];
    const group = components.find(
      (item) => item.group && item.name === "Fortnite",
    );
    if (!group) return null;
    const children = new Set(group.components ?? []);
    const { indicator, problems } = deriveIndicator(
      components.filter((item) => children.has(item.id)),
    );
    const incidentResponse = await fetcher(INCIDENTS_API, {
      signal,
      cache: "no-store",
    });
    if (!incidentResponse.ok) {
      await incidentResponse.body?.cancel();
      throw new Error(`Epic incidents HTTP ${incidentResponse.status}`);
    }
    const incidentData = (await incidentResponse.json()) as {
      incidents?: { name: string; components?: Component[] }[];
    };
    const incidents = (incidentData.incidents ?? [])
      .filter((incident) =>
        incident.components?.some(
          (item) => item.group_id === group.id || children.has(item.id),
        ),
      )
      .map((incident) => incident.name);
    return {
      indicator,
      description:
        indicator === "none"
          ? "All Fortnite Systems Operational"
          : problems.join("; "),
      incidents,
    };
  } catch (error) {
    console.warn(
      "Failed to fetch Epic Games status",
      error instanceof Error ? error.name : "unknown",
    );
    return null;
  }
}
export function detectChange(
  old: ServerStatus | null,
  current: ServerStatus,
): Change | null {
  if (old?.indicator === current.indicator) return null;
  if (current.indicator === "major" || current.indicator === "critical")
    return "down";
  if (current.indicator === "minor") return "degraded";
  return old && current.indicator === "none" ? "restored" : null;
}
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
export function buildAlert(change: Change, status: ServerStatus): string {
  if (change === "restored")
    return "<b>✅ Серверы Fortnite снова в строю.</b>\n\nМожно собираться: /fort";
  return [
    "<b>⚠️ Проблемы с серверами Fortnite</b>",
    "",
    ...(status.incidents.length ? status.incidents : [status.description]).map(
      (name) => `🔴 ${escapeHtml(name)}`,
    ),
    "",
    "Серверы могут быть недоступны.",
  ].join("\n");
}
