# Неделя 12 — Raydium Swap и безопасная проверка

Дата проверки: 7 ноября 2026 года (Asia/Almaty).

**Статус: основное задание Raydium Swap реализовано и проверено реальными Devnet-транзакциями. Общая неделя 12 выполнена частично: Security & Exploit Lab не завершена.**

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
- `npx ts-mocha -p tsconfig.json tests/defi-math.ts tests/market-math.ts tests/rpc.ts tests/swap.ts` — **26 passing**.
- `npm run test:swap:rpc` — прочитан настоящий Devnet-пул, получены котировки в обоих направлениях. [Данные RPC](week12-rpc-evidence.json) содержат slot, резервы, mint и комиссию; этот скрипт не отправляет транзакций.
- `npm run test:swap:devnet` — два настоящих подтверждённых swap; проверены точное списание input и фактический output ≥ minimum. [Подписи и балансы](week12-swap-evidence.json).
- `npm run test:swap:browser` — отображение формы, desktop/mobile, отсутствие runtime page errors. Проверка не подписывает транзакции через Phantom. Дополнительная попытка browser QA загрузить живой пул не завершилась за время проверки RPC и была остановлена; успешное чтение пула и транзакции подтверждены отдельными Node-скриптами. Прямой RPC из браузера отдельно не подтверждён.
- Обычные `tests/trustpay.ts` и `tests/liquidity.ts` на отдельном localnet validator с существующим `target/deploy/trustpay.so` — **23 passing**. Лабораторные программы не загружались. Использован существующий артефакт программы; Rust-код в этом запуске не пересобирался.

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

## Статус Security Lab и ограничения

**Security & Exploit Lab не завершена. Неделю 12 целиком выполненной считать нельзя.** Существующие `labs/security-vault/`, `scripts/week12-build-lab.mjs` и `tests/security-lab.mjs` сохранены локально, не запускались, не добавлены в коммит. Намеренно уязвимые программы и демонстрации эксплуатации в этом запуске не создавались.

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
