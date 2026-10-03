# Telegram Mini App — статистика

`/mini-app` показывает результаты команды за последние 7 дней, Fortnite-профили
и статистику сборов. Сборы, связывание Epic и настройки остаются в групповом чате.

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
  legacy bot fetch/replay и scheduled snapshot collection продолжают работать.
- Недельный baseline — последний снапшот от 7 до 10 дней назад. Отрицательные
  изменения counters при сбросе сезона исключаются. Рейтинг: победы, затем киллы.
  K/D агрегируется через оценку смертей, как у бота. Это индивидуальные результаты
  BR во всех режимах; они не доказывают совместные матчи. UI показывает baselineAt.
- Grok загружается отдельно от фактов и кешируется на час по chat + facts hash.
  Используется app-scoped `grok/fortnite-collect-bot`. Ошибка не блокирует экран;
  анализ помечен временем исходного отчёта. Credentials остаются server-side.

## Запуск и выпуск

1. Проверить и доставить ветку через CI; production deploy допускается только из main.
2. Через Supabase tools применить `migrations/003_mini_app_cache.sql` в приватной
   схеме. Не менять webhook/job URLs и расписания. Проверить RLS и отсутствие grants
   для `PUBLIC`, `anon`, `authenticated`. Startup миграции не выполняет.
3. В BotFather включить Main Mini App с URL `https://<production>/mini-app`.
   Задать `MINI_APP_DIRECT_URL=https://t.me/<bot>/<app-short-name>` (или URL Main
   Mini App `https://t.me/<bot>`). Эта server-side настройка добавляет обычную URL
   кнопку к ответам `/stats`, `/myfnstats`, `/teamstats`, включая пятничные отчёты.
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
8. Отдельно проверить неизменность `/fort`, `/stats`, `/myfnstats`, `/teamstats`,
   webhook status и фактический HTTP-исход следующего Friday report. CI и локальные
   тесты не заменяют эти проверки. Web Analytics dashboard activation отдельно.

## Локальная проверка

`pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build` и
`TEST_DATABASE_URL=postgresql://localhost/fortnite_test pnpm test`.
Тесты разрешены только на disposable localhost базе и очищают bot tables.
Mini App не содержит browser auth bypass: вне Telegram показывает приглашение
открыть приложение в Telegram. Для визуальной проверки используются browser mocks,
не production credentials и не публичный тестовый API.
