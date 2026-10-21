# Fortnite Collect Bot

Telegram-бот для сбора сквада в Fortnite: TypeScript, Next.js App Router и grammY.
Webhook и задания работают на Vercel, данные — в приватной схеме `fortnite_bot`
Supabase Postgres. App Router также служит основой будущего Telegram Mini App.

## Команды

- `/fort [время]` — один сбор до полуночи МСК: основной состав из четырёх и FIFO-резерв из следующих четырёх. Например: `/fort через час`, `/fort через 30 минут`, `/fort в 19:30`. Автор нового сбора сразу записывается; повторный `/fort` возвращает карточку, команда с временем меняет только ответ автора.
- `/rm` — отменить и удалить текущий сбор.
- `/afk 1d`, `/afk 2w`, `/afk off` — временно отключить свои приглашения в новые сборы в этом чате. Любой участник одобренного чата может установить или снять AFK другому: `/afk @username 1d`, `/afk @username off` или `/afk 1d` / `/afk off` ответом на его сообщение. Для `@username` участник должен ранее ответить на `/fort` в этом чате; ответ на сообщение работает и без username. Username можно указать без `@` или обернуть в обратные кавычки. Явный username имеет приоритет над ответом.
- `/stats` — статистика сборов в чате.
- `/linkepicfor @user EpicName` — администратору бота: привязать публичный Epic-аккаунт участника. Привязка общая для пользователя во всех чатах; состав команды определяется историей ответов на `/fort` в выбранном чате.
- `/teamstats` — недельные дельты, MVP и лидеры; автоматическая публикация по пятницам в 21:00 МСК.

Бот работает в одобренных группах. Для закрепления и удаления карточки нужны соответствующие права.
Для custom emoji нужен Premium у владельца бота. Без недельной baseline игрок
не попадает в рейтинг; сезонные totals не заменяют недельные дельты.

## Вечерний сбор

Карточка тихо закрепляется и остаётся редактируемой до 00:00 МСК. Повторная
команда не сбрасывает участников. `/rm` удаляет карточку; история для статистики
остаётся в приватной БД. Если Telegram запрещает удаление, сбор закрывается,
бот убирает кнопки и свой закреп и сообщает об ошибке. В полночь карточка
архивируется с подписью «Вечер завершён»; это не провал по таймауту.

Ранний старт — минимальное время основного состава, округлённое вверх до пяти
минут: для 16:14 и 16:32 ориентир будет 16:15, остальные подключаются позже.
Личные времена сохраняются точно; отдельная строка показывает, когда смогут
все. Заявленная доступность сейчас и явная готовность не округляются с задержкой.
Резерв не сдвигает ориентир. Изменение времени сохраняет очередь; после Pass
возврат идёт в конец. «Состав набран» не означает «Все готовы играть».

Кнопки: присоединиться к общему времени, «Готов играть», +30м / +1ч / +2ч,
«Своё время», Pass. «Своё время» предлагает ответить сообщением. Можно написать
«буду через двадцать минут», «зашёл», «я в лобби», «отошёл на полчаса» или
«сегодня без меня». Ясное изменение собственного статуса бот отмечает реакцией
и обновлением карточки. Неуверенное намерение требует подтверждения автора;
оно действует десять минут и отменяется после нового изменения статуса.
Чужие ответы, цитаты и пересланные сообщения не меняют участие. После Pass
случайное «зашёл» не возвращает игрока: нужны кнопка, команда с временем или
явное «всё-таки буду». Готовность хранится до следующего изменения статуса,
вход в Fortnite автоматически не проверяется. Редактирования сообщений не учитываются.

Обычный текст распознаётся у записавшихся игроков; остальные обращаются к боту
или отвечают на карточку. Для получения обычных сообщений бот должен быть
администратором либо работать с отключённым privacy mode. Ответы на карточку
и кнопки доступны как запасной путь. При недоступности Grok работают точные
форматы времени и кнопки. Разбор использует существующий app-коннектор Grok,
без отдельного ключа и независимо от настроек roast.

Maintenance раз в минуту проверяет старт. При двух и более основных игроках
отправляется одно уведомление за вечер, с готовностью и временем поздних
участников. Если все уже подтвердили готовность, пинг не нужен. Переносы после
уведомления отражаются только в карточке. После удаления или полуночи
старые задания не отправляют уведомлений.

## Разработка

Node.js 24 LTS и pnpm. Пакеты устанавливаются
напрямую с `registry.npmjs.org`, без proxy. `.nvmrc` фиксирует Node major.
TypeScript 7 (`@typescript/native`) выполняет `pnpm typecheck`; alias `typescript`
на `@typescript/typescript6` предоставляет compiler API для ESLint и Next.js.
Типы Node.js остаются на major 24, как production runtime.

