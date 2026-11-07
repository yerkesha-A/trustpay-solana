# Неделя 12 — Raydium Swap и Security Lab

Дата проверки: 7 ноября 2026 года (Asia/Almaty).

**Raydium Swap и безопасная Security Lab реализованы и проверены. Ручное подтверждение в расширении Phantom остаётся непроверенным; полное end-to-end закрытие недели пока не подтверждено. Завершающие изменения находятся в отдельной ветке и требуют одобренного merge в main.**

## Цель и реализация

Обмен свободных тестовых SPL-токенов через настоящий Raydium CPMM, без доступа к escrow или Liquidity Vault TrustPay. Разработка продолжает существующий проект; программы TrustPay не изменены.

- Используется установленный `@raydium-io/raydium-sdk-v2@0.2.81-alpha`: CPMM layouts/PDA, `makeSwapCpmmBaseInInstruction`. Это настоящая инструкция Raydium, без собственного имитатора AMM.
- Данные заданного публичного Devnet-пула читаются из RPC: владельцы, discriminator, SPL mint/vault, резервы, config и торговая комиссия. Есть готовый учебный пул и ввод другого адреса. Каталог всех пулов и mainnet API не используются.
- Выбор A → B / B → A, точные BigInt-расчёты, комиссия, price impact, slippage 1–500 bps и minimum received. Расчёт проверен относительно закреплённого SDK существующими AMM-тестами.
- Quote привязан к кошельку и данным пула, действует 30 секунд. Изменение полей формы сбрасывает quote; перед подписью перечитываются пул и балансы, проверяются PDA и доступность обменов. После подписи срок проверяется повторно.
- Источник и получатель — только ATA подписанта. Создание output ATA идемпотентно. В интерфейсе кошелёк подписывает транзакцию, затем выполняются preflight, отправка и подтверждение. Сообщение об успехе появляется только после подтверждения без ошибки; балансы перечитываются после него.
- Explorer доступен по подписи, в том числе при неопределённом результате отправки. Ошибки RPC, недостаточный баланс, просроченная котировка и отказ кошелька отображаются пользователю.
- Адаптивная форма встроена в существующую вкладку DeFi. Проверена ширина 390 px без горизонтального переполнения.

## Проверки

- `npm run build` — успешно; Vite предупреждает о крупных JS chunks.
- `npx tsc --noEmit -p tsconfig.json` — успешно.
- `npm run test:unit` — **29 passing**: прежние 26 unit-тестов и 3 новых теста запроса подписи, отказа и проверки ответа кошелька.
- `npm run test:swap:rpc` — прочитан настоящий Devnet-пул, получены котировки в обоих направлениях. [Данные RPC](week12-rpc-evidence.json) содержат slot, резервы, mint и комиссию; этот скрипт не отправляет транзакций.
- Ранее `npm run test:swap:devnet` подтвердил два настоящих swap и проверил input/output ≥ minimum. [Исходные подписи и балансы](week12-swap-evidence.json) сохранены. В завершающем запуске обмены **не повторялись**: `npm run verify:swap` перечитал обе транзакции как **finalized**, заново проверил метаданные token balances. [Повторная проверка](week12-swap-reverification.json).
- `npm run test:swap:browser` — отображение формы, desktop/mobile, отсутствие runtime page errors. Проверка не подписывает транзакции через Phantom. Дополнительная попытка browser QA загрузить живой пул не завершилась за время проверки RPC и была остановлена; успешное чтение пула и транзакции подтверждены отдельными Node-скриптами. Прямой RPC из браузера отдельно не подтверждён.
- Обычные `tests/trustpay.ts` и `tests/liquidity.ts` на отдельном localnet validator с существующим `target/deploy/trustpay.so` — **23 passing**. В этом отдельном validator лабораторные программы не загружались. Использован существующий артефакт TrustPay; Rust-код TrustPay не изменён и не пересобирался. Эти 23 теста повторены при завершении Security Lab.

## Подтверждённые транзакции

Сеть — **Devnet**, только существующая учебная пара с 6 decimals, по 1 тестовому токену. Это не mainnet и не средства заказов. CLI-подписант — существующий учебный кошелёк проекта; приватный ключ не публикуется.

