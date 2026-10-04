import "server-only";
import { adminAuth, endpoint, HttpError, requestSignal } from "@/bot/http";
import { JOB_PERIODS, runJob, type JobName } from "@/bot/jobs";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  return endpoint(async () => {
    adminAuth(request);
    const { name } = await params;
    if (!Object.hasOwn(JOB_PERIODS, name))
      throw new HttpError(404, "unknown job");
    return runJob(name as JobName, requestSignal(request));
  });
}
