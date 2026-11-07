# TrustPay

Escrow-платежи на Solana. Anchor, React, TypeScript и Phantom.

## Функции

- Создание заказа, депозит SPL-токенов, сдача работы, выплата и согласованный возврат.

## Запуск

```sh
npm ci
npm run dev -w app
```

Настройки сети — в `app/.env.local`, образец — `.env.example`. Используются localnet / Solana Devnet и тестовые SPL-токены.

```dotenv
VITE_NETWORK=localnet
VITE_RPC_URL=http://127.0.0.1:8899
VITE_PROGRAM_ID=ojfaRp5p9b8ZyK5VH5VQQQYxTWy8hi3QTorcTHtN19A
```

## Проверки

```sh
npm run build
npx tsc --noEmit -p tsconfig.json
anchor test
```

## Документация

- [Escrow](docs/week08.md)

Escrow не поддерживает арбитраж и автоматический возврат. Отмена требует согласия исполнителя.
