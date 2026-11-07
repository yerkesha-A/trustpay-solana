# Неделя 9 — Raydium Liquidity

Депозит пары SPL-токенов в Raydium CPMM и вывод ликвидности со сжиганием LP. Отдельные балансы кошелька, котировки, slippage и ссылки Explorer. Escrow не используется.

Сеть: Solana Devnet. SDK: `@raydium-io/raydium-sdk-v2`.

[Пул](https://explorer.solana.com/address/8biZWzVLXx9AC5N2c3mJjbeGLGMRJzuDksCSibnvHsB3?cluster=devnet) · [Транзакции и балансы](week09-devnet-evidence.json).

Проверки: 6 тестов расчётов, 4 теста Raydium на localnet, 3 Devnet-теста, браузерные депозит/вывод, сборка и TypeScript. Браузерные транзакции подписаны тестовым provider, не вручную в расширении Phantom.

```sh
npm run test:defi
npm run test:defi:local
npm run test:defi:devnet
npm run test:defi:browser
```

Для Devnet-тестов нужны существующий `.anchor/week09-wallet.json`, тестовые SOL и токены пары. `VITE_DEFI_POOL_ID` задаёт пул интерфейса. Поддерживаются classic SPL-токены; доходность не рассчитывается.
