import { AsyncLocalStorage } from "node:async_hooks";
import { Agent, fetch as undiciFetch } from "undici";
interface HttpScope {
  agent: Agent;
  signal?: AbortSignal;
  cleanup: (() => void)[];
}
const http = new AsyncLocalStorage<HttpScope>();
export async function withHttpClient<T>(
  factory: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (http.getStore()) return factory();
  const agent = new Agent({
    connect: { timeout: 10000 },
    bodyTimeout: 30000,
    headersTimeout: 30000,
  });
  const scope: HttpScope = { agent, signal, cleanup: [] };
  try {
    return await http.run(scope, factory);
  } finally {
    for (const cleanup of scope.cleanup) cleanup();
    await agent.destroy();
  }
}
export function httpSignal(timeoutMs: number): AbortSignal {
  const deadline = http.getStore()?.signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return deadline ? AbortSignal.any([deadline, timeout]) : timeout;
}
export const scopedFetch: typeof fetch = (input, init) => {
  const scope = http.getStore();
  let incoming = init?.signal;
  // grammY's Node fetch shim supplies an older AbortSignal implementation.
  if (incoming && typeof incoming.throwIfAborted !== "function") {
    const controller = new AbortController();
    const original = incoming;
    const abort = () => controller.abort();
    if (original.aborted) abort();
    else original.addEventListener("abort", abort, { once: true });
    scope?.cleanup.push(() => original.removeEventListener("abort", abort));
    incoming = controller.signal;
  }
  const signal =
    scope?.signal && incoming
      ? AbortSignal.any([scope.signal, incoming])
      : (incoming ?? scope?.signal);
  // Keep fetch and its dispatcher on the same Undici protocol version.
  const fetchWithDispatcher = undiciFetch as unknown as typeof fetch;
  return fetchWithDispatcher(input, {
    ...init,
    signal,
    ...(scope ? { dispatcher: scope.agent } : {}),
  });
};
