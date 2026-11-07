import { expect } from "chai";
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { requestWalletSignature } from "../shared/wallet-signing";
// In-memory test signers; no extension or RPC.
describe("Wallet signature request contract (not manual Phantom approval)", () => {
  const owner = Keypair.generate(), recipient = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const tx = () => new Transaction().add(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:recipient,lamports:1}));
  async function rejects(action:()=>Promise<unknown>, message:string) {
    let error:unknown;
    try {await action();} catch(e) {error=e;}
    expect(String(error)).include(message);
  }
  it("passes fee payer, blockhash and unchanged instructions to the adapter exactly once", async () => {
    const unsigned=tx(); const instruction=unsigned.instructions[0]; let calls=0;
    const signed=await requestWalletSignature({publicKey:owner.publicKey,signTransaction:async received => {
      calls++; expect(received).eq(unsigned);
      expect(received.feePayer?.equals(owner.publicKey)).eq(true);
      expect(received.recentBlockhash).eq(blockhash);
      expect(received.instructions[0]).eq(instruction);
      expect(received.signature).eq(null);
      received.sign(owner); return received;
    }},unsigned,blockhash);
    expect(calls).eq(1); expect(signed.verifySignatures()).eq(true);
  });
  it("propagates user rejection without creating a signature", async () => {
    const unsigned=tx();
    await rejects(()=>requestWalletSignature({publicKey:owner.publicKey,signTransaction:async()=>{throw Error('User rejected the request');}},unsigned,blockhash),'User rejected');
    expect(unsigned.signature).eq(null);
  });
  it("rejects unsigned and modified responses", async () => {
    await rejects(()=>requestWalletSignature({publicKey:owner.publicKey,signTransaction:async t=>t},tx(),blockhash),'действительную подпись');
    await rejects(()=>requestWalletSignature({publicKey:owner.publicKey,signTransaction:async t=>{
      t.instructions[0].data[0]^=1; t.sign(owner); return t;
    }},tx(),blockhash),'изменил');
  });
});

describe("Wallet serialization compatibility and mutation guards", () => {
  const { Message, TransactionInstruction, ComputeBudgetProgram } = require('@solana/web3.js');
  const { utils } = require('@coral-xyz/anchor');
  const owner = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();
  const readA = Keypair.generate().publicKey, readB = Keypair.generate().publicKey;
  const make = () => new Transaction().add(new TransactionInstruction({
    programId:SystemProgram.programId,
    keys:[{pubkey:owner.publicKey,isSigner:true,isWritable:true},{pubkey:readA,isSigner:false,isWritable:false},{pubkey:readB,isSigner:false,isWritable:false}],
    data:Buffer.from([1,2,3]),
  }));
  it("accepts a signed message with reordered readonly account table and identical instructions", async () => {
    let changed=false;
    const result=await requestWalletSignature({publicKey:owner.publicKey,signTransaction:async tx=>{
      const m=tx.compileMessage();
      const a=m.accountKeys.findIndex((k: import('@solana/web3.js').PublicKey)=>k.equals(readA));
      const b=m.accountKeys.findIndex((k: import('@solana/web3.js').PublicKey)=>k.equals(readB));
      const keys=[...m.accountKeys]; [keys[a],keys[b]]=[keys[b],keys[a]];
      const index=(i:number)=>i===a?b:i===b?a:i;
      const reordered=new Message({header:m.header,accountKeys:keys,recentBlockhash:m.recentBlockhash,instructions:m.instructions.map(ix=>({...ix,programIdIndex:index(ix.programIdIndex),accounts:ix.accounts.map(index)}))});
      changed=!reordered.serialize().equals(m.serialize());
      const response=Transaction.populate(reordered,[utils.bytes.bs58.encode(Buffer.alloc(64))]);
      response.partialSign(owner); return response;
    }},make(),blockhash);
    expect(changed).eq(true); expect(result.verifySignatures()).eq(true);
  });
  for (const kind of ['recipient','amount','instruction','privileges','blockhash','payer','priority fee']) {
    it('rejects modified '+kind+' even with a valid returned signature', async()=>{
      let error:unknown;
      try {await requestWalletSignature({publicKey:owner.publicKey,signTransaction:async tx=>{
        if(kind==='recipient')tx.instructions[0].keys[1].pubkey=Keypair.generate().publicKey;
        if(kind==='amount')tx.instructions[0].data[0]^=1;
        if(kind==='instruction')tx.add(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:readA,lamports:1}));
        if(kind==='privileges')tx.instructions[0].keys[1].isWritable=true;
        if(kind==='blockhash')tx.recentBlockhash=Keypair.generate().publicKey.toBase58();
        if(kind==='priority fee')tx.add(ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000}));
        if(kind==='payer'){const payer=Keypair.generate();tx.feePayer=payer.publicKey;tx.sign(payer,owner);} else tx.sign(owner);
        return tx;
      }},make(),blockhash);}catch(e){error=e;}
      expect(String(error)).include('изменил');
    });
  }
});

