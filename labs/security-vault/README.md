# Security Vault Lab — corrected version only

Educational local-validator program, separate from TrustPay escrow and Liquidity Vault. Never deploy this laboratory to a public network. The build/test scripts do not accept an external RPC or deploy command.

The inherited draft contained a `vulnerable` feature that selected a withdraw account context without `has_one = owner`. That feature and alternate context have been removed. The original draft was archived locally under ignored `.anchor/week12-original-lab/`; neither that draft nor its exploit harness is published or executed by this version.

Every build now requires the signing owner to match the stored depositor. A valid PDA alone does not authorize a caller. Mint, reserve PDA, token account owner/mint and SPL Token program constraints are mandatory. Withdrawals must be positive and covered by the reserve. The fixture intentionally supports one initialized vault per owner, one stored mint, and no third-party withdrawals; it is not a production savings product or a yield strategy.

Run from repository root:

```sh
npm run build:security
npm run test:security
```

The build is locked/offline and produces only the corrected SBF artifact under `.anchor/week12-lab/fixed/`. Tests start an isolated loopback validator, verify its identity and non-public genesis, generate new project-owned accounts in memory, and use local airdrops/test mints. They confirm one legitimate deposit/withdrawal and reject unauthorized/malformed withdrawals with unchanged token balances. No successful unauthorized withdrawal or public interaction is part of this suite. Ledgers/keys remain ignored under `.anchor/`.

Results: `docs/week12-security-evidence.json`; limitations and overall Week 12 status: `docs/week12.md`. This is regression testing and a scoped source review, not a complete independent audit.