```bash
pnpm install --frozen-lockfile
pnpm --registry=https://registry.npmjs.org dlx supabase@2.119.0 db push --db-url "postgresql://localhost/fortnite_test?sslmode=disable"
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
pnpm --registry=https://registry.npmjs.org dlx supabase@2.119.0 db push --db-url "postgresql://localhost/fortnite_test?sslmode=disable"
TEST_DATABASE_URL=postgresql://localhost/fortnite_test pnpm test
pnpm build
```

Тесты очищают таблицы **только disposable localhost базы `fortnite_test`**.
Без `TEST_DATABASE_URL` Postgres-тесты пропускаются; такой запуск не доказывает
работу хранилища и очередей. Перед тестами примените SQL через Supabase CLI;
тестовые setup hooks больше не меняют схему. CI делает это с отдельной базой.

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
Миграции выполняет только Supabase CLI / GitHub integration; журнал —
`supabase_migrations.schema_migrations`. Кастомный TypeScript runner и команда
`pnpm bot migrate` удалены. Для локальной базы используйте `supabase db push --db-url`
с явным localhost URL, как в примере выше; CLI не читает `DATABASE_URL` из `.env` приложения. В новых SQL используйте квалифицированные
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
Supabase CLI с явным localhost `--db-url` используется для локальной разработки. Изменения SQL
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

Разговорный режим работает в одобренных группах без обязательного @тега. Бот
понимает имя в начале обращения («Грок, …»), ответы на свои сообщения и связанные
продолжения от того же участника в течение пяти минут, отдельно для каждой темы.
Изменения статуса сбора обрабатываются раньше разговорного ответа.

По умолчанию включено редкое участие: оценка новых реплик не чаще раза в пять
минут, самостоятельный текст не чаще раза в 30 минут. Явные обращения обходят
эти интервалы. Бот также может вместо текста поставить одну уместную реакцию:
🌚, 🗿, 🌭, 👀, 🤣, 🔥 и другие из небольшого набора. Учитываются разрешённые в
группе реакции; интервал самостоятельных реакций — пять минут на группу.
Реакции работают для текста и подписей к медиа, без распознавания изображений.
«Замолчи» отключает самостоятельные реплики и реакции; явные обращения остаются.
Существующее явное отключение сохраняется. Read-only флаг `roast-policy` может
переопределить defaults или полностью запретить самостоятельное участие.

В приватном Postgres сохраняются текст и подписи полученных сообщений с автором,
датой, темой, исходным message ID и связью reply. Поиск использует историю за
последние 30 дней, полнотекстовые индексы русского/простого словарей, до трёх
переформулировок Grok и до 20 кандидатов. В ответ попадают до пяти проверенных
источников. Произвольная история Telegram до включения функции не загружается;
из прежнего короткого контекста переносятся только записи с известными ID.
Ссылки формирует код, а не модель; в обычных группах вместо ссылки используется
цитата. Бот может ответить прямо на старую реплику. «Откуда ты это знаешь?»
поднимает источники прежнего ответа. Удалённый исходный пост обрабатывается
запасным reply на текущий запрос только после однозначного отказа Telegram.

В памяти автоматически выделяются явные факты автора о себе, предпочтения и
договорённости. Maintenance ставит до пяти работ на запуск, не чаще раза в
десять минут на группу; одна работа разбирает до 20 сообщений. Grok получает эти
фрагменты даже если бот на них не отвечал. Команды и пересланные сообщения не
попадают в автоматическое извлечение. При сбое модели сообщения остаются для
следующего пакета, а очередь чата продолжает работу. Временные планы имеют срок;
постоянные факты и подтверждающий фрагмент хранятся до удаления. Очистка архива
встроена в ежедневный cleanup. Правки обновляют архив и отменяют факты из
изменённой цитаты; сами правки не вызывают ответ и не меняют статус сбора.

«Запомни: я обычно играю после девяти» сохраняет факт сразу. Можно ответить
«запомни» на собственную реплику. «Забудь …» удаляет все факты из выбранного
источника; неоднозначную просьбу бот уточняет у автора. Удалять может автор
источника либо владелец (`ADMIN_USER_ID`). Исходник и просьба об удалении
исключаются из разговорного контекста, цитаты бота очищаются, остаются пустые
служебные записи, защищающие от повторного извлечения и редактирования.
История сборов, payload очереди и checkpoints имеют отдельное техническое
назначение: команда «забудь» не обещает удалить их или сообщения в Telegram.

