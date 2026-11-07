import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
const require=createRequire(import.meta.url);require('ts-node').register({project:'tsconfig.json'});
const {Connection,PublicKey,Keypair,SystemProgram}=require('@solana/web3.js');
const {getAccount,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferCheckedInstruction}=require('@solana/spl-token');
const {WEEK13}=require('../shared/week13-config.ts');
const {ensureTestNetwork}=require('../shared/rpc.ts');
const {sendWeek13Transaction,week13Transaction}=require('../shared/transactions.ts');
const {Wallet}=require('@coral-xyz/anchor');
const owner=new PublicKey(process.argv[2]);
const c=new Connection('https://api.devnet.solana.com',{commitment:'confirmed',fetch:require('./devnet-fetch.cjs'),disableRetryOnRateLimit:true});
try{
 await ensureTestNetwork(c,'devnet');
 const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.anchor/week09-wallet.json','utf8'))));
 const tx=week13Transaction();const before=await c.getBalance(owner);
 if(await c.getBalance(payer.publicKey)<200000000)throw Error('Insufficient project test SOL');
 if(before<100000000)tx.add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:owner,lamports:100000000-before}));
 for(const text of [WEEK13.stableMint,WEEK13.assetMint]){
  const mint=new PublicKey(text),source=getAssociatedTokenAddressSync(mint,payer.publicKey),destination=getAssociatedTokenAddressSync(mint,owner);
  const existing=await c.getAccountInfo(destination),balance=existing?(await getAccount(c,destination)).amount:0n;
  if(balance<10000000n)tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,destination,owner,mint),createTransferCheckedInstruction(source,mint,destination,payer.publicKey,10000000n-balance,6));
 }
 if(tx.instructions.length===2){console.log('Already funded; no transaction sent');}
 else{
  const sig=await sendWeek13Transaction(c,new Wallet(payer),tx);
  const evidence={network:'devnet',owner:owner.toBase58(),signature:sig,purpose:'test funding only; not a Phantom payment or CLMM signature',targetSol:0.1,targetMockTokensEach:'10'};
  writeFileSync('docs/week13-phantom-funding.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
 }
}finally{c._rpcWebSocket.close();}
