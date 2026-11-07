# week12: complete Raydium swap and security lab

Base: `main`. Head: `week12-complete-security-lab`.

The published Raydium swap commit already implements confirmed Devnet swaps. This follow-up completes the corrected local Security Lab and its rejection regressions, removes the inherited insecure build mode, and verifies the Phantom adapter request boundary without substituting for a user's manual approval.

Validation: frontend build and TypeScript; 29 unit tests; 23 TrustPay localnet regressions; 12 Security Lab rejection cases plus authorized withdrawal; synthetic-provider test through the installed Phantom adapter. Both existing swap signatures were reread as finalized, with input/minimum output checked. No new swaps were sent. Evidence and manual Phantom instructions are in `docs/week12.md`.

Manual Phantom extension approval remains unverified. No public Security Lab deployment or vulnerable artifact is included. Merge requires the repository owner's confirmation.

History: `5fe787025d701a90c68275efdc275601b5295170` remains in main. Squashing this PR can produce one additional completion commit, but cannot combine the earlier published swap commit into that commit without rewriting main. Use the two successive Week 12 commits and the final completion commit link for the teacher's table.

Create PR: https://github.com/yerkesha-A/trustpay-solana/compare/main...week12-complete-security-lab?expand=1

PR creation was not performed in this session: the GitHub integration is not connected and the GitHub CLI is unavailable. The branch push is independent of that connection.
