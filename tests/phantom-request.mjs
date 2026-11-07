// Real installed Phantom adapter + synthetic provider. No extension approval/signature.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
require('ts-node').register({project:'tsconfig.json'});
const { PhantomWalletAdapter }=require('@solana/wallet-adapter-phantom');
const { Keypair, Transaction }=require('@solana/web3.js');
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID }=require('@solana/spl-token');
const { makeSwapCpmmBaseInInstruction }=require('@raydium-io/raydium-sdk-v2');
const BN=require('bn.js');
const { RAYDIUM_DEVNET }=require('../shared/defi.ts');
const { requestWalletSignature }=require('../shared/wallet-signing.ts');
const { swapComputeBudgetInstructions }=require('../shared/swap-budget.ts');
const { ComputeBudgetInstruction }=require('@solana/web3.js');
const publicKey=Keypair.generate().publicKey;
const mintA=Keypair.generate().publicKey, mintB=Keypair.generate().publicKey;
const source=getAssociatedTokenAddressSync(mintA,publicKey), destination=getAssociatedTokenAddressSync(mintB,publicKey);
const blockhash=Keypair.generate().publicKey.toBase58();
const arbitrary=()=>Keypair.generate().publicKey;
const instruction=makeSwapCpmmBaseInInstruction(RAYDIUM_DEVNET,publicKey,arbitrary(),arbitrary(),arbitrary(),source,destination,arbitrary(),arbitrary(),TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,mintA,mintB,arbitrary(),new BN(1000000),new BN(990000));
const transaction=new Transaction().add(...swapComputeBudgetInstructions(),instruction);
let requests=0;
const provider={isPhantom:true,isConnected:true,publicKey,on(){},off(){},async disconnect(){},async signTransaction(received){
  requests++;
  assert.equal(received,transaction);
  assert(received.feePayer.equals(publicKey)); assert.equal(received.recentBlockhash,blockhash);
  assert.equal(received.signature,null);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(received.instructions[0]).units,200000);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(received.instructions[1]).microLamports,0n);
  const ix=received.instructions[2]; assert(ix.programId.equals(RAYDIUM_DEVNET));
  assert(ix.keys[0].pubkey.equals(publicKey) && ix.keys[0].isSigner);
  assert(ix.keys[4].pubkey.equals(source)); assert(ix.keys[5].pubkey.equals(destination));
  assert.equal(ix.data.readBigUInt64LE(8),1000000n); assert.equal(ix.data.readBigUInt64LE(16),990000n);
  throw Object.assign(Error('User rejected the request'),{code:4001});
}};
const previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window'), previousDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
let adapter;
try {
  Object.defineProperty(globalThis,'window',{value:{phantom:{solana:provider}},configurable:true});
  Object.defineProperty(globalThis,'document',{value:{readyState:'complete'},configurable:true});
  adapter=new PhantomWalletAdapter(); adapter.on('error',()=>{}); await adapter.connect();
  assert(adapter.publicKey.equals(publicKey));
  await assert.rejects(()=>requestWalletSignature({publicKey:adapter.publicKey,signTransaction:tx=>adapter.signTransaction(tx)},transaction,blockhash),/User rejected/);
  assert.equal(requests,1); assert.equal(transaction.signature,null);
  writeFileSync('docs/week12-phantom-request-evidence.json',JSON.stringify({checkedAt:new Date().toISOString(),status:'adapter request and rejection passed',provider:'synthetic, no real extension',requests,raydiumProgram:RAYDIUM_DEVNET.toBase58(),feePayerChecked:true,blockhashChecked:true,inputAndMinimumChecked:true,walletATAsChecked:true,manualPhantomApproval:'not verified',transactionsSent:0},null,2)+'\n');
  console.log('PASS: installed Phantom adapter receives one unsigned Raydium request with expected payer, ATAs, blockhash, input/minimum; rejection propagated. Manual Phantom approval NOT verified.');
} finally {
  if(adapter) await adapter.disconnect();
  if(previousWindow) Object.defineProperty(globalThis,'window',previousWindow); else delete globalThis.window;
  if(previousDocument) Object.defineProperty(globalThis,'document',previousDocument); else delete globalThis.document;
}