| Направление | Input (raw) | Minimum (raw) | Получено (raw) | Explorer |
| --- | ---: | ---: | ---: | --- |
| A → B | 1000000 | 991528 | 996511 | [Подтверждённый swap](https://explorer.solana.com/tx/34yYvSnGXxJTUnxVCyuW7bzovDBp14P8wcug9oAAeciGHGTNnDKY8Zx1amYMYkoQGRtjgk8DsWJJSZBNK7tcgN7E?cluster=devnet) |
| B → A | 1000000 | 993497 | 998490 | [Подтверждённый swap](https://explorer.solana.com/tx/4EBbXzBYYTysG6v26iPRQcvhr5KATgCrCVUS6UvQBAgCK6H7j4ixn5xaEYRn3MDmMaemxedu68YUwgdMrLd5uHP?cluster=devnet) |

## Безопасная статическая проверка

Проверены `programs/trustpay/src/lib.rs`, `programs/trustpay/src/liquidity.rs` и shared swap/pool loader. Это ограниченная проверка исходников и регрессионные тесты, а не полный аудит.

- Escrow: client/freelancer требуют `Signer`, действия freelancer используют `has_one`, order проверяется по seeds и bump. Источник funding привязан к client/mint. Выплата требует client, правильный mint, vault PDA и получателя по роли. Статусы исключают повторный вывод; refund требует предварительное согласие freelancer. CPI подписывается order PDA и переводит только зафиксированную сумму заказа.
- Liquidity Vault: отдельные seeds для vault/share mint/reserve, `has_one` связывает аккаунты. Пользовательские token/share accounts привязаны к подписанту и mint. Вывод сжигает собственные shares, проверяет резерв/обеспечение; overflow и нулевые суммы отклоняются. Burn и transfer атомарны. Escrow PDA не подходит как источник пользовательского депозита.
- Типы Anchor `Account<Mint/TokenAccount>` и `Program<Token>` проверяют владельцев/программу. Единственный `UncheckedAccount` freelancer при создании используется только как публичная идентичность.
- Swap не принимает произвольный source/vault TrustPay: ATA выводится из подписанта и mint. Devnet проверяется по genesis hash; CPMM program ID закреплён. Перепроверяются pool/vault/observation PDA. On-chain minimum защищает от движения цены после чтения RPC.
- Существующие отрицательные тесты подтвердили отказы чужим подписантам, чужим token accounts, подменённым mint/vault и повторному/чрезмерному выводу. Новые swap-тесты проверяют привязку quote к владельцу, изменение minimum/output/direction, timestamps и посторонний mint.

## Security Lab: аудит, исправление и результаты

Лаборатория завершена в безопасном объёме этого задания: исправленный учебный контракт и проверки отказа в неавторизованных действиях, только на выделенном localnet. Демонстрации успешного неавторизованного вывода не выполнялись.

Найденная проблема: исходный черновик `labs/security-vault/` содержал feature `vulnerable`, который выбирал контекст Withdraw без `has_one = owner`. Требование подписи и правильный PDA сами по себе не связывают подписанта с владельцем vault. Исходный default-контекст уже имел правильную проверку; исправление устраняет альтернативный небезопасный путь **во всех сборках**, а не приписывает старому default новый контроль.

Из Cargo features и Rust-кода удалён небезопасный вариант. Сборщик теперь создаёт только исправленный SBF; тестовый harness заменён регрессионными проверками отказов. Исходные учебные файлы сохранены локально в игнорируемой `.anchor/week12-original-lab/`, не включены в коммит и не запускались. Новые намеренно уязвимые программы не создавались.

Проверены связи `Signer` → `vault.owner`, `has_one=mint`, seeds/bump vault и reserve, типизированные владельцы Anchor/SPL, `token::authority`, `token::mint` назначения и фиксированный `Program<Token>`. Сумма должна быть положительной и не больше reserve. CPI может подписать только vault PDA. Лабораторная модель — один vault на владельца, один сохранённый mint, без сторонних получателей и без повторного deposit в уже созданный vault.

`npm run build:security` успешно собрал исправленный SBF **offline / locked**. `npm run test:security` завершился с кодом 0: **12 отказов + 1 успешный сценарий полного вывода**, после предварительного депозита. Каждый отрицательный тест проверяет ожидаемую ошибку и неизменность reserve/source/foreign token balances:

1. Чужой подписант — `ConstraintHasOne`.
2. Отсутствие подписи владельца — `AccountNotSigner`.
3. Перенаправление получателю — `ConstraintTokenOwner`.
4. Неправильный mint назначения — `ConstraintTokenMint`.
5. Подмена mint vault — `ConstraintHasOne`.
6. Подмена vault — `AccountOwnedByWrongProgram`.
7. Подмена reserve PDA — `ConstraintSeeds`.
8. Неправильный владелец mint account — `AccountOwnedByWrongProgram`.
9. Подмена SPL Token program — `InvalidProgramId`.
10. Нулевая сумма — `InvalidAmount`.
11. Сумма сверх reserve — `InvalidAmount`.
12. Повторный вывод после полного разрешённого вывода — `InvalidAmount`.

Полный разрешённый вывод вернул владельцу 100 учебных токенов; reserve стал 0, чужой баланс остался 0. [JSON-доказательства](week12-security-evidence.json) содержат hash SBF, локальный genesis, успешные подписи и результаты проверок. Отрицательные инструкции отклоняются preflight simulation, а не обходят его через `skipPreflight`.

Harness использует только `127.0.0.1:9899`, создаёт собственный validator/новый ledger и сверяет RPC identity с identity этого ledger. Mainnet/Devnet genesis отклоняются. Все кошельки генерируются для теста, токены выпускаются локально; ключи и ledgers не публикуются. Публичного деплоя Security Lab не было. Это ограниченный аудит и регрессии, а не независимый полный security audit.

## Phantom: что проверено и что требует владельца

В приложении подключён `PhantomWalletAdapter`; swap вызывает `requestWalletSignature` → wallet adapter `signTransaction`. Helper задаёт fee payer и свежий blockhash, запоминает message и после ответа проверяет неизменность message и действительность подписи. Ошибка/отказ очищает уведомление ожидания; до действительной подписи отправки нет.

`npm run test:phantom:request` прошёл через **настоящий установленный adapter**, но **с синтетическим provider**, без настоящего расширения и без подписи. Проверены один вызов provider, unsigned Raydium-инструкция, правильный payer/blockhash, ATA владельца, input и minimum в байтах инструкции. Provider отклонил запрос; отказ дошёл до вызывающего кода. [Доказательство проверки границы adapter](week12-phantom-request-evidence.json). Три unit-теста дополнительно проверяют передачу транзакции и отказ от неподписанного/изменённого ответа.

**Ручная подпись владельца в настоящем расширении Phantom не проверена и не заменена тестовой подписью.** Для неё:

1. Запустить `npm ci`, затем `npm run dev -w app`; открыть `http://127.0.0.1:5173` в браузере с Phantom. Использовать отдельный учебный кошелёк, включить test networks и выбрать Solana Devnet в настройках Phantom.
2. Получить Devnet SOL на комиссии и свободные тестовые SPL-токены существующей пары в ATA **этого кошелька**. Использовать токены, выданные владельцем учебного mint; escrow и Liquidity Vault не трогать. Не импортировать CLI-ключ и не передавать seed-фразу.
3. Открыть **DeFi · Raydium → Raydium Swap · Devnet**, подключить Phantom, убедиться, что публичный адрес в приложении совпадает с выбранным кошельком. Загрузить предзаполненный пул `8biZWzVLXx9AC5N2c3mJjbeGLGMRJzuDksCSibnvHsB3`.
4. Выбрать A → B, небольшое доступное количество, slippage 50 bps; получить котировку. Проверить оба mint, ожидаемый output, minimum received и свободный баланс. При RPC-ошибке не продолжать, настроить разрешённый Devnet RPC через `VITE_DEFI_RPC_URL` и перезапустить frontend.
5. Нажать **Подписать swap тестовых токенов**. В Phantom проверить домен, текущий кошелёк, Devnet и изменение тестовых токенов. Сначала отклонить запрос: приложение должно показать отказ, без сообщения об успехе и без отправленного swap.
6. Получить **новую** котировку и повторно открыть запрос. Только владелец вручную подтверждает его. Quote действует 30 секунд: если истёк, получить новый; не обходить проверку срока.
7. Дождаться подтверждения в приложении и обновления балансов. Открыть Explorer с `?cluster=devnet`, проверить отсутствие ошибки, input и output ≥ minimum. При неопределённом результате сначала проверить подпись в Explorer, затем решать о повторе.
8. Сохранить публичную подпись и скриншоты окна подтверждения/результата без секретов. До появления этих данных ручной пункт остаётся **не проверен**.

## Известные ограничения

Реальный swap подтверждён программным учебным подписантом; end-to-end подпись в расширении Phantom вручную не проверена. Browser smoke test подтверждает отображение и адаптивность, не выполнение swap. Поддерживаются CPMM и классические SPL-токены пары; Token-2022, native SOL/wrapping, CLMM swap, маршрутизация и каталог всех пулов не реализованы. Нужны собственные тестовые токены в ATA и Devnet SOL на комиссии/создание ATA. Публичный RPC может возвращать rate limit. Неопределённый результат отправки следует проверять по подписи в Explorer перед повтором. Чтение нескольких RPC аккаунтов не является единым атомарным snapshot; окончательную защиту обеспечивает minimum в инструкции.

## Запуск

```sh
npm ci
npm run dev -w app
```

Открыть `http://127.0.0.1:5173`, вкладку **DeFi · Raydium**, форму **Raydium Swap · Devnet**. Подключить отдельный Phantom Devnet-кошелёк, загрузить пул, выбрать направление/amount/slippage, получить quote и подписать обмен. Публичный готовый пул указан в форме. CLI-ключ не импортировать в браузер.

```sh
npm run build
npx tsc --noEmit -p tsconfig.json
npm run test:swap
npm run test:market
npm run test:unit
npm run build:security
npm run test:security
npm run test:phantom:request
npm run verify:swap
npm run test:swap:rpc
# Требует запущенного frontend и установленного Chrome:
npm run test:swap:browser
# Отправляет реальные тестовые Devnet-транзакции; требует существующий
# .anchor/week09-wallet.json и его свободные тестовые токены/SOL:
npm run test:swap:devnet
```

Воспроизведение обычных контрактных регрессий на отдельном localnet (существующий собранный `trustpay.so`, без лаборатории):

```sh
solana-test-validator --ledger .anchor/week12-safe-ledger --rpc-port 8909 --faucet-port 9919 --dynamic-port-range 10240-10260 --bind-address 127.0.0.1 --bpf-program ojfaRp5p9b8ZyK5VH5VQQQYxTWy8hi3QTorcTHtN19A target/deploy/trustpay.so --quiet
# В другом терминале, с существующим локальным тестовым кошельком:
solana airdrop 10 .anchor/local-wallet.json --url http://127.0.0.1:8909
ANCHOR_PROVIDER_URL=http://127.0.0.1:8909 ANCHOR_WALLET=.anchor/local-wallet.json npx ts-mocha -p tsconfig.json -t 180000 tests/trustpay.ts tests/liquidity.ts
```

## Скриншоты для отчёта

Сняты с запущенного приложения, без выдуманного уведомления об успешном swap. Подтверждения реальных обменов приведены отдельно в Explorer и JSON.

![Desktop: форма Raydium Swap](screenshots/week12-desktop.png)

![Mobile: форма Raydium Swap, 390 px](screenshots/week12-mobile.png)


## GitHub и итоговая история

Исходный опубликованный Raydium-коммит: [`5fe787025d701a90c68275efdc275601b5295170`](https://github.com/yerkesha-A/trustpay-solana/commit/5fe787025d701a90c68275efdc275601b5295170), повторно сверен с удалённой main перед началом. Завершение Security Lab сделано в ветке `week12-complete-security-lab` от этого main. Содержимое PR подготовлено в [week12-pr.md](week12-pr.md); [создать PR из опубликованной ветки](https://github.com/yerkesha-A/trustpay-solana/compare/main...week12-complete-security-lab?expand=1). Сам PR в этом запуске не создан: GitHub-интеграция не подключена, CLI `gh` отсутствует. Merge без подтверждения владельца не выполняется.

Один squash-коммит, объединяющий **уже опубликованный** Raydium-коммит с новыми изменениями, получить без переписывания main нельзя. Безопасный вариант — сохранить первый коммит и добавить второй завершающий коммит (либо squash только новой PR-ветки). Тогда итоговый коммит содержит полный снимок Raydium + Security Lab, а история сохраняет два последовательных коммита недели 12. Для таблицы использовать ссылку на завершающий коммит, с честным статусом ручного Phantom-теста и merge.
