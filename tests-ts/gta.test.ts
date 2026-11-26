import { expect, it } from "vitest";
import { GTA_RELEASE_AT, gtaReleaseContext } from "../src/bot/services/gta";
it.each([
  [1, "1 час"],
  [2, "2 часа"],
  [5, "5 часов"],
  [11, "11 часов"],
  [21, "21 час"],
  [22, "22 часа"],
  [114, "114 часов"],
])("counts %i elapsed hours with Russian grammar", (hours, text) => {
  expect(gtaReleaseContext(GTA_RELEASE_AT + Number(hours) * 3600 + 59)).toBe(
    `GTA 6 вышла уже ${text} назад по МСК`,
  );
});
it("does not claim a release before Moscow midnight", () => {
  expect(gtaReleaseContext(GTA_RELEASE_AT - 3601)).toContain("ещё 2 часа");
  expect(gtaReleaseContext(GTA_RELEASE_AT - 1)).not.toContain("вышла");
  expect(gtaReleaseContext(GTA_RELEASE_AT - 1)).toContain("по МСК ещё 1 час");
});
it("handles the launch hour without saying zero hours ago", () => {
  expect(gtaReleaseContext(GTA_RELEASE_AT)).toContain("только что вышла");
  expect(gtaReleaseContext(GTA_RELEASE_AT + 3599)).toContain("только что");
  expect(gtaReleaseContext(GTA_RELEASE_AT + 7200)).toContain(
    "2 часа назад по МСК",
  );
});
