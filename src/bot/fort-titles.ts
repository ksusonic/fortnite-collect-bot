// Verified with Telegram getStickerSet and letter previews on 2026-10-19.
// Each kit contains F / O / R / T. Keep Telegram's own emoji fallbacks:
// tg-emoji requires an ordinary emoji inside the tag, not a Latin letter.
const FORT_TITLE_KITS: readonly (readonly [string, string][])[] = [
  // https://t.me/addemoji/WideABC — static wide lettering.
  [
    ["6032595855758855212", "🔡"],
    ["6033032185781423218", "⭕"],
    ["6032776386119208400", "🔡"],
    ["6033092396927945583", "🔡"],
  ],
  // https://t.me/addemoji/ABCEmoji — animated blue lettering.
  [
    ["5330369145244491360", "🔤"],
    ["5361583176550457135", "🔤"],
    ["5332514996804918116", "🔤"],
    ["5332558333024934589", "🔤"],
  ],
  // https://t.me/addemoji/LazerABC — static neon lettering.
  [
    ["6034825626685279404", "🔡"],
    ["6034922117420551058", "🔡"],
    ["6033000884059770733", "🔡"],
    ["6034942939422002468", "🔡"],
  ],
  // https://t.me/addemoji/HackermanABC — static chrome lettering.
  [
    ["6032608019106237475", "🔡"],
    ["6035186820549972171", "⭕"],
    ["6035122335910989366", "🔡"],
    ["6035042745872026486", "🔡"],
  ],
];

export function defaultFortTitle(style: number): string {
  // Reuse the checkpointed session style; never reroll during rendering.
  const index =
    ((style % FORT_TITLE_KITS.length) + FORT_TITLE_KITS.length) %
    FORT_TITLE_KITS.length;
  return (
    FORT_TITLE_KITS[index]!.map(
      ([id, emoji]) => `<tg-emoji emoji-id="${id}">${emoji}</tg-emoji>`,
    ).join("") + "\n"
  );
}
