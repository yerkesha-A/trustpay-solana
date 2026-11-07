# Неделя 8 — Escrow

## Функции

Заказы на SPL-токенах: создание, депозит, сдача работы, выплата и согласованный возврат. Подключение Phantom, роли заказчика и исполнителя, статусы и история транзакций.

| Инструкция | Переход |
| --- | --- |
| create_order | Funded |
| submit_work | Funded → Submitted |
| allow_cancel | Funded → CancelApproved |
| release | Submitted → Paid |
| refund | CancelApproved → Refunded |

PDA заказа: `["order", client, id]`. PDA хранилища: `["vault", order]`. Проверяются подписант, mint, владелец token account и статус. Повторная выплата запрещена.

## Проверки

Проверено на localnet: 11 контрактных тестов, браузерный E2E, сборка и TypeScript. Браузерный тест использует тестовый wallet provider; ручная подпись Phantom на этом этапе не проверялась.

## Запуск проверок

```sh
anchor build
npm run sync:idl
anchor test --skip-build
npm run build
npx tsc --noEmit -p tsconfig.json
```

## Ограничения

 classic SPL Token; нет арбитража, таймаута и автоматического возврата. Отмена требует согласия исполнителя до сдачи работы. Аккаунты заказа не закрываются.