Опциональный `MEM0_API_KEY` дополняет основную память: перед генерацией ищутся до
пяти воспоминаний автора, после успешного обычного ответа передаются его реплика
и ответ бота. Весь архив туда не отправляется. Область — Telegram user ID внутри
конкретной группы. Старые воспоминания Mem0 без источника не считаются цитатами.
Без ключа или при сбое Mem0 поиск и память в Postgres продолжают работать.
SDK telemetry отключена; все HTTP-запросы awaited и ограничены пятью секундами.

При забывании атомарно переключается поколение Mem0-памяти автора: старое больше
не читается, даже если внешнее удаление не удалось. Удаляется всё прежнее
поколение пользователя в этой группе; остальные факты остаются в Postgres.
После DELETE выполняется контрольное чтение. При ошибке бот сообщает о
незавершённом внешнем удалении; maintenance делает до шести попыток с интервалом
не менее десяти минут. После исчерпания попыток требуется ручная проверка
`conversation_memory_deletions` и Mem0 dashboard. Отсутствующий ключ не позволяет
подтвердить удаление ранее существовавшей внешней памяти.

Новая обработка использует checkpoints `conversation-*-v2`; старая
`adaptive-roast-v1` остаётся для ранее поставленных работ. В миграции всем
существующим работам присваивается `conversation_version=1`, новый код явно
ставит `2`. SQL-записи атомарны со своими checkpoints; результаты модели,
поиска, исходные времена, отправки и реакции переиспользуются при retry.
Принятый Mem0 `add` и его подтверждение имеют отдельные checkpoints; между
Postgres и Mem0 нет общей транзакции, поэтому обрыв до сохранения receipt может
повторить внешнюю запись. Неопределённый исход Telegram send по-прежнему
блокирует причинную очередь до ручного разбора.

Порядок выпуска: [контекстная память](ops/contextual-memory-release.md).

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
продолжают отображаться. По умолчанию FORT набирается четырьмя custom emoji из одного
набора: [WideABC](https://t.me/addemoji/WideABC),
[ABC Emoji](https://t.me/addemoji/ABCEmoji), [Lazer](https://t.me/addemoji/LazerABC)
или [Hackerman](https://t.me/addemoji/HackermanABC). ABC Emoji анимирован; остальные
три набора статические. ID и буквы проверены через Telegram Bot API и превью набора.
Набор определяется случайным сохранённым стилем сбора и остаётся прежним при
обновлении состава, перезапуске бота и закрытии сбора. Пустая строка отделяет
заголовок от приглашения.

В теле `/fort` значки Go, Пас, состава, резерва, упоминаний, истечения времени и
отмены используют анимированные custom emoji из Fluent Emoji (наборы 4–7).
Текстовые подписи сохраняются; кнопки используют обычные emoji.

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

### Runtime logs

Vercel captures the bot's JSON console output in the project's **Logs** tab.
Filter by `request.failed`, `request.rejected`, `work.failed`,
`work.review_required`, `telegram.rejected`, `telegram.failed`, `job.failed`, or `job.recovery_failed` to investigate problems.
`request_id` connects request and nested work events and is returned in the
`X-Request-ID` response header; `work_ref` is a stable
hash of the durable work key, so retries across requests can be correlated
without publishing embedded chat IDs. Request/work/job completion events include
durations; job completion distinguishes duplicate and overlapping runs.
A successful webhook HTTP response with `work.review_required` still requires
manual reconciliation of the uncertain send. Maintenance can succeed while
individual recovered work fails: inspect work/recovery events as well.
Logs omit message bodies, headers, credentials, and raw error descriptions.
Sentry work errors carry the same `work_ref`, infrastructure diagnostic codes,
and numeric Telegram error codes; exception text remains scrubbed.
These logs become available after deploying the change. Vercel log retention
and access depend on the project's plan and account permissions.

## Выпуск нового флоу сборов

Перед публикацией применить `20261021143343_gathering_evenings.sql` через Supabase.
Миграция сохраняет старые времена доступности и не выдаёт их за подтверждение
готовности. До смены обработчиков завершить задания старого deployment: SQL
проверки `SELECT id,kind,status FROM fortnite_bot.work_items WHERE status<>'complete'`
и `SELECT work_id,step,status FROM fortnite_bot.work_steps WHERE status='started'`
должны быть разобраны. Начатые старые checkpoints нельзя переигрывать новым
порядком; неоднозначные отправки требуют ручной сверки. До переключения дождаться
завершения старых вызовов; непройденные задания обработать прежним deployment.
Не очищать историю checkpoints ради обхода проверки.

После выпуска из main отдельно проверить закреп/снятие закрепа, права удаления,
обычное сообщение «зашёл», webhook и HTTP-результат maintenance. Локальные
тесты не подтверждают состояние Telegram или production Cron.
