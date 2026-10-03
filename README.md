# Коробочка Fortnite Bot

Telegram-бот для сбора Fortnite-отряда: четыре игрока, FIFO-резерв, закрепление сбора,
статистика, уведомления Epic и ответы Grok. Python 3.14, aiogram, FastAPI и Supabase Postgres.
Работает на Vercel через Telegram webhook.

## Локальная разработка

Нужны Python 3.14, uv и отдельная локальная база Postgres 17.

```bash
cp config.example .env
uv sync --frozen
uv run python -m bot migrate
uv run python -m bot serve
```

Для локальной базы без SSL задайте `DATABASE_LOCAL_TEST=1`. В production SSL обязателен.
`GET /health` проверяет загрузку приложения. Webhook принимает только запросы с
`X-Telegram-Bot-Api-Secret-Token`. Приложение не регистрирует webhook при запуске.

## Vercel и Supabase

Проект Vercel: `fortnite-collect-bot` в Daniil’s projects. FastAPI entrypoint — `app.py`.
`vercel.json` задаёт Python-функцию на 300 секунд в `fra1`, рядом с подключённой
Supabase-базой во Франкфурте. Используйте session pooler на порту 5432; порт 6543
не поддерживает нужные session advisory locks.

1. Примените SQL из `migrations/` по порядку через Supabase toolset и запишите
   имена файлов в `fortnite_bot.migrations`. Для отдельной локальной базы доступна команда `migrate`.
2. Задайте production-секреты из таблицы ниже. Vercel-интеграция уже предоставляет
   `POSTGRES_URL_NON_POOLING`; этого достаточно, если `DATABASE_URL` не задан.
3. Разверните проверенную ветку на production. `/health` должен возвращать HTTP 200
   без входа в Vercel. Превью должны оставаться защищёнными и использовать отдельного
   тестового бота, отдельную базу и отдельные API-ключи.
4. После проверки выполните `uv run python -m bot register-webhook https://your-production-domain`
   либо отправьте authenticated POST на `/api/admin/register-webhook`.
   Регистрация устанавливает secret_token, max_connections=1, нужные router update types
   и drop_pending_updates=false. GET `/api/admin/inspect` проверяет webhook, права и очередь.
5. Через Supabase включите pg_cron и pg_net, сохраните production URL и CRON_SECRET
   в Vault под именами `fortnite_bot_url` и `fortnite_bot_cron_secret`, затем примените
   `ops/schedules.sql`. Все job/admin endpoints требуют `Authorization: Bearer <CRON_SECRET>`.

Supabase Cron вызывает `/api/jobs/expiry` каждую минуту (также восстановление pending work),
`status` каждые три минуты в 18:00–24:00 МСК, `weekly` каждые пять минут в пятницу
21:00–21:59 МСК и `cleanup` ежедневно. UTC-расписания зафиксированы в SQL.
`job_http_requests` сохраняет фактические HTTP-исходы, `work_items` — исходы обработки.
Проверяйте оба: успех cron SQL означает постановку HTTP-запроса, а не выполнение job.

Бот должен состоять в группе и иметь права на закрепление/удаление сообщений.
Для roast нужна видимость обычных сообщений (проверьте privacy mode в BotFather).
XAI_API_KEY сохраняет существующий Python SDK путь; Vercel Grok connector сейчас не используется.

## Обработка повторов

Postgres — источник истины. Сессии и ответы имеют составные ключи chat_id/message_id;
частичный unique index допускает один открытый сбор на чат. Invocation-scoped соединения
и advisory locks сериализуют изменения и Telegram edits в каждом чате.
`work_steps` сохраняет checkpoints чтений, записей, внешних результатов и Telegram действий.
Завершённые действия при retry не повторяются. Неопределённый исход send переводит работу
в `ambiguous` и блокирует последующую обработку этого чата до проверки.
Посмотрите request/result в `work_steps`, установите фактический исход, затем через
Supabase исправьте checkpoint и верните item в pending; не сбрасывайте начатый send вслепую.
Если отправку пришлось завершить вручную, отметьте item complete только после сверки
Telegram и соответствующего состояния Postgres.

## Команды бота

Все команды работают только в групповых чатах.

