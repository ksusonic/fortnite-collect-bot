// Animated Fluent custom emoji, verified with getStickerSet on 2026-10-19.
// Sets: https://t.me/addemoji/FluentEmojiSet4 (mentions, timeout),
// https://t.me/addemoji/FluentEmojiSet5 (reserve),
// https://t.me/addemoji/FluentEmojiSet6 (Go, Pass, cancellation),
// https://t.me/addemoji/FluentEmojiSet7 (squad).
const FORT_EMOJI_IDS = {
  "✅": "6334758581832779720",
  "❌": "6334578700012488415",
  "👊": "6334605569327892210",
  "🪑": "6334375857297032523",
  "📣": "6334390189602899866",
  "⏰": "6334603778326529773",
  "🔄": "6334397787400046151",
} as const;

export function fortEmoji(emoji: keyof typeof FORT_EMOJI_IDS): string {
  return `<tg-emoji emoji-id="${FORT_EMOJI_IDS[emoji]}">${emoji}</tg-emoji>`;
}
