import BN from "bn.js";
import { PublicKey, Connection, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { getPdaPoolAuthority, getCpmmPdaPoolId, getPdaVault, getPdaObservationId, makeSwapCpmmBaseInInstruction } from "@raydium-io/raydium-sdk-v2";
import { RAYDIUM_DEVNET } from "./defi";
import { loadAmmMarket, ammQuote, type AmmMarket } from "./market";
import { rpcRetry } from "./rpc";
export type SwapQuote={market:AmmMarket;owner:PublicKey;inputMint:PublicKey;outputMint:PublicKey;input:bigint;output:bigint;minimum:bigint;fee:bigint;priceImpactPercent:string;executionPrice:string;bps:number;aToB:boolean;createdAt:number};
export function quoteSwap(market:AmmMarket,owner:PublicKey,inputMint:PublicKey,input:bigint,bps:number):SwapQuote {
  const s=market.pool.state;
  if(!inputMint.equals(s.mintA)&&!inputMint.equals(s.mintB))throw Error("From mint не принадлежит паре пула.");
  const aToB=inputMint.equals(s.mintA),q=ammQuote(market,input,bps,aToB);
  return {market,owner,inputMint,outputMint:aToB?s.mintB:s.mintA,...q,bps,aToB,createdAt:Date.now()};
}
export function validateSwapApproval(q:SwapQuote,owner:PublicKey,now=Date.now()) {
  if(!q.owner.equals(owner))throw Error("Котировка принадлежит другому кошельку.");
  if(!Number.isFinite(q.createdAt)||!Number.isFinite(q.market.readAt)||now<q.market.readAt||now-q.createdAt>30000||now<q.createdAt||now-q.market.readAt>30000)throw Error("Котировка устарела. Получите новую котировку.");
  const expected=quoteSwap(q.market,owner,q.inputMint,q.input,q.bps);
  if(!q.outputMint.equals(expected.outputMint)||q.aToB!==expected.aToB||q.output!==expected.output||q.minimum!==expected.minimum||q.minimum<=0n)throw Error("Котировка изменена. Получите новую котировку.");
}
export async function swapBalances(c:Connection,m:AmmMarket,owner:PublicKey) {
  const mints=[m.pool.state.mintA,m.pool.state.mintB];
  const atas=mints.map(mint=>getAssociatedTokenAddressSync(mint,owner));
  const infos=await rpcRetry(()=>c.getMultipleAccountsInfo(atas));
  return infos.map((info,i)=>{
    if(!info)return 0n;
    const a=unpackAccount(atas[i],info);
    if(!a.owner.equals(owner)||!a.mint.equals(mints[i]))throw Error("Некорректный ATA кошелька.");
    return a.amount;
  });
}
export async function buildSwapTransaction(c:Connection,owner:PublicKey,q:SwapQuote) {
  validateSwapApproval(q,owner);
  const fresh=await loadAmmMarket(c,q.market.pool.address),s=fresh.pool.state;
  if(!s.mintA.equals(q.market.pool.state.mintA)||!s.mintB.equals(q.market.pool.state.mintB))throw Error("Пара пула изменилась.");
  const canonical=getCpmmPdaPoolId(RAYDIUM_DEVNET,s.configId,s.mintA,s.mintB).publicKey;
  if(!canonical.equals(fresh.pool.address)||!s.vaultA.equals(getPdaVault(RAYDIUM_DEVNET,canonical,s.mintA).publicKey)||!s.vaultB.equals(getPdaVault(RAYDIUM_DEVNET,canonical,s.mintB).publicKey)||!s.observationId.equals(getPdaObservationId(RAYDIUM_DEVNET,canonical).publicKey))throw Error("Некорректные PDA пула Raydium.");
  const next=ammQuote(fresh,q.input,q.bps,q.aToB);
  if(next.output<q.minimum)throw Error("Цена вышла за одобренный slippage. Получите новую котировку.");
  if(BigInt(s.openTime.toString())>BigInt(Math.floor(Date.now()/1000)))throw Error("Обмены пула ещё не открыты.");
  const balances=await swapBalances(c,fresh,owner);
  if(balances[q.aToB?0:1]<q.input)throw Error("Недостаточно свободных токенов в ATA кошелька.");
  validateSwapApproval(q,owner);
  const input=getAssociatedTokenAddressSync(q.inputMint,owner),output=getAssociatedTokenAddressSync(q.outputMint,owner);
  // Only the signing wallet's ATAs are accepted; no escrow/Vault source parameter exists.
  return new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner,output,owner,q.outputMint),makeSwapCpmmBaseInInstruction(RAYDIUM_DEVNET,owner,getPdaPoolAuthority(RAYDIUM_DEVNET).publicKey,s.configId,canonical,input,output,q.aToB?s.vaultA:s.vaultB,q.aToB?s.vaultB:s.vaultA,TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,q.inputMint,q.outputMint,s.observationId,new BN(q.input.toString()),new BN(q.minimum.toString())));
}
