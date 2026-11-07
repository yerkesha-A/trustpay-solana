// Read the Devnet pool and calculate quotes.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
require('ts-node').register({ project: 'tsconfig.json' });
const { Connection, PublicKey } = require('@solana/web3.js');
const { loadAmmMarket, MARKET_POOLS } = require('../shared/market.ts');
const { quoteSwap } = require('../shared/swap.ts');
const evidence = { network: 'devnet', checkedAt: new Date().toISOString(), transactionsSent: 0, confirmedSwap: null };
try {
  const c = new Connection('https://api.devnet.solana.com', { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: require('./devnet-fetch.cjs') });
  const market = await loadAmmMarket(c, new PublicKey(MARKET_POOLS[0].address));
  evidence.pool = market.pool.address.toBase58();
  evidence.slot = market.slot;
  evidence.reserves = [market.pool.reserveA.toString(), market.pool.reserveB.toString()];
  evidence.mints = [market.pool.state.mintA.toBase58(), market.pool.state.mintB.toBase58()];
  evidence.feeRate = market.feeRate.toString();
  evidence.quotes = [market.pool.state.mintA, market.pool.state.mintB].map(mint => {
    const q = quoteSwap(market, PublicKey.default, mint, 1000000n, 50);
    return { input:q.input.toString(), output:q.output.toString(), minimum:q.minimum.toString(), bps:q.bps };
  });
  evidence.status = 'live pool and quotes verified; signed swap not performed';
} catch (e) { evidence.status = 'RPC verification failed'; evidence.error = String(e); process.exitCode = 1; }
writeFileSync('docs/week12-rpc-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
