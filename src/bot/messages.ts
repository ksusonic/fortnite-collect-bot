import type { Session, ChatStats, EpicLink } from "./db";
import {
  EpicNameNotFound,
  StatsPrivate,
  StatsEmpty,
  type FortniteError,
  type ModeStats,
  type PlayerStats,
} from "./fortnite";

export const STYLES = [
  {
    header: "🍕 {name} заказал пиццу и зовёт в катку.",
    done_header: "✅ Пицца в пути, скуад в сборе.",
    done_footer: "Приятной игры.",
  },
  {
    header: "💻 {name} закрыл ноут и сел за PC.",
    done_header: "✅ Все собрались.",
    done_footer: "Поехали.",
  },
  {
    header: "☕ {name} заварил чай и открыл Fortnite.",
    done_header: "✅ Все четверо в сборе.",
    done_footer: "Хорошей катки.",
  },
  {
    header: "🪂 {name} готовится к прыжку.",
    done_header: "✅ Автобус укомплектован.",
    done_footer: "Увидимся на острове.",
  },
  {
    header: "📅 {name} нашёл свободный вечер.",
    done_header: "✅ Скуад собран.",
    done_footer: "Поехали.",
  },
  {
    header: "📦 {name} видит лут — нужна команда.",
    done_header: "✅ Скуад собран.",
    done_footer: "К высадке.",
  },
  {
    header: "🏆 {name} объявил сбор на Victory Royale.",
    done_header: "✅ Отряд укомплектован.",
    done_footer: "Ни пуха.",
  },
  {
    header: "🎧 {name} надел наушники.",
    done_header: "✅ Все в сборе.",
    done_footer: "Удачной катки.",
  },
  {
    header: "🌙 {name} открывает вечернюю катку.",
    done_header: "✅ Все на местах.",
    done_footer: "Хорошей игры.",
  },
  {
    header: "🎮 {name} заебался работать — го катка.",
    done_header: "✅ Наконец-то все собрались.",
    done_footer: "Поехали.",
  },
  {
    header: "🧠 {name} понял: без катки никуда.",
    done_header: "✅ Гипотеза подтверждена — скуад собран.",
    done_footer: "Переходим к практике.",
  },
  {
    header: "💢 {name} предлагает забить на дела.",
    done_header: "✅ Скуад собран.",
    done_footer: "Погнали нагибать.",
  },
  {
    header: "🍻 {name} берёт пиво и зовёт ебашить.",
    done_header: "✅ Все в сборе, заебись.",
    done_footer: "Погнали.",
  },
  {
    header: "😤 {name} пришёл с работы и охуел.",
    done_header: "✅ Спасены — все собрались.",
    done_footer: "Поехали.",
  },
  {
    header: "🎓 {name} утверждает: Fortnite важнее сна.",
    done_header: "✅ Научный совет в сборе.",
    done_footer: "Приступаем к защите.",
  },
  {
    header: "🤙 {name} зовёт катнуть по-пацански.",
    done_header: "✅ Команда в сборе, пацаны.",
    done_footer: "Погнали.",
  },
  {
    header: "🎯 {name} хочет кого-нибудь нахлобучить.",
    done_header: "✅ Скуад собран, ща всех нахлобучим.",
    done_footer: "Поехали.",
  },
  {
    header: "🌚 {name} зовёт катнуть до полуночи.",
    done_header: "✅ Все четверо в сборе.",
    done_footer: "До рассвета.",
  },
  {
    header: "🍿 {name} принёс снеки и зовёт играть.",
    done_header: "✅ Скуад собран — снеки на столе.",
    done_footer: "Поехали.",
  },
  {
    header: "🚌 {name} завёл боевой автобус — запрыгивайте.",
    done_header: "🚌 Скуад на борту — можно взлетать.",
    done_footer: "🪂 Увидимся на высадке.",
  },
  {
    header: "🦙 {name} нашёл ламу с лутом и зовёт делить добычу.",
    done_header: "🎒 Скуад собран — лута хватит всем.",
    done_footer: "💎 Забираем легендарки.",
  },
  {
    header: "🌀 {name} зовёт в катку, пока зона не закрылась.",
    done_header: "🛡 Скуад собран — держимся вместе.",
    done_footer: "🏃 Погнали в зону.",
  },
  {
    header: "👑 {name} зовёт за короной Victory Royale.",
    done_header: "🔥 Все четверо на месте — идём за победой.",
    done_footer: "🏆 Корона сама себя не заберёт.",
  },
];
const STATS_STYLES = [
  {
    title: "📊 <b>Статистика сборов</b>",
    sessions_header: "🎮 <b>Сводка</b>",
    speed_header: "⏱ <b>Время до сбора</b>",
    record_comment: "рекорд чата",
    top_players_header: "🏆 <b>Самые активные</b>",
    top_initiators_header: "📢 <b>Кто чаще зовёт</b>",
    top_passers_header: "😴 <b>Чаще пасуют</b>",
    streaks_header: "🔥 <b>Серии участия</b>",
    best_hours_header: "🕒 <b>Лучшее время</b>",
  },
  {
    title: "📋 <b>Сводка по чату</b>",
    sessions_header: "🎮 <b>Сессии</b>",
    speed_header: "⚡ <b>Скорость сбора</b>",
    record_comment: "минимальное время",
    top_players_header: "⭐ <b>Лидеры по участию</b>",
    top_initiators_header: "📡 <b>Чаще зовут</b>",
    top_passers_header: "🛋 <b>Чаще пасуют</b>",
    streaks_header: "💪 <b>Серии подряд</b>",
    best_hours_header: "🎯 <b>Пиковые часы</b>",
  },
  {
    title: "📈 <b>Отчёт по сборам</b>",
    sessions_header: "🗂 <b>Итого</b>",
    speed_header: "🚀 <b>Скорость сбора</b>",
    record_comment: "лучший результат",
    top_players_header: "👑 <b>Топ участников</b>",
    top_initiators_header: "🔔 <b>Топ инициаторов</b>",
    top_passers_header: "🐌 <b>Топ пасующих</b>",
    streaks_header: "🔥 <b>Серии подряд</b>",
    best_hours_header: "⏰ <b>Популярное время</b>",
  },
];

