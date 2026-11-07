# Неделя 11 — AMM / CLMM

Чтение CPMM и CLMM Raydium Devnet: mint, резервы, комиссия и цена. AMM-калькулятор рассчитывает output, minimum received и price impact. CLMM-калькулятор выравнивает диапазон по ticks и рассчитывает ликвидность, A/B и остаток бюджета.

CPI-тесты проверяют создание аккаунтов через System/Token Program, ATA + депозит в одной транзакции и атомарный rollback.

Проверки: 49 локальных тестов, включая 9 тестов AMM/CLMM и 4 CPI-теста; отдельно 3 Devnet RPC-теста, браузерные проверки, сборка и TypeScript. 16 opt-in тестов общего запуска пропущены.

```sh
npm run test:market
npm run test:market:devnet
npm run test:market:browser
```

[Данные Devnet](week11-devnet-evidence.json) · [CPI](week11-cpi-evidence.json) · [Браузерные проверки](week11-browser-evidence.json).

CLMM поддерживает чтение и расчёты. Открытие и закрытие позиции не реализованы. Операции LP доступны в разделе Raydium Liquidity.
