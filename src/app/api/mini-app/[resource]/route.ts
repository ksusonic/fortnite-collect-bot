import { miniAppEndpoint } from "@/mini-app/api";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(
  request: Request,
  context: { params: Promise<{ resource: string }> },
) {
  return miniAppEndpoint(request, (await context.params).resource);
}
export async function POST(
  request: Request,
  context: { params: Promise<{ resource: string }> },
) {
  return miniAppEndpoint(request, (await context.params).resource);
}
