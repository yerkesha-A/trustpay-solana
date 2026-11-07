// Corrected artifact only. Ephemeral project-owned fixtures and loopback RPC.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount } = require('@solana/spl-token');
const LAB = new PublicKey('BJgBQA7UGzQQuPWVn16Qw931M5LfLaBh3Taid77BLpTw');
const artifact = '.anchor/week12-lab/fixed/security_vault_lab.so';
const c = new Connection('http://127.0.0.1:9899', 'confirmed');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const disc = name => createHash('sha256').update('global:'+name).digest().subarray(0,8);
mkdirSync('.anchor/week12-lab', {recursive:true});
const ledger = mkdtempSync('.anchor/week12-lab/safe-ledger-');
const log = openSync(`${ledger}/validator.log`, 'w');
const evidence = {network:'isolated localnet only', verifiedAt:new Date().toISOString(), program:LAB.toBase58(), artifactSha256:createHash('sha256').update(readFileSync(artifact)).digest('hex'), cases:[]};
const child = spawn('solana-test-validator', ['--bind-address','127.0.0.1','--rpc-port','9899','--faucet-port','9901','--dynamic-port-range','12000-12100','--gossip-port','12101','--ledger',ledger,'--bpf-program',LAB.toBase58(),artifact,'--quiet'], {stdio:['ignore',log,log]});
let spawnError;
child.on('error', e => {spawnError=e;});
try {
  let ready=false;
  for (let i=0;i<120;i++) {
    if (spawnError || child.exitCode !== null) throw Error(spawnError?.message || 'Local validator stopped; inspect '+ledger+'/validator.log');
    // Do not use another process already listening on this port.
    if (readFileSync(`${ledger}/validator.log`, 'utf8').includes('Address already in use')) throw Error('Validator port collision');
    try { await c.getSlot(); ready=true; break; } catch {}
    await pause(250);
  }
  assert(ready, 'Local validator readiness timeout');
  // Prove that the RPC belongs to our child, not an existing public/proxy service.
  const identity = await c._rpcRequest("getIdentity", []);
  assert(!identity.error);
  const localIdentity = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${ledger}/validator-keypair.json`, 'utf8')))).publicKey.toBase58();
  assert.equal(identity.result.identity, localIdentity);
  const genesis = await c.getGenesisHash();
  assert(!['EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG','5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'].includes(genesis));
  evidence.genesis=genesis;
  const owner=Keypair.generate(), other=Keypair.generate();
  const funding=await c.requestAirdrop(owner.publicKey,5e9);
  await c.confirmTransaction({...await c.getLatestBlockhash(),signature:funding}, 'confirmed');
  const mint=await createMint(c,owner,owner.publicKey,null,6);
  const wrongMint=await createMint(c,owner,owner.publicKey,null,6);
  const ata=async (m,o) => (await getOrCreateAssociatedTokenAccount(c,owner,m,o)).address;
  const source=await ata(mint,owner.publicKey), foreign=await ata(mint,other.publicKey), wrongTokens=await ata(wrongMint,owner.publicKey);
  await mintTo(c,owner,mint,source,owner,100_000_000);
  const [vault]=PublicKey.findProgramAddressSync([Buffer.from('lab'),owner.publicKey.toBuffer()],LAB);
  const [reserve]=PublicKey.findProgramAddressSync([Buffer.from('reserve'),vault.toBuffer()],LAB);
  const key=(pubkey,isSigner=false,isWritable=false) => ({pubkey,isSigner,isWritable});
  const ix=(name,amount,keys) => {const bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(amount);return new TransactionInstruction({programId:LAB,keys,data:Buffer.concat([disc(name),bytes])});};
  const send=(instruction, signers=[owner]) => sendAndConfirmTransaction(c,new Transaction().add(instruction),signers,{commitment:'confirmed',skipPreflight:false});
  const deposit=ix('deposit',100_000_000n,[key(owner.publicKey,true,true),key(mint),key(vault,false,true),key(reserve,false,true),key(source,false,true),key(TOKEN_PROGRAM_ID),key(SystemProgram.programId)]);
  evidence.depositSignature=await send(deposit);
  const withdraw=(amount=1n, options={}) => ix('withdraw',amount,[key(options.actor || owner.publicKey,options.signer !== false),key(options.vault || vault),key(options.mint || mint),key(options.reserve || reserve,false,true),key(options.destination || source,false,true),key(options.tokenProgram || TOKEN_PROGRAM_ID)]);
  const balances=async () => Promise.all([reserve,source,foreign].map(async address => (await getAccount(c,address)).amount.toString()));
  const reject=async (name,instruction,expected,signers=[owner]) => {
    const before=await balances(); let failure;
    try {await send(instruction,signers);} catch(e) {failure=String(e)+'\n'+(e.logs || []).join('\n');}
    assert(failure?.includes(expected),name+': '+(failure || 'unexpected success'));
    assert.deepEqual(await balances(),before,name+': balances changed');
    evidence.cases.push({name,result:'rejected',constraint:expected,balancesUnchanged:true});
    console.log('PASS:',name);
  };
  await reject('foreign signer',withdraw(1n,{actor:other.publicKey,destination:foreign}),'ConstraintHasOne',[owner,other]);
  await reject('missing owner signature',withdraw(1n,{actor:other.publicKey,signer:false,destination:foreign}),'AccountNotSigner');
  await reject('redirected destination',withdraw(1n,{destination:foreign}),'ConstraintTokenOwner');
  await reject('wrong destination mint',withdraw(1n,{destination:wrongTokens}),'ConstraintTokenMint');
  await reject('substituted mint',withdraw(1n,{mint:wrongMint}),'ConstraintHasOne');
  await reject('substituted vault PDA',withdraw(1n,{vault:source}),'AccountOwnedByWrongProgram');
  await reject('substituted reserve PDA',withdraw(1n,{reserve:source}),'ConstraintSeeds');
  await reject('wrong account owner',withdraw(1n,{mint:owner.publicKey}),'AccountOwnedByWrongProgram');
  await reject('substituted token program',withdraw(1n,{tokenProgram:SystemProgram.programId}),'InvalidProgramId');
  await reject('zero withdrawal',withdraw(0n),'InvalidAmount');
  await reject('over reserve withdrawal',withdraw(100_000_001n),'InvalidAmount');
  evidence.withdrawSignature=await send(withdraw(100_000_000n));
  assert.deepEqual(await balances(),['0','100000000','0']);
  evidence.cases.push({name:'authorized full withdrawal',result:'confirmed',balances:['0','100000000','0']});
  await reject('repeat withdrawal',withdraw(1n),'InvalidAmount');
  evidence.status='passed';
} catch(e) { evidence.status='failed'; evidence.error=String(e); process.exitCode=1; console.error(e); }
finally {
  writeFileSync('docs/week12-security-evidence.json',JSON.stringify(evidence,null,2)+'\n');
  c._rpcWebSocket.close();
  if(child.exitCode === null && !spawnError) {
    child.kill('SIGINT');
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(5000)]);
    if(child.exitCode === null) child.kill('SIGKILL');
  }
  closeSync(log);
}