describe("Phantom automatic Compute Budget regression", () => {
  const { ComputeBudgetProgram, ComputeBudgetInstruction }=require('@solana/web3.js');
  const { swapComputeBudgetInstructions }=require('../shared/swap-budget');
  const owner=Keypair.generate(),recipient=Keypair.generate().publicKey;
  const blockhash=Keypair.generate().publicKey.toBase58();
  const base=()=>new Transaction().add(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:recipient,lamports:1}));
  const provider=async (tx:Transaction)=>{
    // Instruction bytes captured from Phantom.
    if(!tx.instructions.some(ix=>ix.programId.equals(ComputeBudgetProgram.programId))) {
      const {TransactionInstruction,PublicKey}=require('@solana/web3.js');
      const {utils}=require('@coral-xyz/anchor');
      const fixture=require('./fixtures/week12-phantom-added-compute.json');
      tx.instructions.unshift(...fixture.map((ix:{program:string;data:string})=>new TransactionInstruction({programId:new PublicKey(ix.program),keys:[],data:Buffer.from(utils.bytes.bs58.decode(ix.data))})));
    }
    tx.sign(owner);return tx;
  };
  it("blocks the reported 2 extra Compute Budget instructions when absent before approval",async()=>{
    let error:unknown;
    try{await requestWalletSignature({publicKey:owner.publicKey,signTransaction:provider},base(),blockhash);}catch(e){error=e;}
    expect(String(error)).include('accounts, instructions');
  });
  it("predeclares exact budget, preventing automatic insertion by the modeled provider",async()=>{
    const tx=new Transaction().add(...swapComputeBudgetInstructions(),...base().instructions);
    const returned=await requestWalletSignature({publicKey:owner.publicKey,signTransaction:provider},tx,blockhash);
    expect(returned.instructions.length).eq(3);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(returned.instructions[0]).units).eq(200000);
    expect(ComputeBudgetInstruction.decodeSetComputeUnitPrice(returned.instructions[1]).microLamports).eq(0n);
    expect(returned.verifySignatures()).eq(true);
  });
  for(const change of ['price','limit','duplicate'])it('rejects wallet changing preapproved budget: '+change,async()=>{
    const tx=new Transaction().add(...swapComputeBudgetInstructions(),...base().instructions);
    let error:unknown;
    try{await requestWalletSignature({publicKey:owner.publicKey,signTransaction:async received=>{
      if(change==='price')received.instructions[1]=ComputeBudgetProgram.setComputeUnitPrice({microLamports:1});
      if(change==='limit')received.instructions[0]=ComputeBudgetProgram.setComputeUnitLimit({units:200001});
      if(change==='duplicate')received.add(ComputeBudgetProgram.setComputeUnitPrice({microLamports:1}));
      received.sign(owner);return received;
    }},tx,blockhash);}catch(e){error=e;}
    expect(String(error)).include('изменил');
  });
});

describe("Compute Budget diagnostic decoding",()=>{
  const {ComputeBudgetProgram}=require('@solana/web3.js');
  const {decodeComputeBudget}=require('../shared/swap-budget');
  it("decodes u32 limit and u64 micro-lamport price and rounds the fee upward",()=>{
    const payer=Keypair.generate().publicKey;
    const tx=new Transaction({feePayer:payer,recentBlockhash:payer.toBase58()}).add(
      ComputeBudgetProgram.setComputeUnitLimit({units:200000}),
      ComputeBudgetProgram.setComputeUnitPrice({microLamports:375001n}),
    );
    const result=decodeComputeBudget(tx.compileMessage());
    expect(result.entries.map((x:{value:string})=>x.value)).deep.eq(['200000','375001']);
    expect(result.priorityFeeLamports).eq('75001');
  });
});


it("decodes the exact Compute Budget bytes supplied from Chrome",()=>{
  const {Message}=require('@solana/web3.js');
  const {utils}=require('@coral-xyz/anchor');
  const {decodeComputeBudget}=require('../shared/swap-budget');
  const fixture=require('./fixtures/week12-phantom-added-compute.json');
  const message=new Message({header:{numRequiredSignatures:1,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:1},accountKeys:[Keypair.generate().publicKey,'ComputeBudget111111111111111111111111111111'],recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:fixture.map((ix:{data:string})=>({programIdIndex:1,accounts:[],data:ix.data}))});
  const result=decodeComputeBudget(message);
  expect(result.entries.map((x:{kind:string;value:string})=>[x.kind,x.value])).deep.eq([['SetComputeUnitPrice','375000'],['SetComputeUnitLimit','200000']]);
  expect(result.priorityFeeLamports).eq('75000');
});
