# Fortnite Collect Bot

Telegram-бот для сбора сквада в Fortnite: TypeScript, Next.js App Router и grammY.
Webhook и задания работают на Vercel, данные — в приватной схеме `fortnite_bot`
Supabase Postgres. App Router также служит основой будущего Telegram Mini App.

## Команды

- `/fort [час]` — собрать четыре игрока и FIFO-резерв из следующих четырёх. Без часа — относительная готовность сейчас / +30м / +1ч / +2ч до 23:00 МСК.
- `/rm` — отменить и удалить текущий сбор.
- `/afk 1d`, `/afk 2w`, `/afk off` — временно отключить приглашения в новые сборы.
- `/fortemoji`, `/fortemoji off` — администратору: заголовок из четырёх custom emoji WideABC.
- `/stats` — статистика сборов в чате.
- `/roast on [0..1]`, `/roast off` — настроить ответы Grok.
- `/linkepicfor @user EpicName` — администратору бота: привязать публичный Epic-аккаунт участника.
- `/myfnstats` — сезонная статистика Fortnite: PNG-карточка или текст.
- `/teamstats` — недельные дельты, MVP и лидеры; автоматическая публикация по пятницам в 21:00 МСК.

Бот работает в группах. Для pin/delete нужны соответствующие права.
Для custom emoji нужен Premium у владельца бота. Без недельной baseline игрок
не попадает в рейтинг; сезонные totals не заменяют недельные дельты.

## Разработка

Node.js 24 LTS и pnpm. Пакеты устанавливаются
напрямую с `registry.npmjs.org`, без proxy. `.nvmrc` фиксирует Node major.
TypeScript 7 (`@typescript/native`) выполняет `pnpm typecheck`; alias `typescript`
на `@typescript/typescript6` предоставляет compiler API для ESLint и Next.js.
Типы Node.js остаются на major 24, как production runtime.

```bash
pnpm install --frozen-lockfile
pnpm bot migrate
pnpm dev
```

Для локальной базы: `DATABASE_LOCAL_TEST=1` (только localhost).
Настройте локальные переменные в `.env`. CLI и Next.js читают этот файл; Next.js
также поддерживает `.env.local`. Все `.env` варианты
исключены из Git. Бот не запускает polling, миграции или регистрацию webhook при старте.

```bash
pnpm lint
pnpm format:check
pnpm typecheck
TEST_DATABASE_URL=postgresql://localhost/fortnite_test pnpm test
pnpm build
```

Тесты очищают таблицы **только disposable localhost базы `fortnite_test`**.
Без `TEST_DATABASE_URL` Postgres-тесты пропускаются; такой запуск не доказывает
работу storage/recovery. CI запускает проверки с отдельной базой.

## CI/CD

GitHub Actions сохраняет обязательный check `ci`: lint, форматирование, типы,
Postgres/Vitest (включая importer) и Next.js build. pnpm store и `.next/cache`
кэшируются; новые commits отменяют устаревшие CI/CodeQL runs. CI не получает
production secrets; Sentry release/upload включены только в Vercel build.
Ruleset `gymrules` требует PR, `ci` и актуальный `main`
(**Require branches to be up to date before merging**). Имя check менять нельзя
без одновременного обновления ruleset.

