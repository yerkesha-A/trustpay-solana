// Opt-in Devnet test using the project wallet's free tokens.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
require('ts-node').register({ project:'tsconfig.json' });
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { MARKET_POOLS, loadAmmMarket } = require('../shared/market.ts');
const { quoteSwap, buildSwapTransaction, swapBalances, validateSwapApproval } = require('../shared/swap.ts');
const { utils } = require('@coral-xyz/anchor');
if (process.env.TRUSTPAY_SWAP_DEVNET !== '1') throw Error('Set TRUSTPAY_SWAP_DEVNET=1 to send test swaps.');
const c = new Connection('https://api.devnet.solana.com', { commitment:'confirmed', disableRetryOnRateLimit:true, fetch:require('./devnet-fetch.cjs') });
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.anchor/week09-wallet.json','utf8'))));
const evidence = { network:'devnet', checkedAt:new Date().toISOString(), owner:payer.publicKey.toBase58(), pool:MARKET_POOLS[0].address, transactions:[] };
const save = () => writeFileSync('docs/week12-swap-evidence.json', JSON.stringify(evidence,null,2)+'\n');
try {
  for (const reverse of [false,true]) {
    const market = await loadAmmMarket(c,new PublicKey(MARKET_POOLS[0].address));
    const before = await swapBalances(c,market,payer.publicKey);
    const q = quoteSwap(market,payer.publicKey,reverse ? market.pool.state.mintB : market.pool.state.mintA,1000000n,50);
    const tx = await buildSwapTransaction(c,payer.publicKey,q);
    const block = await c.getLatestBlockhash('confirmed');
    tx.feePayer=payer.publicKey; tx.recentBlockhash=block.blockhash;
    validateSwapApproval(q,payer.publicKey); tx.sign(payer);
    const record = { direction:reverse?'B → A':'A → B', signature:utils.bytes.bs58.encode(tx.signature), status:'signed; confirmation pending', input:q.input.toString(), minimum:q.minimum.toString(), before:before.map(String) };
    evidence.transactions.push(record); save();
    const signature = await c.sendRawTransaction(tx.serialize(), { skipPreflight:false, maxRetries:2 });
    assert.equal(signature,record.signature);
    const result = await c.confirmTransaction({signature,...block},'confirmed');
    if (result.value.err) throw Error(JSON.stringify(result.value.err));
    record.status='confirmed'; save();
    const after = await swapBalances(c,market,payer.publicKey);
    record.after=after.map(String);
    assert.equal(before[reverse?1:0]-after[reverse?1:0],q.input);
    assert(after[reverse?0:1]-before[reverse?0:1] >= q.minimum);
    record.balanceChecks='exact input and minimum output passed'; save();
    console.log(record.direction, record.status, record.signature);
  }
} catch (e) { evidence.error=String(e); process.exitCode=1; }
finally { save(); }
