# Telegram Mini App — статистика

Главная страница `/` показывает результаты команды за последние 7 дней, Fortnite-профили
и статистику сборов. Сборы, связывание Epic и настройки остаются в групповом чате.
`/mini-app` остаётся совместимым адресом для ранее настроенных Telegram кнопок;
обе страницы показывают одно приложение без перенаправления данных запуска.

## Архитектура

- `src/statistics/` содержит общие расчёты eligibility, рейтинга, сумм, Grok facts,
  профилей и кеша без React. HTML остаётся в `src/bot/messages.ts`.
- API `/api/mini-app/{chats,weekly,profile,gatherings,refresh,analysis}` — тонкие
  Node.js routes. На каждом запросе проверяется HMAC raw Telegram `initData`,
  `auth_date` (не старше часа), viewer и текущее членство в выбранной группе.
  Все ответы, включая ошибки, приватны и имеют `Cache-Control: no-store`.
- Бот должен быть администратором: `getChatMember` иначе не даёт надёжной проверки.
  Ошибка Telegram закрывает доступ. Это относится и к данным из кеша.
- Chat switcher получает кандидатов из responses, инициированных sessions и Epic
  links. `startapp=chat_<absolute-chat-id>` только выбирает известный чат после
  проверки членства. Чужой player ID разрешён только при наличии Epic link в
  выбранном чате. Пересланный launch link не даёт доступа.
- `fortnite_bot.statistics_cache` приватна, с RLS без публичных grants/policies.
  Версия кеша задаётся сервисом. Профили хранятся 15 минут отдельно для `season`
  и `lifetime`. Advisory locks объединяют одновременные обновления и ограничивают
  provider refresh двумя вызовами. Бюджет обновления команды — 60 секунд;
  недоступные игроки показываются отдельно. Временная ошибка позволяет показать
  устаревший профиль с timestamp, но исключает его из недельного зачёта.
- Успешное обновление season атомарно сохраняет кеш и снапшот через общий writer.
  Lifetime не пишет снапшоты. Существующие bot checkpoint names и порядок сохранены;
  bot fetch/replay и scheduled snapshot collection продолжают работать.
- Недельный baseline — последний снапшот от 7 до 10 дней назад. Отрицательные
  изменения counters при сбросе сезона исключаются. Рейтинг: победы, затем киллы.
  K/D агрегируется через оценку смертей, как у бота. Это индивидуальные результаты
  BR во всех режимах; они не доказывают совместные матчи. UI показывает baselineAt.
- Grok загружается отдельно от фактов и кешируется на час по chat + facts hash.
  Используется app-scoped `grok/fortnite-collect-bot`. Ошибка не блокирует экран;
  анализ помечен временем исходного отчёта. Credentials остаются server-side.
- Session Replay отключён: маскирование DOM не защищает данные Telegram в URL
  запуска. Web Analytics и Speed Insights удаляют query и hash перед отправкой событий. Sentry
  диагностика исключает запросы, headers, payloads и пользовательские данные.
- Ответы имеют `nosniff`, `Referrer-Policy: no-referrer` и запрещают доступ к
  camera/microphone/geolocation. Framing не запрещён, чтобы работал Telegram Web.

## Запуск и выпуск

1. Проверить и доставить ветку через CI; production deploy допускается только из main.
2. Через Supabase tools применить `supabase/migrations/20261004125048_mini_app_cache.sql` в приватной
   схеме. Не менять webhook/job URLs и расписания. Проверить RLS и отсутствие grants
   для `PUBLIC`, `anon`, `authenticated`. Startup миграции не выполняет.
3. В BotFather включить Main Mini App с URL `https://<production>/`.
   Задать `MINI_APP_DIRECT_URL=https://t.me/<bot>/<app-short-name>` (или URL Main
   Mini App `https://t.me/<bot>`). Эта server-side настройка добавляет обычную URL
   кнопку к ответам `/stats`, `/teamstats`, включая пятничные отчёты.
   Личная Fortnite-статистика доступна в Mini App; `/myfnstats` удалена.
   После deploy выполнить `pnpm bot configure-commands` с production BOT_TOKEN,
   чтобы убрать старую команду из Telegram меню без изменения webhook.
4. После проверки страницы выполнить явно
   `pnpm bot configure-mini-app https://<production>` для menu button.
   Команда проверяет HTTPS и доступность страницы; webhook она не меняет.
5. Назначить бота администратором используемых групп. Проверить вход участника,
   вышедшего пользователя, неизвестный чат, пересланную ссылку, недоступный Telegram
   и профиль игрока из другой группы.
6. С `FORTNITE_API_KEY` получить live season/lifetime payload для связанных аккаунтов,
   сверить inputs, placement fields, minutesPlayed, battlePass и единицы процентов.
   Сохранять только обезличенные fixtures. Сейчас тесты используют синтетические
   payloads; live provider verification требуется перед выпуском.
7. В Telegram iOS, Android и desktop проверить light/dark, safe areas, узкий экран,
   Back из профиля, фильтры, пустые состояния, ошибки и частичную недоступность API.
8. Отдельно проверить неизменность `/fort`, `/stats`, `/teamstats`,
   webhook status и фактический HTTP-исход следующего Friday report. CI и локальные
   тесты не заменяют эти проверки. Web Analytics dashboard activation отдельно.
9. Speed Insights подключён через Next.js компонент в корневом layout. В Vercel
   включить Speed Insights для проекта и после production deploy подтвердить приём
   метрик; локальная сборка не доказывает dashboard activation или ingestion.

## Локальная проверка

`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build` и
`TEST_DATABASE_URL=postgresql://localhost/fortnite_test pnpm test`.
Тесты разрешены только на disposable localhost базе и очищают bot tables.
Mini App не содержит browser auth bypass: вне Telegram показывает приглашение
открыть приложение в Telegram. Для визуальной проверки используются browser mocks,
не production credentials и не публичный тестовый API.

## Проверка безопасности 2026-10-04

- Source и локальные тесты: HMAC и срок сессии, отсутствие browser auth bypass,
  отказ при выходе из группы/пересланной ссылке/ошибке Telegram, повторная проверка
  членства перед кешем, ограничение профилей Epic links выбранной группы.
- Disposable Postgres: RLS включён, grants для `PUBLIC`, `anon`, `authenticated`
  на `statistics_cache` отсутствуют. Production права и Data API settings требуют
  отдельного read-only подтверждения через Supabase tools; здесь оно не выполнено.
- Production HTTP: `/weekly` без initData вернул 401; поддельная подпись на
  `/weekly`, `/gatherings`, `/refresh` вернула 401. Все проверенные ответы имели
  `Cache-Control: no-store, private`. Проверки `/chats`, `/profile`, `/analysis`
  остановились на сетевых timeout, поэтому их live исход не подтверждён.
- Локальная production сборка: `/` и `/mini-app` возвращают приложение и защитные
  headers; браузер без Telegram показывает приглашение открыть приложение в Telegram.
  Авторизованный live вход и реальные права групп этим не проверены.
- Replay отключён и analytics URL очищается в этом изменении; production получит
  исправления после merge/deploy. Это проверка перечисленных границ, не pentest.
