import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);require('ts-node').register({project:'tsconfig.json'});
const {Connection,Transaction}=require('@solana/web3.js');
const {ensureTestNetwork}=require('../shared/rpc.ts');
const {CLMM_DEVNET}=require('../shared/market.ts');
const c=new Connection('https://api.devnet.solana.com',{commitment:'finalized',fetch:require('./devnet-fetch.cjs'),disableRetryOnRateLimit:true});
await ensureTestNetwork(c,'devnet');
const evidence={network:'devnet',checkedAt:new Date().toISOString(),manualPhantom:'not verified for week13',transactionsSent:0,transactions:[]};
for(const file of ['docs/week13-clmm-evidence.json','docs/week13-payments-evidence.json']){
 const data=JSON.parse(readFileSync(file,'utf8'));assert.equal(data.status,'passed');
 for(const op of data.operations.filter(x=>x.status==='confirmed')){
  const status=(await c.getSignatureStatuses([op.signature],{searchTransactionHistory:true})).value[0];assert.equal(status?.confirmationStatus,'finalized');assert.equal(status.err,null);
  const tx=await c.getTransaction(op.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});assert(tx?.meta&&!tx.meta.err);assert('accountKeys' in tx.transaction.message);
  const m=tx.transaction.message;assert(Transaction.populate(m,tx.transaction.signatures).verifySignatures());
  const programs=m.compiledInstructions.map(ix=>m.accountKeys[ix.programIdIndex].toBase58());
  if(file.includes('clmm')){assert(programs.includes(CLMM_DEVNET.toBase58()));assert(!m.accountKeys.some(k=>k.toBase58()==='ojfaRp5p9b8ZyK5VH5VQQQYxTWy8hi3QTorcTHtN19A'));}
  const changes=[];
  for(const post of tx.meta.postTokenBalances||[]){const pre=tx.meta.preTokenBalances?.find(x=>x.accountIndex===post.accountIndex);changes.push({owner:post.owner,mint:post.mint,change:(BigInt(post.uiTokenAmount.amount)-BigInt(pre?.uiTokenAmount.amount||'0')).toString()});}
  evidence.transactions.push({operation:op.operation,signature:op.signature,status:'finalized',slot:tx.slot,feeLamports:tx.meta.fee,programs,tokenChanges:changes});
 }
}
writeFileSync('docs/week13-chain-verification.json',JSON.stringify(evidence,null,2)+'\n');
console.log('PASS:',evidence.transactions.length,'finalized Devnet transactions, signatures/metadata verified; no transactions sent');
