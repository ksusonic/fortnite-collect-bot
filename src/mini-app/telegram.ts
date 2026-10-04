export interface TelegramApp {
  initData: string;
  initDataUnsafe?: { start_param?: string };
  colorScheme: "light" | "dark";
  safeAreaInset?: { top: number; bottom: number; left: number; right: number };
  contentSafeAreaInset?: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  ready(): void;
  expand(): void;
  onEvent(event: string, callback: () => void): void;
  offEvent(event: string, callback: () => void): void;
  BackButton: {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
}
declare global {
  interface Window {
    Telegram?: { WebApp: TelegramApp };
  }
}
export async function requestStats<T>(
  resource: string,
  params: Record<string, string | number> = {},
  signal?: AbortSignal,
  method = "GET",
): Promise<T> {
  const initData = window.Telegram?.WebApp.initData;
  if (!initData) throw new Error("Открой Mini App из профиля бота в Telegram.");
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  const response = await fetch(`/api/mini-app/${resource}?${query}`, {
    method,
    headers: { "x-telegram-init-data": initData },
    signal,
    cache: "no-store",
  });
  const json = await response.json();
  if (!response.ok)
    throw new Error(json.detail ?? "Не удалось загрузить статистику.");
  return json as T;
}