| Команда | Описание |
|---|---|
| `/fort` | Запустить сбор. Первые 4 ответа Go попадают в состав, следующие 4 — в FIFO-резерв. Повторный `/fort` в течение 30 с — `👎`, после кулдауна — пересоздание сессии. |
| `/fortemoji` | **Администратор чата.** Ответьте на сообщение с четырьмя custom emoji, составляющими FORT из [WideABC](https://t.me/addemoji/WideABC). Заголовок сохраняется для новых сборов и переживает перезапуск. `/fortemoji off` возвращает обычный заголовок. Владелец бота должен иметь Telegram Premium. |
| `/afk <Nd\|Nw>` | Временно не упоминать вас в приглашениях новых `/fort` сборов (`/afk 1d`, `/afk 2w`). `/afk off` отменяет режим досрочно. |
| `/rm` | Отменить и удалить текущую активную сессию. |
| `/stats` | Статистика чата: топ игроков, скорость сбора, стрики, пиковые часы. |
| `/roast on [0..1] \| off` | Включить/выключить «отборную брань» от xAI Grok. Опциональный аргумент — вероятность срабатывания на сообщение. |
| `/linkepicfor @user <EpicName>` | **Admin only.** Привязать `@user` к публичному Epic-аккаунту. Пользователь должен хотя бы раз ответить на `/fort` в этом чате. |
| `/myfnstats` | PNG-карточка статистики Fortnite за текущий сезон (overall + по типам ввода). Fallback в текст, если провайдер не отдал картинку. |
| `/teamstats` | Командный дайджест: MVP, sweepstake-блок, leaderboard top-5 по победам, лидеры по режимам (squad/duo/solo). С `XAI_API_KEY` — добавляет LLM-аналитику. |

### Roast-режим

`/roast on` — бот будет редко (~5 % сообщений, не чаще раза в 10 мин) отвечать через xAI Grok (`grok-3-mini` по умолчанию) в режиме Unhinged: дерзкая персона с матом, поднятая `temperature=1.3`. Помнит контекст чата ~30 сообщений; история сбрасывается после 12 ч простоя.

Принудительный roast: ответить на сообщение бота или упомянуть `@bot` — кулдаун и вероятность игнорируются.

### Fortnite stats

Используется публичный API `fortnite-api.com`. Игрок должен включить **Public Game Stats** в настройках Fortnite, иначе API вернёт 403. Все запросы — за текущий сезон (`TimeWindow.SEASON`); общая статистика за всё время не поддерживается.

Привязки `@user → Epic` хранятся в Postgres (таблица `epic_links`). Для `/teamstats` бот пишет снапшоты при запросах статистики в `squad_snapshots`, чтобы считать дельты за 24 ч и 7 дн.

## Переменные окружения

| Переменная | Обяз. | По умолчанию | Назначение |
|---|---|---|---|
| `BOT_TOKEN` | да | — | Токен Telegram-бота |
| `DATABASE_URL` | да* | — | Supabase session pooler, порт 5432, SSL |
| `POSTGRES_URL_NON_POOLING` | да* | — | Используется вместо DATABASE_URL при Vercel-интеграции Supabase |
| `TELEGRAM_WEBHOOK_SECRET` | да | — | Секрет заголовка Telegram webhook |
| `CRON_SECRET` | да | — | Bearer-секрет для job/admin endpoints |
| `PUBLIC_BASE_URL` | да | — | Постоянный production URL без завершающего слеша |
| `LOG_LEVEL` | нет | `INFO` | Уровень логирования |
| `XAI_API_KEY` | нет | — | Ключ xAI; без него `/roast` и LLM-аналитика `/teamstats` отключены |
| `ROAST_PROBABILITY` | нет | `0.05` | Вероятность срабатывания roast на сообщение |
| `ROAST_COOLDOWN_SEC` | нет | `600` | Минимум секунд между roast'ами в чате |
| `ROAST_HISTORY_SIZE` | нет | `30` | Размер истории чата (user + bot) для контекста roast |
| `ROAST_HISTORY_TTL_SEC` | нет | `43200` | Idle-таймаут истории roast (12 ч) |
| `ROAST_MODEL` | нет | `grok-3-mini` | ID модели xAI |
| `ROAST_REQUEST_TIMEOUT` | нет | `45` | Таймаут RPC до xAI |
| `FORTNITE_API_KEY` | нет | — | Ключ `fortnite-api.com`; без него Fortnite-команды отвечают «не настроено» |
| `FORTNITE_STATS_TTL_SEC` | нет | `600` | TTL in-memory кеша статистики |
| `FORTNITE_REQUEST_TIMEOUT` | нет | `15` | Таймаут запроса к Fortnite API |
| `ADMIN_USER_ID` | нет | — | Telegram user_id единственного админа бота (нужен для `/linkepicfor`) |


*Нужен один из DATABASE_URL или POSTGRES_URL_NON_POOLING. Все `.env`-варианты исключены из Git.

## Проверка изменений

```bash
uv run ruff check
uv run ruff format --check
TEST_DATABASE_URL=postgresql://localhost/fortnite_test uv run pytest -q
uv run pre-commit install
uv run pre-commit run --all-files
```

TEST_DATABASE_URL должен указывать на disposable Postgres: тесты очищают bot-таблицы.
GitHub CI запускает Ruff и полный suite с локальной Postgres-базой runner.

## Архитектура

- `app.py` — HTTP/auth, webhook, jobs и защищённые maintenance endpoints.
- `bot/runtime.py`, `work.py`, `storage.py` — invocation lifecycle, durable replay и locks.
- `bot/db.py`, `migrations/`, `importer.py` — Postgres хранилище и recovery.
- `bot/handlers.py`, `messages.py` — команды, FIFO-резерв и HTML-клавиатуры.
- `bot/roast.py`, `fortnite.py`, `status.py` — Grok, сезонная статистика и Epic status.
- `bot/jobs.py`, `ops/schedules.sql` — bounded jobs вместо фоновых циклов.
- `bot/cli.py` — локальный сервер, миграции, импорт и явная регистрация webhook.
