import {createRequire} from 'node:module';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const require=createRequire(import.meta.url);
require('ts-node').register({project:'tsconfig.json'});
const {Connection,Keypair,PublicKey,Transaction,sendAndConfirmTransaction}=require('@solana/web3.js');
const {createMint,getOrCreateAssociatedTokenAccount,mintTo,TOKEN_PROGRAM_ID}=require('@solana/spl-token');
const {ClmmInstrument,PoolInfoLayout,getPdaPoolId,getPdaPoolVaultId,getPdaObservationAccount,getPdaExBitmapAccount}=require('@raydium-io/raydium-sdk-v2');
const BN=require('bn.js');
const {CLMM_DEVNET,loadClmmMarket,MARKET_POOLS}=require('../shared/market.ts');
const {ensureTestNetwork}=require('../shared/rpc.ts');
const c=new Connection('https://api.devnet.solana.com',{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:require('./devnet-fetch.cjs')});
const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.anchor/week09-wallet.json','utf8'))));
mkdirSync('.anchor',{recursive:true});
const path='.anchor/week13-setup.json';
const state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{network:'devnet',owner:payer.publicKey.toBase58(),signatures:[]};
const save=()=>writeFileSync(path,JSON.stringify(state,null,2)+'\n');
try{
 await ensureTestNetwork(c,'devnet');
 const program=await c.getAccountInfo(CLMM_DEVNET);if(!program?.executable)throw Error('CLMM Devnet program unavailable');
 const sol=await c.getBalance(payer.publicKey);console.log('Project Devnet SOL:',sol/1e9);
 if(sol<400000000&&!state.pool)throw Error('Need at least 0.4 test SOL for CLMM setup');
 if(!state.stableMint){state.stableMint=(await createMint(c,payer,payer.publicKey,null,6)).toBase58();save();}
 if(!state.assetMint){state.assetMint=(await createMint(c,payer,payer.publicKey,null,6)).toBase58();save();}
 for(const mintText of [state.stableMint,state.assetMint]){
  if(state['funded:'+mintText])continue;
  const mint=new PublicKey(mintText),ata=await getOrCreateAssociatedTokenAccount(c,payer,mint,payer.publicKey);
  const sig=await mintTo(c,payer,mint,ata.address,payer,10000_000000n);
  state.signatures.push({operation:'mint test tokens',signature:sig,mint:mintText});state['funded:'+mintText]=true;save();
 }
 const [a,b]=[state.stableMint,state.assetMint].map(x=>new PublicKey(x)).sort((x,y)=>Buffer.compare(x.toBuffer(),y.toBuffer()));
 if(!state.config){
  const reference=await loadClmmMarket(c,new PublicKey(MARKET_POOLS[1].address));state.config=reference.state.configId.toBase58();save();
 }
 const config=new PublicKey(state.config),pool=getPdaPoolId(CLMM_DEVNET,config,a,b).publicKey;
 if(!await c.getAccountInfo(pool)){
  const ix=ClmmInstrument.createPoolInstruction(CLMM_DEVNET,pool,payer.publicKey,config,getPdaObservationAccount(CLMM_DEVNET,pool).publicKey,a,getPdaPoolVaultId(CLMM_DEVNET,pool,a).publicKey,TOKEN_PROGRAM_ID,b,getPdaPoolVaultId(CLMM_DEVNET,pool,b).publicKey,TOKEN_PROGRAM_ID,getPdaExBitmapAccount(CLMM_DEVNET,pool).publicKey,new BN(2).pow(new BN(64)),undefined);
  const sig=await sendAndConfirmTransaction(c,new Transaction().add(ix),[payer],{commitment:'confirmed',skipPreflight:false});
  state.signatures.push({operation:'create CLMM pool',signature:sig});
 }
 state.pool=pool.toBase58();state.mintA=a.toBase58();state.mintB=b.toBase58();save();
 const market=await loadClmmMarket(c,pool);state.tickSpacing=market.state.tickSpacing;state.price=market.price;save();
 writeFileSync('shared/week13-config.ts','export const WEEK13 = '+JSON.stringify({network:'devnet',stableMint:state.stableMint,assetMint:state.assetMint,pool:state.pool,mintA:state.mintA,mintB:state.mintB,decimals:6,symbol:'Mock USD (Devnet)'},null,2)+' as const;\n');
 writeFileSync('docs/week13-setup-evidence.json',JSON.stringify(state,null,2)+'\n');
 console.log(JSON.stringify({stableMint:state.stableMint,pool:state.pool,tickSpacing:state.tickSpacing,price:state.price},null,2));
}catch(e){console.error(String(e));process.exitCode=1;}finally{c._rpcWebSocket.close();}
