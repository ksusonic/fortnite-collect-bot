# Fortnite Collect Bot

Telegram-бот для сбора сквада в Fortnite: TypeScript, Next.js App Router и grammY.
Webhook и задания работают на Vercel, данные — в приватной схеме `fortnite_bot`
Supabase Postgres. App Router также служит основой будущего Telegram Mini App.

## Команды

- `/fort [час]` — собрать четыре игрока и FIFO-резерв из следующих четырёх. Без часа — относительная готовность сейчас / +30м / +1ч / +2ч до 23:00 МСК.
- `/rm` — отменить и удалить текущий сбор.
- `/afk 1d`, `/afk 2w`, `/afk off` — временно отключить приглашения в новые сборы.
- `/stats` — статистика сборов в чате.
- `/linkepicfor @user EpicName` — администратору бота: привязать публичный Epic-аккаунт участника. Привязка общая для пользователя во всех чатах; состав команды определяется историей ответов на `/fort` в выбранном чате.
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
работу хранилища и очередей. CI запускает проверки с отдельной базой.

## CI/CD

GitHub Actions сохраняет обязательный check `ci`: lint, форматирование, типы,
Postgres/Vitest и Next.js build. pnpm store и `.next/cache`
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
`/health` проверяет БД через тот же SSL/session-pooler connection, что runtime:
search path, требуемые таблицы/колонки, RLS и права чтения/записи. Проверка
выполняется в read-only транзакции без чтения пользовательских строк и возвращает
503 при несовместимой схеме. Ответы не кэшируются; детали БД наружу не выдаются.

`pnpm build` в Vercel production (`VERCEL_ENV=production`) выполняет такую же
проверку **до** Next.js build, а также проверяет наличие каждой версии из
`supabase/migrations/*.sql` в `supabase_migrations.schema_migrations`.
Это блокирует релиз даже при совместимой схеме, если SQL с индексами, политиками
или преобразованием данных ещё не применён. Лишние remote-версии допустимы:
БД может опережать приложение при повторном деплое старого релиза.
При неприменённых миграциях публикация останавливается,
предыдущий deployment остаётся активным. Production DB переменные должны быть
доступны на этапе build. Миграции при build/startup не запускаются. После успешного
применения SQL в Supabase повторите Vercel deployment из `main`.
Локальная ручная проверка: `pnpm bot check-db`. CI/local build не обращается к production.
Smoke после публикации подтверждает доступность БД и auth boundaries, но правильность
webhook и фактические результаты cron проверяются отдельно.

## Supabase CI/CD

SQL хранится в `supabase/migrations/`; новые файлы создаются командой
`pnpm --registry=https://registry.npmjs.org dlx supabase@2.119.0 migration new <name>`.
`pnpm bot migrate` читает тот же каталог и использует общий журнал
`supabase_migrations.schema_migrations`. В новых SQL используйте квалифицированные
имена `fortnite_bot.*` или `SET LOCAL search_path = fortnite_bot`: CLI не задаёт
search path приложения. Исходные миграции проверяют старый
журнал `fortnite_bot.migrations`: уже применённый SQL не выполняется повторно,
а пустая preview-база получает полную схему. Старый журнал остаётся для совместимости.
Три файла с версиями 2–3 октября — записи совместимости с ранее применёнными
production-миграциями, не повторный запуск их SQL. Не удаляйте эти версии:
Supabase блокирует `db push`, если remote history содержит отсутствующие локально
версии. Новые базы получают storage/receipts из миграций 4 октября; production
cron и Vault остаются в отдельно применяемом `ops/schedules.sql`.

GitHub CI сначала применяет SQL через Supabase CLI к disposable localhost Postgres,
затем запускает тесты хранилища и очередей. Production credentials в Actions
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
`pnpm bot migrate` нужен для локальной разработки. Изменения SQL
должны быть совместимы с текущим runtime: деплои Vercel и Supabase независимы.
`ops/schedules.sql` применяется отдельно через Supabase tools после проверки job
routes; production Vault secrets, cron и webhook в preview не копируются.

## Production

Проект `fortnite-collect-bot`, Node.js 24, регион `fra1`; function duration 300 секунд.
Деплой только из `main`, previews отключены. Runtime использует Node.js; задания
полностью awaited, без detached tasks. API paths сохранены:

