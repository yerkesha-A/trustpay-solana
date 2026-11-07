// Read-only: recheck already published signatures; never resend swaps.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Connection } = require('@solana/web3.js');
const c = new Connection('https://api.devnet.solana.com', { commitment:'finalized', fetch:require('./devnet-fetch.cjs'), disableRetryOnRateLimit:true });
assert.equal(await c.getGenesisHash(), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
const previous = JSON.parse(readFileSync('docs/week12-swap-evidence.json','utf8'));
const evidence = { checkedAt:new Date().toISOString(), network:'devnet', transactionsSent:0, transactions:[] };
for (const row of previous.transactions) {
  const status = (await c.getSignatureStatuses([row.signature], { searchTransactionHistory:true })).value[0];
  assert(status && !status.err && status.confirmationStatus === 'finalized');
  const tx = await c.getTransaction(row.signature, { commitment:'finalized', maxSupportedTransactionVersion:0 });
  assert(tx?.meta && !tx.meta.err);
  const balances = tx.meta.postTokenBalances.filter(b => b.owner === previous.owner).map(after => {
    const before = tx.meta.preTokenBalances.find(b => b.accountIndex === after.accountIndex && b.mint === after.mint);
    return {mint:after.mint, change:(BigInt(after.uiTokenAmount.amount)-BigInt(before?.uiTokenAmount.amount || '0')).toString()};
  });
  assert(balances.some(b => b.change === '-'+row.input));
  assert(balances.some(b => BigInt(b.change) >= BigInt(row.minimum)));
  evidence.transactions.push({ signature:row.signature, confirmationStatus:status.confirmationStatus, slot:tx.slot, balances });
}
writeFileSync('docs/week12-swap-reverification.json', JSON.stringify(evidence,null,2)+'\n');
console.log('PASS: two existing swaps finalized, exact input and minimum output rechecked; no transactions sent');
