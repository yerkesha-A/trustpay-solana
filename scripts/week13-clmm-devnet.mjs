import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
require('ts-node').register({project:'tsconfig.json'});
const {Connection,Keypair,PublicKey}=require('@solana/web3.js');
const {Wallet}=require('@coral-xyz/anchor');
const {getAccount,getAssociatedTokenAddressSync}=require('@solana/spl-token');
const {positionMarket,quotePositionAdd,quotePositionRemove,buildPositionTransaction,loadPosition,positionPrices,quotePositionIncrease}=require('../shared/positions.ts');
const {sendWeek13Transaction}=require('../shared/transactions.ts');
const {WEEK13}=require('../shared/week13-config.ts');
if(process.env.TRUSTPAY_WEEK13_DEVNET!=='1')throw Error('Set TRUSTPAY_WEEK13_DEVNET=1 for test transactions');
const c=new Connection('https://api.devnet.solana.com',{commitment:'confirmed',fetch:require('./devnet-fetch.cjs'),disableRetryOnRateLimit:true});
const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.anchor/week09-wallet.json','utf8')))),wallet=new Wallet(payer);
const evidence={network:'devnet',checkedAt:new Date().toISOString(),owner:payer.publicKey.toBase58(),pool:WEEK13.pool,operations:[]};
const save=()=>writeFileSync('docs/week13-clmm-evidence.json',JSON.stringify(evidence,null,2)+'\n');
let nftMint;
try{
 let m=await positionMarket(c,new PublicKey(WEEK13.pool));
 const q=quotePositionAdd(m,payer.publicKey,'0.9','1.1',10_000000n,10_000000n,50);
 const open=await buildPositionTransaction(c,payer.publicKey,q);nftMint=open.nftMint;
 evidence.nftMint=nftMint.toBase58();save();
 const run=async(name,built)=>{
  const record={operation:name,status:'pending'};evidence.operations.push(record);save();
  const sig=await sendWeek13Transaction(c,wallet,built.transaction,built.signers,s=>{record.signature=s;save();});
  record.status='confirmed';record.signature=sig;save();console.log(name,sig);return sig;
 };
 await run('open',open);
 let p=await loadPosition(c,payer.publicKey,nftMint);assert(BigInt(p.state.liquidity.toString())>0n);evidence.initialLiquidity=p.state.liquidity.toString();save();
 // Confirmed-only state from each operation is reloaded before the next quote.
 m=await positionMarket(c,m.address);let prices=positionPrices(m,p);
 const add=quotePositionIncrease(m,p,2_000000n,2_000000n,50);
 // Tick-to-price round trips are checked by the builder against the position.
 await run('increase',await buildPositionTransaction(c,payer.publicKey,add));
 p=await loadPosition(c,payer.publicKey,nftMint);assert(BigInt(p.state.liquidity.toString())>BigInt(evidence.initialLiquidity));
 m=await positionMarket(c,m.address);
 await run('collect fees',await buildPositionTransaction(c,payer.publicKey,quotePositionRemove(m,p,0n,50)));
 p=await loadPosition(c,payer.publicKey,nftMint);m=await positionMarket(c,m.address);
 const before=BigInt(p.state.liquidity.toString());
 await run('decrease half',await buildPositionTransaction(c,payer.publicKey,quotePositionRemove(m,p,before/2n,50)));
 p=await loadPosition(c,payer.publicKey,nftMint);assert(BigInt(p.state.liquidity.toString())<before);
 m=await positionMarket(c,m.address);
 await run('decrease all and close',await buildPositionTransaction(c,payer.publicKey,quotePositionRemove(m,p,BigInt(p.state.liquidity.toString()),50),true));
 assert.equal(await c.getAccountInfo(p.address),null);
 evidence.closed=true;evidence.status='passed';save();
}catch(e){evidence.status='failed';evidence.error=String(e);save();console.error(e);process.exitCode=1;}
finally{c._rpcWebSocket.close();}