- `POST /api/telegram/webhook`
- `POST /api/jobs/maintenance`, `/status`
- `POST /api/jobs/expiry`, `/weekly`, `/cleanup` — совместимые прежние URL
- `GET /health`, `GET /api/admin/inspect`
- `POST /api/admin/register-webhook` — только явная административная операция

Нужны `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET`, `PUBLIC_BASE_URL`, `ADMIN_USER_ID`,
`DATABASE_URL` либо `POSTGRES_URL_NON_POOLING`. Соединение с Supabase — SSL и session
pooler 5432: transaction pooler 6543 несовместим с session advisory locks.
Для Supabase pooler встроен официальный root CA; сертификат и hostname проверяются.
Опционально: `FORTNITE_API_KEY`. Grok получает app-scoped token через Vercel Connect
`grok/fortnite-collect-bot`; отдельный ключ xAI в окружении не нужен. Секреты не должны иметь префикс `NEXT_PUBLIC_`.

Опциональный `MEM0_API_KEY` включает долгую память для разговорных ответов:
перед генерацией бот ищет до пяти релевантных воспоминаний, после успешной отправки
передаёт реплику пользователя и ответ на обработку Mem0. Mem0 асинхронно извлекает
из них факты и может не создать воспоминание, если сохранять нечего (например,
после сообщения «запомни» без факта). Область памяти — Telegram user ID внутри
конкретной группы; имена и клиентские ID для доступа не используются. В Mem0
отправляются только реплики, на которые бот отвечает в одобренном чате, а не весь
чат. Настройка ключа разрешает передачу этих реплик в hosted Mem0; память можно
просматривать и удалять в Mem0 dashboard. Без ключа или при ошибке/таймауте Mem0
бот продолжает работать с локальной историей. SDK telemetry отключена; запросы
awaited, с лимитом 5 секунд на HTTP-запрос и общим deadline invocation.

Генерация с поиском использует `adaptive-roast-v1` checkpoint; запись памяти
добавлена после Telegram checkpoint, поэтому завершённая отправка не повторяется
при retry. ID принятого Mem0 события сохраняется в `roast-memory-add`; отдельный
`roast-memory-confirm` проверяет его результат (создана память, 0 записей, ошибка
или ещё не завершено) и пишет безопасный итог в Sentry Logs. Повторная обработка
не посылает завершённый `add` снова. Если процесс оборвётся после принятия записи Mem0,
но до сохранения checkpoint, replay может повторно добавить turn: атомарности между
Mem0 и Postgres нет (message ID сохранён в metadata для диагностики).

После проверки stable production явно зарегистрируйте webhook:

```bash
pnpm bot register-webhook https://production-domain
pnpm bot webhook-info
```

Регистрация проверяет `/health`, задаёт secret, `max_connections=1`, типы updates
и `drop_pending_updates=false`. Расписание остаётся в [Supabase Cron](ops/schedules.sql):
URL и secret хранятся в Vault. Проверять нужно actual HTTP outcomes, а не только
успешный запуск SQL cron.

В production каждый Node.js cold start проверяет webhook URL и параметры в Telegram
и исправляет расхождение с `PUBLIC_BASE_URL`. Первый authenticated maintenance tick
после релиза повторно устанавливает webhook (включая secret token) и сохраняет
маркер только после Telegram readback. Ошибка проверки логируется; следующий cold
start или maintenance tick повторяет попытку. Это не заменяет расписание:
`fortnite-maintenance` должен быть активен в Supabase Cron.

В [ops/schedules.sql](ops/schedules.sql) три расписания вместо четырёх:
maintenance каждую минуту, Epic status каждые три минуты вечером и ежедневная
очистка snapshots прямо в SQL. Maintenance ставит в очередь только просроченные
сборы, публикацию за последний наступивший пятничный период и дневные snapshots,
затем восстанавливает незавершённую работу. Повторная обработка запускается каждую минуту;
объединение расписаний само по себе почти не уменьшает число HTTP вызовов.

