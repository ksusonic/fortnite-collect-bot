"use client";
import Script from "next/script";
import { useCallback, useEffect, useState } from "react";
import { requestStats } from "@/mini-app/telegram";
import type { ChatsDTO } from "@/mini-app/dto";
import { TeamScreen, ProfileScreen, GatheringScreen } from "./screens";
import { Icon } from "./icons";
import "./mini-app.css";

type Tab = "team" | "profile" | "gatherings";
export default function MiniApp() {
  const [ready, setReady] = useState(false);
  const [chats, setChats] = useState<ChatsDTO | null>(null);
  const [chat, setChat] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("team");
  const [player, setPlayer] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const initialize = useCallback(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    requestStats<ChatsDTO>("chats", {}, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setChats(data);
        setChat(data.selected);
        setError(null);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [ready, revision]);
  useEffect(() => {
    if (!ready) return;
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    const sync = () => {
      document.documentElement.dataset.theme = tg.colorScheme;
      for (const edge of ["top", "bottom", "left", "right"] as const)
        document.documentElement.style.setProperty(
          `--mini-safe-${edge}`,
          `${(tg.safeAreaInset?.[edge] ?? 0) + (tg.contentSafeAreaInset?.[edge] ?? 0)}px`,
        );
    };
    sync();
    for (const event of [
      "themeChanged",
      "safeAreaChanged",
      "contentSafeAreaChanged",
    ])
      tg.onEvent(event, sync);
    return () => {
      for (const event of [
        "themeChanged",
        "safeAreaChanged",
        "contentSafeAreaChanged",
      ])
        tg.offEvent(event, sync);
    };
  }, [ready]);
  const back = useCallback(() => setPlayer(null), []);
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    if (player !== null) {
      tg.BackButton.show();
      tg.BackButton.onClick(back);
    } else tg.BackButton.hide();
    return () => {
      tg.BackButton.offClick(back);
      tg.BackButton.hide();
    };
  }, [player, back, ready]);
  const navigate = (next: Tab) => {
    setPlayer(null);
    setTab(next);
  };
  return (
    <main className="mini-app">
      <Script
        src="https://telegram.org/js/telegram-web-app.js"
        strategy="afterInteractive"
        onReady={initialize}
        onError={() => {
          setReady(true);
          setError("Не удалось загрузить Telegram. Открой приложение заново.");
        }}
      />
      <header className="app-header">
        <div>
          <span className="eyebrow">FORTNITE COLLECT</span>
          <h1>Статистика</h1>
        </div>
        <span className="brand-mark" aria-hidden="true">
          <Icon name="brand" />
        </span>
      </header>
      {error ? (
        <section className="card" role="alert">
          <h2>Не удалось открыть статистику</h2>
          <p>{error}</p>
          <button onClick={() => setRevision((v) => v + 1)}>
            Попробовать снова
          </button>
        </section>
      ) : !chats ? (
        <Skeleton />
      ) : !chats.chats.length ? (
        <section className="card">
          <h2>Пока нет доступных чатов</h2>
          <p>
            Ответь на /fort в своей группе. Для проверки участия бот должен быть
            администратором.
          </p>
          {chats.unavailable > 0 ? (
            <p>Проверка части чатов сейчас недоступна.</p>
          ) : null}
          <button onClick={() => setRevision((v) => v + 1)}>
            Проверить снова
          </button>
        </section>
      ) : (
        <>
          <label className="chat-switcher">
            Твой чат
            <select
              aria-label="Выбрать чат"
              value={chat ?? ""}
              onChange={(e) => {
                setChat(Number(e.target.value));
                setPlayer(null);
              }}
            >
              {chats.chats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          {chats.unavailable > 0 ? (
            <p className="hint" role="status">
              Часть чатов временно недоступна.
            </p>
          ) : null}
          {chat !== null ? (
            <div key={`${chat}:${tab}:${player}`}>
              {player !== null ? (
                <>
                  <button className="back" onClick={back}>
                    ← К рейтингу
                  </button>
                  <ProfileScreen chat={chat} user={player} />
                </>
              ) : tab === "team" ? (
                <TeamScreen chat={chat} onPlayer={setPlayer} />
              ) : tab === "profile" ? (
                <ProfileScreen chat={chat} user={chats.viewerId} />
              ) : (
                <GatheringScreen chat={chat} />
              )}
            </div>
          ) : null}
          <nav className="bottom-nav" aria-label="Разделы">
            {(
              [
                ["team", "Команда"],
                ["profile", "Моя статистика"],
                ["gatherings", "Сборы"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => navigate(id)}
              >
                <span aria-hidden="true">
                  <Icon name={id} />
                </span>
                {label}
              </button>
            ))}
          </nav>
        </>
      )}
    </main>
  );
}
export function Skeleton() {
  return (
    <div className="skeleton" role="status" aria-label="Загрузка статистики">
      <div />
      <div />
      <div />
      <span className="sr-only">Загружаем статистику…</span>
    </div>
  );
}
