// Decode a saved signing diagnostic offline.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require=createRequire(import.meta.url);
require('ts-node').register({project:'tsconfig.json'});
const {Message,Transaction,TransactionInstruction,PublicKey}=require('@solana/web3.js');
const {utils}=require('@coral-xyz/anchor');
const {decodeComputeBudget}=require('../shared/swap-budget.ts');
const diagnostic=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(diagnostic.afterMessageBase64){
 for(const name of ['before','after'])console.log(name,JSON.stringify(decodeComputeBudget(Message.from(Buffer.from(diagnostic[name+'MessageBase64'],'base64'))),null,2));
}else{
 const instructions=Array.isArray(diagnostic)?diagnostic:diagnostic.after.instructions;
 const tx=new Transaction({feePayer:PublicKey.default,recentBlockhash:PublicKey.default.toBase58()});
 for(const ix of instructions)tx.add(new TransactionInstruction({programId:new PublicKey(ix.program),keys:ix.accounts.map(address=>({pubkey:new PublicKey(address),isSigner:false,isWritable:false})),data:Buffer.from(utils.bytes.bs58.decode(ix.data))}));
 console.log(JSON.stringify(decodeComputeBudget(tx.compileMessage()),null,2));
}
