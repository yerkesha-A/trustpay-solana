# TrustPay

Escrow-платежи на Solana. Anchor, React, TypeScript и Phantom.

## Функции

- Создание заказа, депозит SPL-токенов, сдача работы, выплата и согласованный возврат.
- Депозит и вывод ликвидности Raydium CPMM.
- Liquidity Vault 1:1 и RPC Dashboard.
- Расчёты AMM и диапазонов CLMM.
- Raydium Swap и проверка безопасности vault.
- Mock USD Payments и управление CLMM-позициями.

## Запуск

```sh
npm ci
npm run dev -w app
```

Настройки сети — в `app/.env.local`, образец — `.env.example`. Используются localnet / Solana Devnet и тестовые SPL-токены.

```dotenv
VITE_NETWORK=devnet
VITE_RPC_URL=https://api.devnet.solana.com
VITE_PROGRAM_ID=ojfaRp5p9b8ZyK5VH5VQQQYxTWy8hi3QTorcTHtN19A
```

## Проверки

```sh
npm run build
npx tsc --noEmit -p tsconfig.json
npm run test:unit
npm run build:security
npm run test:security
```

## Документация

- [Escrow](docs/week08.md)
- [Raydium liquidity](docs/week09.md)
- [Vault и RPC Dashboard](docs/week10.md)
- [AMM / CLMM](docs/week11.md)
- [Swap и Security Lab](docs/week12.md)
- [Mock USD Payments и CLMM Positions](docs/week13.md)

Неделя 13: Devnet payment/CLMM циклы проверены программными подписантами; ручная проверка новых операций Phantom ожидается. Mock USD — тестовая имитация, не USDC и не обеспеченный резервами актив.
