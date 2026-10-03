// Preserve the bot service entrypoint while sharing the Mini App calculations.
export {
  buildWeeklyView,
  computeTeamDeltas,
  type TeamDelta,
} from "../../statistics/weekly";
export type { Success as TeamStatsSuccess } from "../../statistics/summary";
