import { expect } from "chai";
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { requestWalletSignature } from "../shared/wallet-signing";
// Generated memory-only test signers; no Phantom extension, network or user keys.
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
