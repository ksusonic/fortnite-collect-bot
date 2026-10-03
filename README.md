# Коробочка Fortnite Bot

Telegram-бот для сбора отряда из четырёх игроков: кнопки готовности, резерв,
статистика Fortnite, уведомления Epic и ответы Grok.

## Команды

Команды работают в группах. Боту нужны права на закрепление и удаление сообщений.

| Команда | Назначение |
|---|---|
| `/fort [час]` | Создать сбор; первые четыре игрока — состав, следующие четыре — резерв. |
| `/rm` | Отменить текущий сбор. |
| `/afk 1d`, `/afk off` | Временно отключить приглашения или вернуть их. |
| `/fortemoji`, `/fortemoji off` | Администратору: настроить заголовок сбора из custom emoji. |
| `/stats` | Статистика сборов в чате. |
| `/roast on [вероятность]`, `/roast off` | Включить или выключить ответы Grok. |
| `/linkepicfor @user EpicName` | Администратору бота: привязать публичный Epic-аккаунт. |
| `/myfnstats` | Личная статистика Fortnite за сезон. |
| `/teamstats` | Статистика команды за неделю; также публикуется по пятницам в 21:00 МСК. |

## Разработка

Python 3.14, uv и отдельная локальная база Postgres.

```bash
cp config.example .env
uv sync --frozen
uv run python -m bot migrate
uv run python -m bot serve
```

Для локальной базы без SSL задайте `DATABASE_LOCAL_TEST=1`.
Проверка: `uv run ruff check` и `uv run ruff format --check`.
Тесты очищают таблицы: запускайте их только с отдельной базой через
`TEST_DATABASE_URL=postgresql://localhost/fortnite_test uv run pytest -q`.

## Production

FastAPI на Vercel (`fortnite-collect-bot`) и Supabase Postgres, Telegram webhook.
Деплой только из `main`; preview отключены. Подключение к Supabase — session pooler
на порту 5432 с SSL. Расписание задач — [Supabase Cron](ops/schedules.sql).

Обязательные настройки: `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`,
`PUBLIC_BASE_URL` и `DATABASE_URL` либо интеграционный `POSTGRES_URL_NON_POOLING`.
Дополнительно: `XAI_API_KEY` для Grok, `FORTNITE_API_KEY` для статистики,
`ADMIN_USER_ID` для привязки аккаунтов. Пример — [config.example](config.example).
Все `.env`-файлы исключены из Git.
