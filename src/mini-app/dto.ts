import type { Profile } from "../statistics/profile";
import type { Cached } from "../statistics/cache";
import type { WeeklyReport } from "../statistics/service";
import type { gatheringSummary } from "../statistics/summary";
export type { WeeklyReport, Profile };
export interface ChatsDTO {
  chats: { id: number; title: string }[];
  selected: number | null;
  viewerId: number;
  unavailable: number;
}
export type ProfileDTO =
  | { linked: false; instruction: string }
  | ({
      linked: true;
      name?: string;
      error: string | null;
      data: Profile | null;
    } & Partial<Omit<Cached<Profile>, "data" | "error">>);
export type GatheringsDTO = ReturnType<typeof gatheringSummary> & {
  updatedAt: number;
};
export interface AnalysisDTO {
  analysis: Cached<{
    text: string;
    reportAt: number;
    factsHash: string;
  }> | null;
  error?: string;
}
