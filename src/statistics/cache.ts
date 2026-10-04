import "server-only";
import { advisoryLock, raw, transaction } from "../bot/storage";
export interface Cached<T> {
  data: T;
  fetchedAt: number;
  expiresAt: number;
  stale: boolean;
  error: string | null;
}
interface CacheRow<T> {
  result: T;
  fetched_at: Date;
  expires_at: Date;
  retry_after: Date | null;
}
export const CACHE_VERSION = 1;
export async function readCache<T>(key: string): Promise<Cached<T> | null> {
  const row = (
    await raw<CacheRow<T>>(
      "SELECT * FROM statistics_cache WHERE cache_key=$1 AND version=$2",
      [key, CACHE_VERSION],
    )
  ).rows[0];
  return row
    ? {
        data: row.result,
        fetchedAt: row.fetched_at.getTime() / 1000,
        expiresAt: row.expires_at.getTime() / 1000,
        stale: row.expires_at.getTime() <= Date.now(),
        error: null,
      }
    : null;
}
export async function cached<T>(
  key: string,
  ttl: number,
  load: () => Promise<T>,
  commit?: (data: T) => Promise<void>,
): Promise<Cached<T>> {
  const previous = await readCache<T>(key);
  if (previous && !previous.stale) return previous;
  const backoff = (
    await raw("SELECT retry_after FROM statistics_cache WHERE cache_key=$1", [
      key,
    ])
  ).rows[0]?.retry_after as Date | undefined;
  if (previous && backoff && backoff.getTime() > Date.now())
    return { ...previous, error: "Обновление временно недоступно." };
  // Session advisory lock coalesces refreshes across Vercel processes.
  return (await advisoryLock(`statistics:${key}`, async () => {
    const recent = await readCache<T>(key);
    if (recent && !recent.stale) return recent;
    const retry = (
      await raw("SELECT retry_after FROM statistics_cache WHERE cache_key=$1", [
        key,
      ])
    ).rows[0]?.retry_after as Date | undefined;
    if (recent && retry && retry.getTime() > Date.now())
      return { ...recent, error: "Обновление временно недоступно." };
    try {
      const data = await load();
      const now = Date.now() / 1000;
      await transaction(async () => {
        if (commit) await commit(data);
        await raw(
          `INSERT INTO statistics_cache(cache_key,version,result,fetched_at,expires_at,retry_after) VALUES($1,$2,$3,to_timestamp($4),to_timestamp($5),NULL)
     ON CONFLICT(cache_key) DO UPDATE SET version=excluded.version,result=excluded.result,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at,retry_after=NULL`,
          [key, CACHE_VERSION, JSON.stringify(data), now, now + ttl],
        );
      });
      return {
        data,
        fetchedAt: now,
        expiresAt: now + ttl,
        stale: false,
        error: null,
      };
    } catch (error) {
      // Private/deleted accounts must not expose a formerly public cached profile.
      if (
        error instanceof Error &&
        ["StatsPrivate", "EpicNameNotFound"].includes(error.name)
      ) {
        await raw("DELETE FROM statistics_cache WHERE cache_key=$1", [key]);
        throw error;
      }
      if (!recent) throw error;
      await raw(
        "UPDATE statistics_cache SET retry_after=now()+interval '60 seconds' WHERE cache_key=$1",
        [key],
      );
      return { ...recent, stale: true, error: "Не удалось обновить данные." };
    }
  }))!;
}
export async function providerSlot<T>(load: () => Promise<T>): Promise<T> {
  for (const slot of [0, 1]) {
    const result = await advisoryLock(
      `statistics-provider:${slot}`,
      async () => ({ value: await load() }),
      false,
    );
    if (result) return result.value;
  }
  throw new Error("provider busy");
}
