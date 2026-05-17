# Коробочка Fortnite Bot

[![Docker](https://github.com/ksusonic/fortnite-collect-bot/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/ksusonic/fortnite-collect-bot/actions/workflows/docker-publish.yml)
[![CodeQL](https://github.com/ksusonic/fortnite-collect-bot/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/ksusonic/fortnite-collect-bot/actions/workflows/github-code-scanning/codeql)
[![Lint](https://github.com/ksusonic/fortnite-collect-bot/actions/workflows/lint.yml/badge.svg)](https://github.com/ksusonic/fortnite-collect-bot/actions/workflows/lint.yml)

Telegram-бот для сбора скуада в Fortnite на 4 человек. Команда `/fort` в группе создаёт сообщение с inline-кнопками по таймслотам — бот собирает голоса, обновляет сообщение в реальном времени и объявляет, когда команда готова. Дополнительно: мониторинг статуса серверов Epic, «режим отборной брани» через xAI Grok и блок текущей статистики Fortnite по всему чату.

## Возможности

- 🎯 **Сбор скуада** — `/fort` с кнопками таймслотов (`Сейчас` + ближайшие часы до 23:00 МСК), теги тех, кто обычно идёт играть.
- 📊 **Статистика чата** — `/stats`: топ игроков, скорость сбора, стрики, пиковые часы.
- 🛰 **Алерты Epic** — фоновая проверка статуса серверов Fortnite, оповещения вечером (18:00–24:00 МСК).
- 🔥 **Roast-режим** — `/roast on` подключает xAI Grok с дерзкой персоной (Unhinged), отвечающей на сообщения чата.
- 🎮 **Fortnite stats** — `/linkepicfor`, `/myfnstats`, `/teamstats` тянут текущий сезон BR через `fortnite-api.com`, рисуют PNG-карточку, считают MVP и leaderboards по чату.
- 🗓 **Еженедельный авто-дроп** — каждую пятницу в 21:00 МСК бот сам публикует `/teamstats` в чатах с привязанными Epic-аккаунтами.

## Требования

- [Docker](https://docs.docker.com/get-docker/) и Docker Compose
- Telegram Bot Token (получить у [@BotFather](https://t.me/BotFather))
- Опционально: `XAI_API_KEY` (для `/roast` и LLM-аналитики `/teamstats`) и `FORTNITE_API_KEY` (для команд по Fortnite-статистике)

## Быстрый старт (Docker)

```bash
# 1. Клонировать репозиторий
git clone https://github.com/ksusonic/fortnite-collect-bot.git
cd fortnite-collect-bot

# 2. Создать .env с токеном бота
cp .env.example .env
# Отредактировать .env — вписать BOT_TOKEN (остальные ключи опциональны)

# 3. Запустить
docker compose up -d
```

Логи: `docker compose logs -f`. Остановить: `docker compose down`.

База хранится в bind-mount `./data` и переживает пересоздание контейнера.

## Запуск без Docker

Требуется Python 3.14+ и [uv](https://docs.astral.sh/uv/).

```bash
cp .env.example .env  # вписать BOT_TOKEN

uv sync
uv run python -m bot
```

## Команды бота

Все команды работают только в групповых чатах.

| Команда | Описание |
|---|---|
| `/fort` | Запустить сбор. Кнопки таймслотов + «Пас». Повторный `/fort` в течение 30 с — `👎`, после кулдауна — пересоздание сессии. |
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

Привязки `@user → Epic` хранятся в SQLite (таблица `epic_links`). Для `/teamstats` бот пишет ежедневные снапшоты в `squad_snapshots`, чтобы считать дельты за 24 ч и 7 дн.

## Переменные окружения

| Переменная | Обяз. | По умолчанию | Назначение |
|---|---|---|---|
| `BOT_TOKEN` | да | — | Токен Telegram-бота |
| `DB_PATH` | нет | `bot.db` | Путь к SQLite (`/app/data/bot.db` в Docker) |
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

## Разработка

```bash
# Lint + format
uv run ruff check --fix
uv run ruff format

# Pre-commit хуки (один раз)
uv run pre-commit install

# Прогнать pre-commit по всем файлам
uv run pre-commit run --all-files

# Sanity-check: импорт роутера
uv run python -c "from bot.handlers import router"
```

CI (`.github/workflows/lint.yml`) гоняет `ruff check` + `ruff format --check` на каждый PR. Docker-образ публикуется через `.github/workflows/docker-publish.yml`, security-сканирование — через GitHub CodeQL.

## Архитектура

Код бота — в `bot/`:

- `__main__.py` — entry point: bot/dispatcher, инициализация БД, восстановление активных сессий, фоновые задачи (`expire_sessions`, `check_status_loop`, `cleanup_snapshots_loop`, `weekly_stats_drop_loop`).
- `handlers.py` — aiogram Router: команды, callback-кнопки, `maybe_roast`, welcome, `_run_teamstats` (шара для еженедельного авто-дропа).
- `db.py` — SQLite через aiosqlite; dataclasses `Session`/`ChatStats`/`EpicLink`/`SquadSnapshot`. Миграции — идемпотентные `ALTER TABLE ADD COLUMN` на старте.
- `messages.py` — билдеры текста и клавиатур; 19 randomized тем сбора, 3 layout'а статистики; константы (`SQUAD_SIZE=4`, `PLAY_DEADLINE_HOUR=23`).
- `roast.py` — xAI Grok (Unhinged + `temperature=1.3`), per-chat dialog memory, `generate_team_stats_roast` для `/teamstats`.
- `status.py` — мониторинг Epic Games status API.
- `fortnite.py` — обёртка над `fortnite-api` SDK: ленивый клиент, кеш с `asyncio.Lock`-coalescing, маппинг ошибок (`EpicNameNotFound`/`StatsPrivate`/`StatsEmpty`/`FortniteUnavailable`).
