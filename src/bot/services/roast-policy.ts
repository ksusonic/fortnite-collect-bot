export interface RoastPreferences {
  proactive: boolean;
  frequency: "rare" | "normal" | "active";
  length: "brief" | "normal" | "detailed";
  tone: "gentle" | "sharp";
  profanity: boolean;
}
export interface RoastPolicy {
  proactiveAllowed: boolean;
  defaults: RoastPreferences;
  intervals: Record<RoastPreferences["frequency"], number>;
}
export const DEFAULT_ROAST_POLICY: RoastPolicy = {
  proactiveAllowed: true,
  defaults: {
    proactive: false,
    frequency: "normal",
    length: "normal",
    tone: "sharp",
    profanity: true,
  },
  intervals: { rare: 1800, normal: 600, active: 300 },
};
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function parsePreferences(
  value: unknown,
): Partial<RoastPreferences> | null {
  if (!record(value)) return null;
  const allowed: Record<keyof RoastPreferences, readonly unknown[]> = {
    proactive: [true, false],
    frequency: ["rare", "normal", "active"],
    length: ["brief", "normal", "detailed"],
    tone: ["gentle", "sharp"],
    profanity: [true, false],
  };
  for (const [key, entry] of Object.entries(value))
    if (
      !Object.hasOwn(allowed, key) ||
      !allowed[key as keyof RoastPreferences].includes(entry)
    )
      return null;
  return value as Partial<RoastPreferences>;
}
export function parseRoastPolicy(value: unknown): RoastPolicy {
  if (
    !record(value) ||
    typeof value.proactiveAllowed !== "boolean" ||
    !record(value.intervals)
  )
    return DEFAULT_ROAST_POLICY;
  const defaults = parsePreferences(value.defaults);
  if (!defaults || Object.keys(defaults).length !== 5)
    return DEFAULT_ROAST_POLICY;
  const intervals = value.intervals;
  for (const key of ["rare", "normal", "active"])
    if (
      !Number.isInteger(intervals[key]) ||
      Number(intervals[key]) < 300 ||
      Number(intervals[key]) > 86400
    )
      return DEFAULT_ROAST_POLICY;
  if (
    Number(intervals.rare) < Number(intervals.normal) ||
    Number(intervals.normal) < Number(intervals.active)
  )
    return DEFAULT_ROAST_POLICY;
  return {
    proactiveAllowed: value.proactiveAllowed,
    defaults: defaults as RoastPreferences,
    intervals: intervals as RoastPolicy["intervals"],
  };
}
export type RoastDecision =
  | { action: "skip" }
  | { action: "reply" | "clarify"; text: string }
  | { action: "update"; text: string; patch: Partial<RoastPreferences> };
export function parseRoastDecision(
  value: unknown,
  addressed: boolean,
): RoastDecision | null {
  if (!record(value)) return null;
  if (value.action === "skip" && Object.keys(value).length === 1)
    return { action: "skip" };
  if (
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 3000
  )
    return null;
  if (
    (value.action === "reply" || (addressed && value.action === "clarify")) &&
    Object.keys(value).length === 2
  )
    return { action: value.action, text: value.text.trim() };
  if (
    addressed &&
    value.action === "update" &&
    Object.keys(value).length === 3
  ) {
    const patch = parsePreferences(value.patch);
    if (patch && Object.keys(patch).length)
      return { action: "update", text: value.text.trim(), patch };
  }
  return null;
}
export function proactiveDue(
  policy: RoastPolicy,
  preferences: RoastPreferences,
  last: number | null,
  now: number,
): boolean {
  return (
    policy.proactiveAllowed &&
    preferences.proactive &&
    (last === null || now - last >= policy.intervals[preferences.frequency])
  );
}
