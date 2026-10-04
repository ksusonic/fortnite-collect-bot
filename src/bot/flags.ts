import { createClient } from "@vercel/flags-core";
import { httpSignal, scopedFetch } from "./transport";
import { externalCheckpoint } from "./work";
import {
  DEFAULT_ROAST_POLICY,
  parseRoastPolicy,
} from "./services/roast-policy";

export async function getRoastPolicy() {
  return externalCheckpoint("roast-policy-v1", async () => {
    try {
      // One bounded fetch per work item. No streams, background polling or metrics tasks.
      const client = createClient(process.env.FLAGS, {
        stream: false,
        polling: false,
        disableMetrics: true,
        fetch: (input, init) =>
          scopedFetch(input, { ...init, signal: httpSignal(5000) }),
      });
      try {
        const result = await client.evaluate(
          "roast-policy",
          DEFAULT_ROAST_POLICY,
        );
        return parseRoastPolicy(result.value);
      } finally {
        await client.shutdown();
      }
    } catch {
      return DEFAULT_ROAST_POLICY;
    }
  });
}
