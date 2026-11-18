// Rockstar: midnight local time, 19 November 2026. This bot uses Moscow time.
// https://support.rockstargames.com/articles/29jV3Cv2cCgvwM1XgtMO5o/grand-theft-auto-vi-regional-pre-load-and-release-times-on-playstation-5-and-xbox-series-x-or-s
export const GTA_RELEASE_AT = Date.parse("2026-11-19T00:00:00+03:00") / 1000;

function hoursText(hours: number): string {
  const last = hours % 10;
  const teen = hours % 100 >= 11 && hours % 100 <= 14;
  return `${hours} ${!teen && last === 1 ? "час" : !teen && last >= 2 && last <= 4 ? "часа" : "часов"}`;
}
export function gtaReleaseContext(now: number): string {
  const elapsed = now - GTA_RELEASE_AT;
  if (elapsed < 0)
    return `До выхода GTA 6 по МСК ещё ${hoursText(Math.ceil(-elapsed / 3600))}`;
  if (elapsed < 3600) return "GTA 6 только что вышла по МСК";
  return `GTA 6 вышла уже ${hoursText(Math.floor(elapsed / 3600))} назад по МСК`;
}
export function gtaRoast(now: number): string {
  const elapsed = now - GTA_RELEASE_AT;
  const timing =
    elapsed < 0
      ? `До GTA 6 ещё ${hoursText(Math.ceil(-elapsed / 3600))}! Готовьте консоли`
      : elapsed < 3600
        ? "GTA 6 только что вышла!"
        : `GTA 6 вышла уже ${hoursText(Math.floor(elapsed / 3600))} назад!`;
  return `Какой нахуй Fortnite? ${timing} Хватит строить сараи — идите нахер в Вайс-Сити.`;
}
