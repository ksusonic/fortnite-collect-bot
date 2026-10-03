"use client";
import { useEffect, useState } from "react";
import type {
  AnalysisDTO,
  GatheringsDTO,
  ProfileDTO,
  WeeklyReport,
} from "@/mini-app/dto";
import type { Input, Mode, Window } from "@/statistics/profile";
import { requestStats } from "@/mini-app/telegram";
import { Skeleton } from "./mini-app";

const number = (value: number | null | undefined, digits = 0) =>
  value == null
    ? "—"
    : value.toLocaleString("ru-RU", { maximumFractionDigits: digits });
const stamp = (seconds: number | null | undefined) =>
  seconds == null
    ? "нет данных"
    : new Date(seconds * 1000).toLocaleString("ru-RU", {
        timeZone: "Europe/Moscow",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }) + " МСК";
const duration = (seconds: number | null) =>
  seconds == null
    ? "—"
    : seconds < 60
      ? `${number(seconds)} с`
      : `${number(seconds / 60)} мин`;
function Metrics({ items }: { items: [string, string][] }) {
  return (
    <div className="metrics">
      {items.map(([title, value]) => (
        <div className="metric" key={title}>
          <span>{title}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}
function ErrorCard({ error, retry }: { error: string; retry: () => void }) {
  return (
    <section className="card" role="alert">
      <p>{error}</p>
      <button onClick={retry}>Попробовать снова</button>
    </section>
  );
}
function useResource<T>(
  resource: string,
  chat: number,
  params: Record<string, string | number> = {},
) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  });
  const [revision, setRevision] = useState(0);
  const serialized = JSON.stringify(params);
  useEffect(() => {
    const controller = new AbortController();
    requestStats<T>(
      resource,
      { chat, ...JSON.parse(serialized) },
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, error: null });
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setState({ data: null, error: err.message });
      });
    return () => controller.abort();
  }, [resource, chat, serialized, revision]);
  return { ...state, retry: () => setRevision((v) => v + 1) };
}
export function TeamScreen({
  chat,
  onPlayer,
}: {
  chat: number;
  onPlayer: (user: number) => void;
}) {
  const { data, error, retry } = useResource<WeeklyReport>("weekly", chat);
  const [refreshed, setRefreshed] = useState<WeeklyReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const report = refreshed ?? data;
  const [full, setFull] = useState(false);
  if (error) return <ErrorCard error={error} retry={retry} />;
  if (!report) return <Skeleton />;
  const mvp = report.players[0];
  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      setRefreshed(
        await requestStats<WeeklyReport>(
          "refresh",
          { chat },
          undefined,
          "POST",
        ),
      );
    } catch (err) {
      setRefreshError(
        err instanceof Error ? err.message : "Не удалось обновить.",
      );
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>Последние 7 дней</h2>
          <p className="hint">
            Обновлено {stamp(report.updatedAt)}
            {report.stale ? " · устарело" : ""}
          </p>
        </div>
        <button
          className="subtle"
          onClick={refresh}
          disabled={refreshing}
          aria-label="Обновить статистику"
        >
          {refreshing ? "…" : "↻"}
        </button>
      </div>
      {refreshError ? <p role="alert">{refreshError}</p> : null}
      {mvp ? (
        <section className="card mvp">
          <span className="trophy" aria-hidden="true">
            🏆
          </span>
          <span className="eyebrow">MVP НЕДЕЛИ</span>
          <h2>{mvp.name || mvp.epicName}</h2>
          <p>
            {number(mvp.wins)} побед · {number(mvp.kills)} киллов ·{" "}
            {number(mvp.kd, 2)} K/D
          </p>
          <button onClick={() => onPlayer(mvp.userId)}>Профиль игрока →</button>
        </section>
      ) : (
        <section className="card">
          <h2>Неделя ещё впереди</h2>
          <p>
            Пока нет недельных результатов — копим снапшоты. Если аккаунт ещё не
            связан, попроси админа: /linkepicfor @user EpicName.
          </p>
        </section>
      )}
      <Metrics
        items={[
          ["Матчи", number(report.summary.matches)],
          ["Победы", number(report.summary.wins)],
          ["Киллы", number(report.summary.kills)],
          ["K/D", number(report.summary.kd, 2)],
        ]}
      />
      <p className="hint">
        Это индивидуальные результаты связанных игроков в BR во всех режимах, а
        не матчи, сыгранные вместе. Окно примерно семь дней; даты исходных
        снапшотов указаны у игроков.
      </p>
      {report.players.length ? (
        <section className="card">
          <h2>🏅 Лидеры недели</h2>
          <ol className="ranking">
            {report.players.slice(0, full ? undefined : 5).map((p, i) => (
              <li key={p.userId}>
                <button
                  className="player-row"
                  onClick={() => onPlayer(p.userId)}
                >
                  <span className="medal" aria-hidden="true">
                    {["🥇", "🥈", "🥉"][i] ?? i + 1}
                  </span>
                  <span>
                    <strong>{p.name || p.epicName}</strong>
                    <span className="hint">
                      {number(p.matches)} матчей · {number(p.kills)} киллов ·{" "}
                      {number(p.kd, 2)} K/D
                    </span>
                    <span className="hint baseline">
                      База: {stamp(p.baselineAt)}
                    </span>
                  </span>
                  <b>
                    {p.wins}
                    <small>побед</small>
                  </b>
                </button>
              </li>
            ))}
          </ol>
          {report.players.length > 5 ? (
            <button
              className="subtle"
              aria-expanded={full}
              onClick={() => setFull((v) => !v)}
            >
              {full ? "Свернуть" : "Весь рейтинг"}
            </button>
          ) : null}
        </section>
      ) : null}
      {report.excluded.length ? (
        <section className="card">
          <h2>Вне недельного зачёта</h2>
          <ul className="plain-list">
            {report.excluded.map((p) => (
              <li key={p.userId}>
                <strong>{p.name}</strong>
                <span className="hint">{p.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Analysis
        key={report.factsHash}
        chat={chat}
        factsHash={report.factsHash}
      />
    </>
  );
}
function Analysis({ chat, factsHash }: { chat: number; factsHash: string }) {
  const { data, error } = useResource<AnalysisDTO>("analysis", chat, {
    report: factsHash,
  });
  if (!data && !error)
    return (
      <p className="hint" role="status">
        Grok анализирует неделю…
      </p>
    );
  const analysis = data?.analysis;
  if (!analysis)
    return (
      <p className="hint">
        {error ??
          data?.error ??
          "Анализ появится, когда накопятся недельные данные."}
      </p>
    );
  return (
    <section className="card analysis">
      <h2>✦ Взгляд Grok</h2>
      <p>{analysis.data.text}</p>
      <p className="hint">
        Отчёт {stamp(analysis.data.reportAt)}
        {analysis.stale || analysis.data.factsHash !== factsHash
          ? " · предыдущий анализ"
          : ""}
      </p>
    </section>
  );
}
export function ProfileScreen({ chat, user }: { chat: number; user: number }) {
  const [window, setWindow] = useState<Window>("season");
  const [input, setInput] = useState<Input>("all");
  const [mode, setMode] = useState<Mode>("overall");
  return (
    <>
      <h2>Fortnite профиль</h2>
      <div className="segments" role="group" aria-label="Период">
        {(
          [
            ["season", "Сезон"],
            ["lifetime", "Всё время"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-pressed={window === id}
            onClick={() => setWindow(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <ProfileData
        key={`${user}:${window}`}
        chat={chat}
        user={user}
        window={window}
        input={input}
        mode={mode}
        setInput={setInput}
        setMode={setMode}
      />
    </>
  );
}
function ProfileData({
  chat,
  user,
  window,
  input,
  mode,
  setInput,
  setMode,
}: {
  chat: number;
  user: number;
  window: Window;
  input: Input;
  mode: Mode;
  setInput: (v: Input) => void;
  setMode: (v: Mode) => void;
}) {
  const { data, error, retry } = useResource<ProfileDTO>("profile", chat, {
    user,
    window,
  });
  if (error) return <ErrorCard error={error} retry={retry} />;
  if (!data) return <Skeleton />;
  if (!data.linked)
    return (
      <section className="card">
        <h3>Свяжи Epic аккаунт</h3>
        <p>{data.instruction}</p>
        <p className="hint">Связывание аккаунта и настройки остаются в чате.</p>
      </section>
    );
  if (!data.data)
    return (
      <ErrorCard error={data.error ?? "Нет данных профиля."} retry={retry} />
    );
  const profile = data.data;
  const stats = profile.inputs[input][mode];
  return (
    <>
      <section className="card profile-header">
        <span aria-hidden="true">🎯</span>
        <h3>{profile.epicName}</h3>
        <p className="hint">
          {data.name} · {stamp(profile.fetchedAt)}
          {data.stale ? " · устарело" : ""}
        </p>
        {data.error ? <p role="status">{data.error}</p> : null}
      </section>
      <div className="filters">
        <label>
          Режим
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as Mode)}
          >
            {(
              [
                ["overall", "Все режимы"],
                ["solo", "Соло"],
                ["duo", "Дуо"],
                ["squad", "Сквад"],
              ] as const
            ).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Управление
          <select
            value={input}
            onChange={(e) => setInput(e.target.value as Input)}
          >
            {(
              [
                ["all", "Все устройства"],
                ["keyboardMouse", "Клавиатура / мышь"],
                ["gamepad", "Контроллер"],
                ["touch", "Сенсор"],
              ] as const
            ).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {stats ? (
        <>
          <Metrics
            items={[
              ["Победы", number(stats.wins)],
              ["K/D", number(stats.kd, 2)],
              ["Матчи", number(stats.matches)],
              ["Киллы", number(stats.kills)],
              ["Процент побед", `${number(stats.winRate * 100, 1)}%`],
              ["Киллов за матч", number(stats.killsPerMatch, 2)],
            ]}
          />
          <section className="card">
            <h3>Детали игры</h3>
            <p>
              В игре:{" "}
              {stats.minutesPlayed === null
                ? "—"
                : `${number(stats.minutesPlayed / 60, 1)} ч`}
            </p>
            {Object.keys(stats.placements).length ? (
              <ul className="plain-list">
                {Object.entries(stats.placements).map(([key, value]) => (
                  <li key={key}>
                    Топ-{key.slice(3)}
                    <b>{number(value)}</b>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Данные о местах недоступны.</p>
            )}
          </section>
        </>
      ) : (
        <section className="card">
          <h3>Нет данных для этого фильтра</h3>
          <p>Попробуй другой режим или устройство.</p>
        </section>
      )}
      <section className="card">
        <h3>Battle Pass</h3>
        <p>Уровень: {number(profile.battlePass?.level)}</p>
        {profile.battlePass?.progress != null ? (
          <>
            <progress
              aria-label="Прогресс Battle Pass"
              value={profile.battlePass.progress}
              max={1}
            />
            <p className="hint">{number(profile.battlePass.progress * 100)}%</p>
          </>
        ) : (
          <p className="hint">Прогресс недоступен.</p>
        )}
      </section>
    </>
  );
}
export function GatheringScreen({ chat }: { chat: number }) {
  const { data, error, retry } = useResource<GatheringsDTO>("gatherings", chat);
  if (error) return <ErrorCard error={error} retry={retry} />;
  if (!data) return <Skeleton />;
  return (
    <>
      <h2>Сборы за всё время</h2>
      <p className="hint">Обновлено {stamp(data.updatedAt)}</p>
      {data.total_sessions === 0 ? (
        <section className="card">
          <h3>Начни первую катку</h3>
          <p>
            Отправь /fort в группе. Сборы и кнопки готовности остаются в чате.
          </p>
        </section>
      ) : (
        <>
          <Metrics
            items={[
              ["Всего сборов", number(data.total_sessions)],
              ["Собрались", number(data.completed_sessions)],
              ["Процент сборки", `${number(data.completionRate * 100, 1)}%`],
              ["Активные", number(data.active_sessions)],
              ["Среднее время", duration(data.avg_fill_seconds)],
              ["Рекорд", duration(data.fastest_fill_seconds)],
            ]}
          />
          {(
            [
              ["Участие", data.top_players],
              ["Инициаторы", data.top_initiators],
              ["Пасы", data.top_passers],
              ["Текущие серии", data.top_streaks],
            ] as const
          ).map(([title, rows]) => (
            <section className="card" key={title}>
              <h3>{title}</h3>
              {rows.length ? (
                <ol className="plain-list">
                  {rows.map(([name, count], i) => (
                    <li key={`${name}:${i}`}>
                      <span>
                        {i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1} {name}
                      </span>
                      <b>{count}</b>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="hint">Пока нет данных.</p>
              )}
            </section>
          ))}
          <section className="card">
            <h3>Лучшие часы · МСК</h3>
            {data.best_hours.length ? (
              data.best_hours.map(([hour, count, avg]) => (
                <div className="hour-row" key={hour}>
                  <strong>{String(hour).padStart(2, "0")}:00</strong>
                  <span>
                    {count} сборов · {duration(avg)}
                  </span>
                </div>
              ))
            ) : (
              <p className="hint">Пока нет завершённых сборов.</p>
            )}
          </section>
        </>
      )}
    </>
  );
}