Vercel Git integration собирает и публикует только `main`. Workflow
`Production smoke` использует native `vercel.deployment.success`
[repository_dispatch](https://vercel.com/docs/git/vercel-for-github#repository-dispatch-events)
для production и доступен вручную через Actions. Он проверяет `/health` и отказ
неавторизованных webhook/job/admin requests, без secrets и отправки сообщений.
Ответ 403 принимается только с Vercel `x-vercel-mitigated: deny` и отмечается
отдельно: это отказ firewall, application auth в таком запросе не проверен.
Это проверка после публикации, а не deployment gate; она не доказывает доступность
базы, правильность webhook или успешность cron. При необходимости блокировать
публикацию до live-проверок используйте отдельную
[Vercel Checks integration](https://vercel.com/docs/checks).

Миграции остаются отдельной операцией через Supabase tools до совместимого
деплоя; `fortnite_bot.migrations` ведёт собственный журнал. Не включайте
Supabase GitHub auto-migrations поверх него без явного перехода на CLI history.
[Supabase Branching](https://supabase.com/docs/guides/deployment/branching)
даёт изолированные PR-базы, но потребует отдельного тестового контура: текущие
destructive tests принимают только disposable localhost `fortnite_test`.
Для этого проекта сохраняем локальный Postgres в CI и Supabase Cron/Vault/pg_net
в production; schema, webhook и schedule не меняются автоматически при деплое.

## Production

Проект `fortnite-collect-bot`, Node.js 24, регион `fra1`; function duration 300 секунд.
Деплой только из `main`, previews отключены. Runtime использует Node.js; задания
полностью awaited, без detached tasks. API paths сохранены:

- `POST /api/telegram/webhook`
- `POST /api/jobs/expiry`, `/status`, `/weekly`, `/cleanup`
- `GET /health`, `GET /api/admin/inspect`
- `POST /api/admin/register-webhook` — только явная административная операция

Нужны `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`, `PUBLIC_BASE_URL`,
`DATABASE_URL` либо `POSTGRES_URL_NON_POOLING`. Соединение с Supabase — SSL и session
pooler 5432: transaction pooler 6543 несовместим с session advisory locks.
Опционально: `FORTNITE_API_KEY`, `ADMIN_USER_ID` и настройки roast (модель,
вероятность и cooldown). Grok получает app-scoped token через Vercel Connect
`grok/fortnite-collect-bot`; отдельный ключ xAI в окружении не нужен. Секреты не должны иметь префикс `NEXT_PUBLIC_`.

После проверки stable production явно зарегистрируйте webhook:

```bash
pnpm bot register-webhook https://production-domain
pnpm bot webhook-info
```

Регистрация проверяет `/health`, задаёт secret, `max_connections=1`, типы updates
и `drop_pending_updates=false`. Расписание остаётся в [Supabase Cron](ops/schedules.sql):
URL и secret хранятся в Vault. Проверять нужно actual HTTP outcomes, а не только
успешный запуск SQL cron.

## Recovery и переход с Python

`storage.ts` держит один invocation-scoped Postgres client, `work.ts` — журнал действий,
`runtime.ts` — очередь чата. SQL mutations коммитятся атомарно с checkpoints; reads,
time/random и provider results replay исходных значений. Telegram sends с неизвестным
результатом блокируют очередь до ручного разбора, вместо слепой повторной отправки.

SQLite importer реализован на TypeScript и запускается локально. Эталонные сообщения
сохранены в parity fixtures; предыдущий Python runtime доступен только в Git для rollback:

```bash
pnpm bot import /path/to/read-only-backup.db
```

Он отказывается импортировать в непустую базу, выполняет импорт транзакционно и
проверяет данные/ключи/FK. Сохраните оригинальный backup и pre-launch export.

**Перед переходом runtime:** экспортировать базу; приостановить webhook delivery и
cron; завершить или вручную reconcile все pending/failed/ambiguous work. Порядок и
SQL signatures checkpoints изменились: незавершённые Python items нельзя продолжать
новым кодом без явной миграции. Сохранить queue/steps и согласовать их состояние,
затем deploy из main, проверить production health и меню/права, явно восстановить
stable webhook и cron. Не запускать два runtime одновременно.

Проверить `/fort`, относительные кнопки, reserve promotion, AFK, custom title,
`/stats`, карточки и недельные snapshots отдельно от CI. При rollback снова drain
новые work до возврата Python; post-cutover записи остаются в общей Postgres базе.

## Sentry

Проект `kiskis/fort-collect-bot`: server errors, tracing (10%) и browser replay
(10% сессий, 100% при ошибке) через `/monitoring`. Replay маскирует текст и media;
request bodies/headers/cookies, user context, SQL параметры и exception text не
отправляются. Тип ошибки и stack frames сохраняются. Ошибки обработчиков, включая
uncertain sends, попадают в Sentry; endpoints ожидают bounded flush.

Source maps и release actions отключены для локальных сборок (`VERCEL=0`). На Vercel
они используют уже настроенную интеграцию; auth token остаётся в ignored env-файле
или build environment. Никогда не передавайте его браузеру. Development-only
`/sentry-example-page` позволяет явно отправить тестовые события; throwing API
возвращает 404 в production. Доставку событий и source maps проверять отдельно
после авторизованного деплоя.

## Analytics и дальнейшая работа

Vercel Web Analytics подключается через `@vercel/analytics` в корневом layout.
После деплоя нужно включить Web Analytics в dashboard проекта и проверить поступление
событий. Browser analytics не подтверждает работу Telegram webhook и cron.

Будущий Telegram Mini App: [docs/MINI_APP.md](docs/MINI_APP.md).
