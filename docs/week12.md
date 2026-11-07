# Неделя 12 — Swap и Security Lab

Raydium CPMM Swap: A → B / B → A, котировка на 30 секунд, slippage, minimum received, проверка баланса, подпись Phantom, подтверждение и обновление балансов. Используются свободные ATA кошелька; escrow не участвует.

## Phantom Swap

[Транзакция Devnet](https://explorer.solana.com/tx/5VuPDpWkRiYfLcq5A22WfrAvFBLD2xjH5Yjjrb35KQZRmTzjpymNE8akhnAwCdDBT5b231otvq5rBvsdfA8Gb4Cw?cluster=devnet).

| Параметр | Значение |
| --- | --- |
| Статус | finalized |
| Input A | 1 |
| Output B | 0,996513 |
| Minimum B | 0,991530 |
| Slippage | 50 bps |
| Compute limit | 200000 CU |
| Priority fee | 0 SOL |
| Network fee | 0,000005 SOL |
| Rent output ATA | 0,00148844 SOL |

Ручные отказ и подтверждение проверены в Phantom Chrome. Подпись, инструкции и балансы сверены с RPC. [Доказательства](week12-phantom-success.json).

Compute Budget задаётся до подписи. Изменения инструкций, сумм, получателей, прав, blockhash или комиссии отклоняются. Phantom ранее добавлял 200000 CU × 375000 micro-lamports/CU: 0,000075 SOL priority fee. Регрессия использует точные данные этой попытки.

## Security Lab

Исправленный vault проверен на изолированном localnet. Удалён режим без `has_one=owner`. Проверяются подпись владельца, PDA, mint, token authority и сумма вывода. 12 неавторизованных/некорректных операций отклонены без изменения балансов; разрешённый вывод выполнен. [Результаты](week12-security-evidence.json).

## Проверки

44 unit-теста, 23 контрактные регрессии, Security Lab, TypeScript, сборка и браузерная проверка desktop/mobile — успешно.

```sh
npm run test:unit
npx tsc --noEmit -p tsconfig.json
npm run build
npm run build:security
npm run test:security
npm run test:phantom:request
npm run test:swap:browser
```

```dotenv
VITE_NETWORK=devnet
VITE_RPC_URL=https://api.devnet.solana.com
VITE_DEFI_RPC_URL=https://api.devnet.solana.com
VITE_PROGRAM_ID=ojfaRp5p9b8ZyK5VH5VQQQYxTWy8hi3QTorcTHtN19A
```

Запуск: `npm ci`, затем `npm run dev -w app`. Нужны Phantom Devnet, тестовые SOL и токены пары. Настройки — в игнорируемом `app/.env.local`.

[Предыдущие CLI swap](week12-swap-evidence.json) · [Повторная проверка](week12-swap-reverification.json).

![Desktop](screenshots/week12-desktop.png)
![Mobile](screenshots/week12-mobile.png)

Поддерживаются CPMM и classic SPL. Нет Token-2022, SOL wrapping и CLMM swap. Лаборатория не развёртывалась в публичной сети. Независимый аудит не проводился.
