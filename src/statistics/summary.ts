import type { EpicLink, ChatStats } from "../bot/db";
import type { PlayerStats } from "../bot/fortnite";
export type Success = [EpicLink, PlayerStats];
export type Delta = [number, number, number, number];
export function roundEven(n: number): number {
  const floor = Math.floor(n);
  return n - floor === 0.5
    ? floor % 2 === 0
      ? floor
      : floor + 1
    : Math.round(n);
}
export function totals(stats: PlayerStats): Delta {
  return stats.squad
    ? [stats.squad.matches, stats.squad.wins, stats.squad.kills, stats.squad.kd]
    : [0, 0, 0, 0];
}
export function rank(successes: Success[]): Success[] {
  return [...successes].sort(
    (a, b) =>
      totals(b[1])[1] - totals(a[1])[1] || totals(b[1])[2] - totals(a[1])[2],
  );
}

export function formatFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return String(value).toLowerCase();
  const negative = value < 0 || Object.is(value, -0);
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, Math.abs(value));
  const bits = bytes.getBigUint64(0),
    exponent = Number((bits >> 52n) & 2047n);
  const mantissa = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
  const power = (exponent || 1) - 1023 - 52;
  let numerator = mantissa * 10n ** BigInt(digits),
    denominator = 1n;
  if (power >= 0) numerator <<= BigInt(power);
  else denominator <<= BigInt(-power);
  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  if (
    remainder * 2n > denominator ||
    (remainder * 2n === denominator && rounded % 2n === 1n)
  )
    rounded++;
  const text = rounded.toString().padStart(digits + 1, "0");
  return (
    (negative ? "-" : "") +
    (digits ? text.slice(0, -digits) + "." + text.slice(-digits) : text)
  );
}
export function teamSummary(successes: Success[]) {
  let matches = 0,
    wins = 0,
    kills = 0,
    deaths = 0;
  for (const [, stats] of successes) {
    const [m, w, k, kd] = totals(stats);
    matches += m;
    wins += w;
    kills += k;
    if (kd > 0) deaths += roundEven(k / kd);
  }
  return {
    matches,
    wins,
    kills,
    kd: deaths > 0 ? kills / deaths : 0,
    winRate: matches > 0 ? wins / matches : 0,
  };
}
export function gatheringSummary(stats: ChatStats) {
  return {
    ...stats,
    completionRate: stats.total_sessions
      ? stats.completed_sessions / stats.total_sessions
      : 0,
  };
}
export function teamFacts(
  successes: Success[],
  options: {
    weekly_missing?: [EpicLink, string][];
    deltas_24h?: Map<string, Delta> | Record<string, Delta>;
  } = {},
) {
  if (!successes.length) return "";
  const {
    matches: tm,
    wins: tw,
    kills: tk,
    kd: teamKd,
    winRate: rate,
  } = teamSummary(successes);
  const [mvpLink, mvpStats] = rank(successes)[0]!;
  const [mm, mw, mk, mkd] = totals(mvpStats);
  const factLines = [
    "Статистика ТОЛЬКО за последние 7 дней (свежая форма, не за сезон).",
    "",
    `Игроков: ${successes.length}`,
    `За неделю (все режимы): ${tm} матчей, ${tw} побед (${formatFixed(rate * 100, 1)}%), ${tk} киллов, K/D ${formatFixed(teamKd, 2)}`,
    `MVP недели: ${mvpLink.user_name || mvpStats.epic_name} — ${mm}M, ${mw}W, ${mk}K, K/D ${formatFixed(mkd, 2)}`,
    "Топ недели:",
  ];
  // Fact ranking reads overall, which is the weekly mode in callers.
  [...successes]
    .sort(
      (a, b) =>
        b[1].overall.wins - a[1].overall.wins ||
        b[1].overall.kills - a[1].overall.kills,
    )
    .slice(0, 5)
    .forEach(([link, s], i) => {
      const [m, w, k, kd] = totals(s);
      factLines.push(
        `${i + 1}. ${link.user_name || s.epic_name} ${m}M ${w}W ${k}K K/D ${formatFixed(kd, 2)}`,
      );
    });
  const deltaLines: string[] = [];
  for (const [link, s] of successes) {
    const d =
      options.deltas_24h instanceof Map
        ? options.deltas_24h.get(s.epic_account_id)
        : options.deltas_24h?.[s.epic_account_id];
    if (!d) continue;
    const [m, w, k, kd] = d;
    deltaLines.push(
      m === 0
        ? `- ${link.user_name || s.epic_name}: 0 новых матчей`
        : `- ${link.user_name || s.epic_name}: +${m}M, +${w}W, +${k}K, K/D за период ${formatFixed(kd, 2)}`,
    );
  }
  if (deltaLines.length) factLines.push("Динамика за 24ч:", ...deltaLines);
  if (options.weekly_missing?.length)
    factLines.push(
      `Без недельных данных (НЕ оценивай и не упоминай как слабых): ${options.weekly_missing.map(([l]) => l.user_name || "?").join(", ")}`,
    );
  return factLines.join("\n");
}
