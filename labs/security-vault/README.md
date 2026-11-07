# Security Vault Lab

Локальный SPL-vault с депозитом и выводом. Только localnet; не развёртывать в публичных сетях.

Вывод проверяет `Signer`, `has_one=owner`, mint, PDA reserve и владельца token account. Сумма должна быть положительной и не превышать reserve. Вариант без проверки владельца удалён.

Один vault на владельца и один mint. Повторный депозит и вывод стороннему получателю не поддерживаются. Независимый аудит не проводился.

```sh
npm run build:security
npm run test:security
```

Сборка: offline/locked, артефакт — `.anchor/week12-lab/fixed/`. Тесты запускают отдельный loopback validator и сверяют его identity. Аккаунты и токены создаются локально; ключи и ledger не добавляются в Git.

[Результаты](../../docs/week12-security-evidence.json) · [Неделя 12](../../docs/week12.md).
