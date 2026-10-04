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

## Supabase CI/CD

SQL хранится в `supabase/migrations/`; новые файлы создаются командой
`pnpm --registry=https://registry.npmjs.org dlx supabase@2.119.0 migration new <name>`.
`pnpm bot migrate` читает тот же каталог и использует общий журнал
`supabase_migrations.schema_migrations`. В новых SQL используйте квалифицированные
имена `fortnite_bot.*` или `SET LOCAL search_path = fortnite_bot`: CLI не задаёт
search path приложения. Две исходные миграции проверяют старый
журнал `fortnite_bot.migrations`: уже применённый SQL не выполняется повторно,
а пустая preview-база получает полную схему. Старый журнал остаётся для совместимости.

GitHub CI сначала применяет SQL через Supabase CLI к disposable localhost Postgres,
затем запускает тесты, включая recovery/importer. Production credentials в Actions
не нужны. Docker и `supabase start` не используются.

Для активации [Supabase GitHub integration](https://supabase.com/docs/guides/deployment/branching/github-integration)
в настройках проекта `fort-collect-bot` (`yvwdmhwkjlchavaisjlk`) подключите
`ksusonic/fortnite-collect-bot`: Working directory `.`; Production branch `main`;
Automatic branching, Supabase changes only и Deploy to production — включены.
После первого PR с SQL добавьте фактический check `Supabase Preview` в required
checks ветки `main` вместе с `ci`. Branching создаёт отдельные базы без production
данных; Vercel previews остаются отключены.

Перед включением Deploy to production сохраните экспорт и проверьте старый журнал
миграций и состояние production-схемы через Supabase tools. GitHub интеграция должна
быть единственным автоматическим исполнителем production-миграций; ручной
`pnpm bot migrate` нужен для локальной разработки и восстановления. Изменения SQL
должны быть совместимы с текущим runtime: деплои Vercel и Supabase независимы.
`ops/schedules.sql` применяется отдельно через Supabase tools после проверки job
routes; production Vault secrets, cron и webhook в preview не копируются.

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
