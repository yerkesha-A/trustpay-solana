# week12: complete Raydium swap and security lab

Final scope: corrected local Security Lab, strict Phantom signing validation and explicit Compute Budget, finalized manual Devnet swap, consolidated evidence/report.

Manual Phantom swap: `5VuPDpWkRiYfLcq5A22WfrAvFBLD2xjH5Yjjrb35KQZRmTzjpymNE8akhnAwCdDBT5b231otvq5rBvsdfA8Gb4Cw`. On-chain signature, 1 A input, 0.996513 B output >= 0.991530 minimum, four approved instructions, zero priority fee and 5000-lamport network fee verified.

Validation: 44 unit tests, TypeScript/build, 23 TrustPay localnet regressions, safe Security Lab rejection suite, browser smoke test and installed Phantom adapter contract test. Evidence: `docs/week12.md`.

The owner authorized an ordinary merge into main after successful checks. Preserve published commits; no squash of existing main and no force push. No public deployment of the lab and no exploit demonstration.
