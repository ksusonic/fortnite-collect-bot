# Коробочка Fortnite Bot

Telegram-бот для сбора скуада (4 человека) в Fortnite. Отправьте `/fort` в группу — участники нажимают inline-кнопки, бот обновляет сообщение в реальном времени и объявляет, когда команда собрана.

## Требования

- [Docker](https://docs.docker.com/get-docker/) и Docker Compose
- Telegram Bot Token (получить у [@BotFather](https://t.me/BotFather))

## Быстрый старт (Docker)

```bash
# 1. Клонировать репозиторий
git clone <repo-url> && cd fortnite-collect-bot

# 2. Создать .env с токеном бота
cp .env.example .env
# Отредактировать .env — вписать BOT_TOKEN

# 3. Запустить
docker compose up -d
```

Бот запущен. Логи: `docker compose logs -f`.

Остановить: `docker compose down`.

БД хранится в Docker volume `bot-data` и переживает пересоздание контейнера.

## Запуск без Docker

Требуется Python 3.14+ и [uv](https://docs.astral.sh/uv/).

```bash
cp .env.example .env
# Отредактировать .env — вписать BOT_TOKEN

uv sync
uv run python -m bot
```

## Использование

1. Добавьте бота в Telegram-группу.
2. Отправьте `/fort` — бот создаст сообщение со сбором.
3. Участники нажимают **Го!** или **Пас**.
4. Когда набирается 4 человека — бот объявляет готовый скуад.

Можно менять решение — повторное нажатие другой кнопки переносит между списками.
