# Неделя 10 — Vault и RPC Dashboard

Отдельный Liquidity Vault: депозит underlying-токена выпускает shares 1:1, вывод сжигает shares и переводит токены через CPI с подписью PDA.

Dashboard показывает SOL/SPL-балансы, reserve, shares, заказы и историю. Доступны Devnet и localnet, обновление после подтверждения и обработка RPC-ошибок.

Проверяются PDA, mint, владельцы token accounts, обеспечение shares и сумма вывода. Escrow, Vault shares и Raydium LP изолированы.

[Программа Devnet](https://explorer.solana.com/address/ojfaRp5p9b8ZyK5VH5VQQQYxTWy8hi3QTorcTHtN19A?cluster=devnet) · [Транзакции](week10-devnet-evidence.json).

Проверки: 36 локальных тестов, отдельно 6 Devnet-тестов; браузерные депозит/вывод, история, сборка и TypeScript. 13 opt-in тестов общего локального запуска пропущены; они не входят в 36 успешных. Helius и ручная подпись Phantom на этом этапе не проверялись.

```sh
npm run test:rpc
anchor test --skip-build
npm run test:vault:devnet
npm run test:dashboard:devnet
```

Ограничения: Vault не инвестирует средства; shares имеют соотношение 1:1. Вывод rent и излишков reserve не реализован. Dashboard показывает ограниченную историю RPC.