Недельная публикация догоняет пропущенную пятницу до следующего периода; повторные
тики используют тот же ID публикации. Snapshots собираются раз в день МСК для каждого
уникального Epic-аккаунта, даже если в чате не вызывают `/teamstats`. Ошибки провайдера
повторяются отдельно от очередей чатов; закрытые/пустые профили проверяются снова на
следующий день. При первом запуске недельные данные всё ещё требуют накопления baseline.
Каждый проход ограничивает число выбранных записей; оставшаяся работа ждёт следующего тика.

После деплоя и проверки `/api/jobs/maintenance` примените SQL через Supabase tools.
Он транзакционно заменяет расписания expiry/weekly и переводит cleanup в SQL;
существующие job URL остаются доступны. SQL-only cleanup удаляет snapshots старше
30 дней.

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

Telegram Mini App со статистикой: [docs/MINI_APP.md](docs/MINI_APP.md).

## Одобрение чатов

Бот молчит во всех группах до явного одобрения владельца. Отправь `/init` или
`/init@имя_бота` в нужной группе с аккаунта, чей числовой Telegram ID записан в
`ADMIN_USER_ID`. Команда скрыта из меню; права администратора группы сами по себе
не дают права активации. Чужие, анонимные и private `/init` игнорируются.
Повторная `/init` безопасна. Одобрение в приватной таблице `approved_chats`
переживает рестарты; другие чаты остаются выключенными. Существующие чаты также требуют `/init`, автоматически они не одобряются.

Проверка действует на команды, сообщения, callbacks, приветствия, scheduled
публикации и восстановление очередей. Неодобренные сообщения не сохраняются в
очередь или историю roast. Snapshots собираются только для аккаунтов из одобренных
чатов. Неопределённые старые отправки остаются для ручного разбора.

## Адаптивный roast и меню

Все `ROAST_*` удалены: модель и технические лимиты задаются в коде.

Roast понимает обычные просьбы через reply или @упоминание: «говори реже»,
«покороче», «без мата», «замолчи», «можешь иногда комментировать». Любой участник
меняет общие предпочтения своего чата. Разовые просьбы не меняют постоянный профиль;
неоднозначные просьбы бот уточняет. В новых чатах он отвечает только на обращения.
Просьба замолчать выключает самостоятельное участие, явные обращения остаются доступны.
`/afk` сохраняется; `/roast` и `/fortemoji` удалены. Сохранённые custom titles
продолжают отображаться, новые чаты используют обычный заголовок.

JSON-флаг Vercel `roast-policy` задаёт общую политику: `proactiveAllowed`, `defaults`
(`proactive`, `frequency`, `length`, `tone`, `profanity`) и `intervals` в секундах
(`rare: 1800`, `normal: 600`, `active: 300`). `defaults.proactive=false`.
Изменение политики не требует redeploy. Профили чатов в приватной таблице
`roast_profiles` имеют приоритет над defaults; общие лимиты обязательны.
Бот только читает Flags, через deployment OIDC либо необязательный `FLAGS` SDK key
вне Vercel. Чтение ограничено 5 секундами, без streaming/polling, результат
checkpointed на work item; ошибка/невалидная политика использует defaults из кода.

Каждый релиз синхронизирует Telegram-меню на первом authenticated maintenance tick:
`setMyCommands` для групп, удаление private/default меню и проверка `getMyCommands`.
Маркер версии записывается только после успешной проверки; сбой повторяется на
следующем тике. Webhook при этом не перерегистрируется.

Перед выпуском адаптивного roast завершите или разберите незаконченные work items:
порядок checkpoints обработчика текста изменился. Новую миграцию применяйте до
деплоя runtime; не меняйте production schema при запуске бота. После релиза проверьте
результат `/api/jobs/maintenance`, меню Telegram и сохранение разговорных предпочтений.

Global Epic links migration: `20261004172914_global_epic_links.sql` removes
`epic_links.chat_id` and keys links by `user_id`. For duplicate users it keeps
the latest `linked_at` (largest `chat_id` breaks ties). Before production rollout,
pause job ingress and drain incomplete bot work: affected SQL checkpoint
signatures change. Apply the Supabase migration and deploy the matching main
release together while ingress is paused; the previous release requires the
removed column. Resume jobs and webhook ingress after verifying the release.

После релиза примените `ops/schedules.sql` через Supabase tools: daily cleanup
удаляет cache entries, истёкшие более суток назад, сохраняя stale fallback.
