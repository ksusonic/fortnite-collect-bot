import { GrammyError, type Transformer } from "grammy";
import {
  connection,
  current,
  maybeCurrent,
  query,
  raw,
  transaction,
  withoutWork,
  type Checkpointer,
} from "./storage";

export class AmbiguousOutcome extends Error {
  constructor(id: string) {
    super(`uncertain Telegram outcome for ${id}`);
    this.name = "AmbiguousOutcome";
  }
}
interface Step {
  signature: string;
  status: string;
  result: unknown;
}
export class Work implements Checkpointer {
  private counters = new Map<string, number>();
  constructor(readonly id: string) {}
  private next(category: string) {
    const index = this.counters.get(category) ?? 0;
    this.counters.set(category, index + 1);
    return `${category}:${index}`;
  }
  private async previous(
    step: string,
    signature: string,
  ): Promise<Step | undefined> {
    const row = (
      await raw<Step>(
        "SELECT signature,status,result FROM work_steps WHERE work_id=$1 AND step=$2",
        [this.id, step],
      )
    ).rows[0];
    if (row && row.signature !== signature)
      throw new Error(
        "recovery checkpoint differs from deployed handler; manual review required",
      );
    return row;
  }
  private async save(
    step: string,
    signature: string,
    status: string,
    result: unknown = null,
  ) {
    await raw(
      "INSERT INTO work_steps(work_id,step,signature,status,result) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(work_id,step) DO UPDATE SET status=excluded.status,result=excluded.result",
      [this.id, step, signature, status, JSON.stringify(result ?? null)],
    );
  }
  async databaseStep<T>(
    signature: string,
    factory: () => Promise<T>,
  ): Promise<T> {
    const step = this.next("db");
    const old = await this.previous(step, signature);
    if (old) return old.result as T;
    return transaction(async () => {
      const result = await factory();
      await this.save(step, signature, "complete", result);
      return result;
    });
  }
  async valueStep<T>(name: string, factory: () => T): Promise<T> {
    const step = this.next("value");
    const old = await this.previous(step, name);
    if (old) return old.result as T;
    const result = factory();
    await this.save(step, name, "complete", result);
    return result;
  }
  async externalStep<T>(name: string, factory: () => Promise<T>): Promise<T> {
    const step = this.next("external");
    const old = await this.previous(step, name);
    if (old) return old.result as T;
    const result = await withoutWork(factory);
    await this.save(step, name, "complete", result);
    return result;
  }
  private async ambiguous(step: string): Promise<never> {
    await connection().query(
      "UPDATE work_items SET status='ambiguous',error=$1,updated_at=now() WHERE id=$2",
      [
        `uncertain Telegram outcome at ${step}; inspect work_steps before recovery`,
        this.id,
      ],
    );
    throw new AmbiguousOutcome(this.id);
  }
  async telegram<T>(
    name: string,
    payload: unknown,
    send: () => Promise<{
      ok: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: unknown;
    }>,
  ): Promise<{
    ok: boolean;
    result?: T;
    error_code?: number;
    description?: string;
    parameters?: unknown;
  }> {
    const step = this.next("telegram");
    const old = await this.previous(step, name);
    if (old && (old.status === "complete" || old.status === "rejected"))
      return old.result as Awaited<ReturnType<typeof send>>;
    const unsafe =
      /^(send|forward|copy)/.test(name) && name !== "sendChatAction";
    if (old && unsafe) return this.ambiguous(step);
    await this.save(step, name, "started", { request: payload });
    try {
      const response = await send();
      if (!response.ok) {
        if (response.error_code === 429) {
          await raw("DELETE FROM work_steps WHERE work_id=$1 AND step=$2", [
            this.id,
            step,
          ]);
        } else if ([400, 403].includes(response.error_code ?? 0)) {
          await this.save(step, name, "rejected", response);
        } else if (unsafe) return await this.ambiguous(step);
        return response;
      }
      await this.save(step, name, "complete", response);
      return response;
    } catch (error) {
      if (error instanceof AmbiguousOutcome) throw error;
      if (unsafe) return this.ambiguous(step);
      throw error;
    }
  }
}
export async function valueCheckpoint<T>(
  name: string,
  factory: () => T,
): Promise<T> {
  return current().work ? current().work!.valueStep(name, factory) : factory();
}
export async function externalCheckpoint<T>(
  name: string,
  factory: () => Promise<T>,
): Promise<T> {
  return current().work
    ? current().work!.externalStep(name, factory)
    : factory();
}
export const telegramTransformer: Transformer = async (
  previous,
  method,
  payload,
  signal,
) => {
  const work = maybeCurrent()?.work;
  const deadline = maybeCurrent()?.signal;
  // grammY uses an AbortController shim; bridge its event interface to a native signal.
  const bridge = new AbortController();
  const abort = () => bridge.abort();
  if (signal?.aborted) bridge.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const nativeSignal = signal ? bridge.signal : undefined;
  const combined =
    nativeSignal && deadline
      ? AbortSignal.any([nativeSignal, deadline])
      : (nativeSignal ?? deadline);
  try {
    const compatible = combined as unknown as Parameters<typeof previous>[2];
    if (!(work instanceof Work))
      return await previous(method, payload, compatible);
    return (await work.telegram(method, payload, () =>
      previous(method, payload, compatible),
    )) as Awaited<ReturnType<typeof previous>>;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
};
export { GrammyError, query };