export const SQUAD_SIZE = 4;
export const RESERVE_SIZE = 4;
export const PLAY_DEADLINE_HOUR = 23;
export const NOW_SLOT = "now";
export const SLOT_OFFERS_MIN = [30, 60, 120];
export const SESSION_TIMEOUT = 60 * 60;
export const SESSION_TIMEOUT_TRACTION = 3 * 60 * 60;
const DIVIDER = "─────────────────────";
const TEAM_DIVIDER = "─".repeat(20);
const MEDALS = ["🥇", "🥈", "🥉"];

// Python's round uses ties to even; preserve persisted-stat arithmetic parity.
export function roundEven(n: number): number {
  const floor = Math.floor(n);
  return n - floor === 0.5
    ? floor % 2 === 0
      ? floor
      : floor + 1
    : Math.round(n);
}
// Decimal formatting uses Python's ties-to-even rule on the exact IEEE value.
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
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}
export function randomStyle(): number {
  return Math.floor(Math.random() * STYLES.length);
}
export function randomStatsStyle(): number {
  return Math.floor(Math.random() * STATS_STYLES.length);
}
function mskDate(now: number): Date {
  return new Date((now + 10800) * 1000);
}
function nowSeconds(): number {
  return Date.now() / 1000;
}
function pad(value: number): string {
  return String(value).padStart(2, "0");
}
function stamp(now: number): string {
  const d = mskDate(now);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function generateTimeSlots(
  startHour?: number | null,
  now = nowSeconds(),
): string[] {
  if (startHour != null) return [`${pad(startHour)}:00`];
  const d = mskDate(now);
  const seconds =
    d.getUTCHours() * 3600 +
    d.getUTCMinutes() * 60 +
    d.getUTCSeconds() +
    d.getUTCMilliseconds() / 1000;
  return [
    NOW_SLOT,
    ...SLOT_OFFERS_MIN.filter(
      (minutes) => seconds + minutes * 60 <= PLAY_DEADLINE_HOUR * 3600,
    ).map(String),
  ];
}
function userLink(uid: number, name: string): string {
  return `<a href="tg://user?id=${uid}">${escapeHtml(name)}</a>`;
}
function userCode(name: string): string {
  return `<code>${escapeHtml(name)}</code>`;
}
export function buildTagLine(users: Map<number, string>): string {
  return users.size
    ? `📣 ${[...users].map(([uid, name]) => userLink(uid, name)).join(" ")}`
    : "";
}
function playerList(players: Map<number, string>): string {
  return players.size
    ? [...players]
        .map(([uid, name], i) => `   ${i + 1}. ${userLink(uid, name)}`)
        .join("\n")
    : "   (пока пусто)";
}
function etaLabel(slot: string, now: number): string {
  if (slot === NOW_SLOT) return "сейчас";
  let label = `≈ ${slot}`;
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(slot);
  if (match && Number(match[1]) < 24 && Number(match[2]) < 60) {
    const d = mskDate(now);
    const delta = roundEven(
      (Number(match[1]) * 3600 +
        Number(match[2]) * 60 -
        (d.getUTCHours() * 3600 +
          d.getUTCMinutes() * 60 +
          d.getUTCSeconds() +
          d.getUTCMilliseconds() / 1000)) /
        60,
    );
    if (delta > 0) label += ` (через ~${delta}м)`;
  }
  return label;
}
export function splitRoster(
  session: Session,
): [Map<number, string>, Map<number, string>] {
  const players = [...session.go_players];
  return [
    new Map(players.slice(0, SQUAD_SIZE)),
    new Map(players.slice(SQUAD_SIZE, SQUAD_SIZE + RESERVE_SIZE)),
  ];
}
function playerEtaList(
  session: Session,
  players: Map<number, string>,
  now: number,
  preserveOrder = false,
): string {
  if (!players.size) return "   (пока пусто)";
  const entries = [...players];
  if (!preserveOrder)
    entries.sort((a, b) => {
      const sa = session.player_slots.get(a[0]) || NOW_SLOT,
        sb = session.player_slots.get(b[0]) || NOW_SLOT;
      return sa === sb
        ? 0
        : sa === NOW_SLOT
          ? -1
          : sb === NOW_SLOT
            ? 1
            : sa < sb
              ? -1
              : 1;
    });
  return entries
    .map(([uid, name], i) => {
      const slot = session.player_slots.get(uid);
      return `   ${i + 1}. ${userLink(uid, name)}${slot ? ` — ${etaLabel(slot, now)}` : ""}`;
    })
    .join("\n");
}
function styleFor(session: Session) {
  return STYLES[
    ((session.style % STYLES.length) + STYLES.length) % STYLES.length
  ]!;
}
export function buildGatherText(session: Session, now = nowSeconds()): string {
  const style = styleFor(session),
    [squad, reserve] = splitRoster(session),
    count = squad.size;
  const players = session.time_slots.length
    ? playerEtaList(session, squad, now)
    : playerList(squad);
  if (count === SQUAD_SIZE) {
    const lines = [
      session.fort_title || "🎮 <b>FORT</b>",
      style.done_header,
      DIVIDER,
      `👊 <b>Состав</b> ${count}`,
      players,
    ];
    if (reserve.size)
      lines.push(
        DIVIDER,
        `🪑 <b>Резерв</b> ${reserve.size}/${RESERVE_SIZE}`,
        session.time_slots.length
          ? playerEtaList(session, reserve, now, true)
          : playerList(reserve),
      );
    lines.push(
      DIVIDER,
      "❌ <b>Пас</b>",
      playerList(session.pass_players),
      DIVIDER,
      style.done_footer,
    );
    return lines.join("\n");
  }
  const header = (session.llm_header || style.header).replaceAll(
    "{name}",
    userLink(session.initiator_id, session.initiator_name),
  );
  const pending = new Map(
    [...session.tagged_users].filter(
      ([uid]) => !session.go_players.has(uid) && !session.pass_players.has(uid),
    ),
  );
  const lines = [
    session.fort_title || "🎮 <b>FORT</b>",
    header,
    DIVIDER,
    `✅ <b>Go</b> ${count}/${SQUAD_SIZE}`,
    players,
    DIVIDER,
    "❌ <b>Пас</b>",
    playerList(session.pass_players),
  ];
  if (pending.size) lines.push("", buildTagLine(pending));
  return lines.join("\n");
}
function buildClosedText(
  session: Session,
  footer: string,
  now: number,
): string {
  const [squad, reserve] = splitRoster(session);
  const header = (session.llm_header || styleFor(session).header).replaceAll(
    "{name}",
    userLink(session.initiator_id, session.initiator_name),
  );
  const lines = [
    session.fort_title || "🎮 <b>FORT</b>",
    header,
    DIVIDER,
    `✅ <b>Go</b> ${squad.size}/${SQUAD_SIZE}`,
    session.time_slots.length
      ? playerEtaList(session, squad, now)
      : playerList(squad),
  ];
  if (reserve.size)
    lines.push(
      DIVIDER,
      `🪑 <b>Резерв</b> ${reserve.size}/${RESERVE_SIZE}`,
      session.time_slots.length
        ? playerEtaList(session, reserve, now, true)
        : playerList(reserve),
    );
  lines.push(
    DIVIDER,
    "❌ <b>Пас</b>",
    playerList(session.pass_players),
    DIVIDER,
    footer,
  );
  return lines.join("\n");
}
export function buildExpiredText(session: Session, now = nowSeconds()): string {
  const [squad] = splitRoster(session);
  return buildClosedText(
    session,
    squad.size >= 2
      ? `⏰ Окно закрылось. В деле было ${squad.size} — добивайте в игре 🎮`
      : "⏰ Время вышло — сбор отменён.",
    now,
  );
}
export function buildCancelledText(
  session: Session,
  now = nowSeconds(),
): string {
  return buildClosedText(session, "🔄 Сбор отменён — запущен новый.", now);
}
export function buildKeyboard(goCount: number, timeSlots?: string[] | null) {
  if (timeSlots?.length)
    return {
      inline_keyboard: [
        timeSlots.map((slot) => ({
          text:
            slot === NOW_SLOT
              ? "⚡ Сейчас"
              : /^\d+$/.test(slot)
                ? Number(slot) % 60 === 0
                  ? `🕐 +${Number(slot) / 60}ч`
                  : `🕐 +${slot}м`
                : `🕐 ${slot}`,
          callback_data: `slot:${slot}`,
        })),
        [{ text: "❌ Пас", callback_data: "pass" }],
      ],
    };
  return {
    inline_keyboard: [
      [
        { text: `✅ Go (${goCount}/${SQUAD_SIZE})`, callback_data: "go" },
        { text: "❌ Пас", callback_data: "pass" },
      ],
    ],
  };
}
function bar(value: number, max: number, width = 8): string {
  const filled = max ? roundEven((value / max) * width) : 0;
  return max ? "█".repeat(filled) + "░".repeat(width - filled) : "";
}
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${formatFixed(seconds, 0)}s`;
  const mins = Math.floor(seconds / 60),
    secs = Math.floor(seconds % 60);
  return mins < 60
    ? `${mins}m ${secs}s`
    : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
function section(lines: string[], header: string, body: string[]): void {
  if (body.length) lines.push(DIVIDER, header, ...body);
}
export function buildStatsText(stats: ChatStats, styleIndex = 0): string {
  if (!stats.total_sessions)
    return `📊 <b>Статистика</b>\n${DIVIDER}\nПока ничего не собрано.\nЗапустите /fort, чтобы появились данные.`;
  const style =
    STATS_STYLES[
      ((styleIndex % STATS_STYLES.length) + STATS_STYLES.length) %
        STATS_STYLES.length
    ]!;
  const lines = [style.title];
  const summary = [
    `🎮 Всего: <b>${stats.total_sessions}</b>`,
    `✅ <b>${stats.completed_sessions}</b>`,
    `⏰ <b>${stats.expired_sessions}</b>`,
  ];
  if (stats.active_sessions > 0)
    summary.push(`🟡 <b>${stats.active_sessions}</b>`);
  section(lines, style.sessions_header, [
    summary.join("  ·  "),
    `📈 Процент сборки: <b>${formatFixed((stats.completed_sessions / stats.total_sessions) * 100, 0)}%</b>`,
  ]);
  if (stats.avg_fill_seconds != null)
    section(lines, style.speed_header, [
      `   Среднее: <b>${formatDuration(stats.avg_fill_seconds)}</b>`,
      `   Рекорд:  <b>${formatDuration(stats.fastest_fill_seconds ?? 0)}</b> — ${style.record_comment}`,
    ]);
  if (stats.top_players.length)
    section(
      lines,
      style.top_players_header,
      stats.top_players
        .slice(0, 5)
        .map(
          ([name, count], i) =>
            `${MEDALS[i] || `   ${i + 1}.`} ${escapeHtml(name)}  ${bar(count, stats.top_players[0]![1])} <b>${count}</b>`,
        ),
    );
  for (const [rows, header] of [
    [stats.top_initiators, style.top_initiators_header],
    [stats.top_passers, style.top_passers_header],
  ] as const) {
    if (rows.length)
      section(
        lines,
        header,
        rows
          .slice(0, 3)
          .map(
            ([name, count], i) =>
              `   ${i + 1}. ${escapeHtml(name)}  ${bar(count, rows[0]![1], 6)} <b>${count}</b>`,
          ),
      );
  }
  section(
    lines,
    style.streaks_header,
    stats.top_streaks
      .slice(0, 3)
      .map(
        ([name, count], i) =>
          `${MEDALS[i] || `   ${i + 1}.`} ${escapeHtml(name)}  <b>${count}</b> ${"🔥".repeat(Math.min(count, 5))}`,
      ),
  );
  section(
    lines,
    style.best_hours_header,
    stats.best_hours.map(
      ([hour, count, avg]) =>
        `   ${pad(hour)}:00 — <b>${count}</b> сборов, среднее <b>${avg ? formatDuration(avg) : "—"}</b>`,
    ),
  );
  return lines.join("\n");
}
function modeBlock(mode: ModeStats): string[] {
  return [
    `   Матчи: <b>${mode.matches}</b>  ·  Победы: <b>${mode.wins}</b>  ·  K/D: <b>${formatFixed(mode.kd, 2)}</b>`,
    `   Win rate: <b>${formatFixed(mode.win_rate * 100, 1)}%</b>  ·  Киллы: <b>${mode.kills}</b>`,
    `   В игре: <b>${Math.floor(mode.minutes_played / 60)}ч ${mode.minutes_played % 60}м</b>`,
  ];
}
export function myFnCaption(link: EpicLink, stats: PlayerStats): string {
  return `🎯 ${userLink(link.user_id, link.user_name)} · Epic <b>${escapeHtml(stats.epic_name)}</b>\n🗓 обновлено ${stamp(stats.fetched_at)} MSK`;
}
export function buildMyFnStatsText(link: EpicLink, stats: PlayerStats): string {
  const lines = [
    `🎮 <b>Fortnite stats</b> — ${userLink(link.user_id, link.user_name)}`,
    `🎭 Epic: <b>${escapeHtml(stats.epic_name)}</b>`,
  ];
  section(lines, "📊 <b>Overall</b>", modeBlock(stats.overall));
  for (const [title, mode] of [
    ["🧍 <b>Solo</b>", stats.solo],
    ["👥 <b>Duo</b>", stats.duo],
    ["👪 <b>Squad</b>", stats.squad],
  ] as const)
    if (mode) section(lines, title, modeBlock(mode));
  lines.push(DIVIDER, `🕓 Обновлено: ${stamp(stats.fetched_at)} MSK`);
  return lines.join("\n");
}
export type Success = [EpicLink, PlayerStats];
export type Delta = [number, number, number, number];
export type WeeklyMissing = [EpicLink, string];
function totals(stats: PlayerStats): Delta {
  return stats.squad
    ? [stats.squad.matches, stats.squad.wins, stats.squad.kills, stats.squad.kd]
    : [0, 0, 0, 0];
}
function rank(successes: Success[]): Success[] {
  return [...successes].sort(
    (a, b) =>
      totals(b[1])[1] - totals(a[1])[1] || totals(b[1])[2] - totals(a[1])[2],
  );
}
function pluralPlayers(n: number): string {
  return n % 100 >= 11 && n % 100 <= 14
    ? "игроков"
    : n % 10 === 1
      ? "игрок"
      : n % 10 >= 2 && n % 10 <= 4
        ? "игрока"
        : "игроков";
}
function short(name: string): string {
  const chars = Array.from(name);
  return chars.length <= 14 ? name : chars.slice(0, 13).join("") + "…";
}
function leadersTable(successes: Success[]): string {
  const headers = ["Игрок", "M", "W", "K", "K/D"];
  const rows = rank(successes)
    .slice(0, 5)
    .map(([link, s], i) => {
      const [m, w, k, kd] = totals(s);
      return [
        MEDALS[i] ? `${MEDALS[i]} ` : "   ",
        [
          short(link.user_name || s.epic_name),
          String(m),
          String(w),
          String(k),
          formatFixed(kd, 2),
        ],
      ] as [string, string[]];
    });
  const length = (s: string) => Array.from(s).length;
  const widths = headers.map((h, i) =>
    Math.max(length(h), ...rows.map(([, cells]) => length(cells[i]!))),
  );
  const fmt = (medal: string, cells: string[]) =>
    [
      medal,
      ...cells.map((c, i) =>
        i === 0
          ? c + " ".repeat(widths[i]! - length(c))
          : " ".repeat(widths[i]! - length(c)) + c,
      ),
    ]
      .join("  ")
      .trimEnd();
  return `<pre>${escapeHtml([fmt("   ", headers), ["───", ...widths.map((w) => "─".repeat(w))].join("  "), ...rows.map(([medal, cells]) => fmt(medal, cells))].join("\n"))}</pre>`;
}
export function buildTeamFnStatsText(
  successes: Success[],
  failures: [EpicLink, FortniteError][],
  options: {
    weekly_missing?: WeeklyMissing[];
    deltas_24h?: Map<string, Delta> | Record<string, Delta>;
  } = {},
): [string, string] {
  const lines = [
    `🏆 <b>Fortnite Squad</b> — ${successes.length} ${pluralPlayers(successes.length)} · за неделю`,
  ];
  let facts = "";
  if (!successes.length)
    lines.push("", "Не удалось получить ни одну статистику.");
  else {
    let tm = 0,
      tw = 0,
      tk = 0,
      deaths = 0;
    for (const [, s] of successes) {
      const [m, w, k, kd] = totals(s);
      tm += m;
      tw += w;
      tk += k;
      if (kd > 0) deaths += roundEven(k / kd);
    }
    const teamKd = deaths > 0 ? tk / deaths : 0,
      rate = tm > 0 ? tw / tm : 0;
    const ranked = rank(successes),
      [mvpLink, mvpStats] = ranked[0]!,
      [mm, mw, mk, mkd] = totals(mvpStats);
    lines.push(
      "",
      `🥇 <b>MVP недели</b>: ${userCode(mvpLink.user_name || mvpStats.epic_name)}`,
      `   🎯 ${mw}W · 💥 ${mk}K · ⚔️ ${formatFixed(mkd, 2)} K/D · 🎮 ${mm}M`,
      "",
      TEAM_DIVIDER,
      "📊 <b>Сводка за неделю</b>",
      `• 🎮 ${tm} матчей  ·  🏆 ${tw}W (${formatFixed(rate * 100, 1)}%)`,
      `• 💥 ${tk} киллов  ·  ⚔️ K/D ${formatFixed(teamKd, 2)}`,
      TEAM_DIVIDER,
      "🏅 <b>Лидеры недели</b>",
      leadersTable(successes),
    );
    if (options.weekly_missing?.length)
      section(
        lines,
        "💤 <b>Вне недельного зачёта</b>",
        options.weekly_missing.map(
          ([link, reason]) =>
            `   ${userCode(link.user_name || "?")} — ${escapeHtml(reason)}`,
        ),
      );
    const factLines = [
      "Статистика ТОЛЬКО за последние 7 дней (свежая форма, не за сезон).",
      "",
      `Игроков: ${successes.length}`,
      `За неделю (все режимы): ${tm} матчей, ${tw} побед (${formatFixed(rate * 100, 1)}%), ${tk} киллов, K/D ${formatFixed(teamKd, 2)}`,
      `MVP недели: ${mvpLink.user_name || mvpStats.epic_name} — ${mm}M, ${mw}W, ${mk}K, K/D ${formatFixed(mkd, 2)}`,
      "Топ недели:",
    ];
    // Legacy fact ranking reads overall, which is the weekly mode in callers.
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
    facts = factLines.join("\n");
  }
  const groups = {
    private: [] as EpicLink[],
    empty: [] as EpicLink[],
    missing: [] as EpicLink[],
    unavailable: [] as EpicLink[],
  };
  for (const [link, error] of failures)
    (error instanceof StatsPrivate
      ? groups.private
      : error instanceof StatsEmpty
        ? groups.empty
        : error instanceof EpicNameNotFound
          ? groups.missing
          : groups.unavailable
    ).push(link);
  const errorBody: string[] = [];
  for (const [links, label] of [
    [groups.private, "🔒 Приватный профиль"],
    [groups.empty, "💭 Без матчей"],
    [groups.missing, "👻 Не найден"],
    [groups.unavailable, "🚫 API недоступен"],
  ] as const)
    if (links.length)
      errorBody.push(
        `   ${label}: ${links.map((l) => userCode(l.user_name)).join(", ")}`,
      );
  section(lines, "⚠️ <b>Без данных</b>", errorBody);
  return [lines.join("\n"), facts];
}
