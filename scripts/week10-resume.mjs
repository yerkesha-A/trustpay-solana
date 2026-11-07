// Resume deployment from the existing owned buffer.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const require = createRequire(`${process.cwd()}/package.json`);
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } = require('@solana/web3.js');
const { utils } = require('@coral-xyz/anchor');
const c = new Connection('https://api.devnet.solana.com', { commitment: 'confirmed', disableRetryOnRateLimit: true });
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('.anchor/week09-wallet.json', 'utf8'))));
const programKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('target/deploy/trustpay-keypair.json', 'utf8'))));
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const bytes = readFileSync('target/deploy/trustpay.so');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function rpc(fn) { for (let i = 0; i < 7; i++) {
    try {
        return await fn();
    }
    catch (e) {
        if (!/429|503|fetch failed|Too many requests/i.test(String(e)) || i === 6)
            throw e;
        console.log('RPC backoff', i + 1);
        await delay(Math.min(5000 * 2 ** i, 30000));
    }
} }
async function confirm(signatures) { const deadline = Date.now() + 90000; while (Date.now() < deadline) {
    const statuses = (await rpc(() => c.getSignatureStatuses(signatures, { searchTransactionHistory: true }))).value;
    if (statuses.some(s => s?.err))
        throw Error('Loader transaction rejected: ' + JSON.stringify(statuses.map(s => s?.err)));
    if (statuses.every(s => s && ['confirmed', 'finalized'].includes(s.confirmationStatus)))
        return;
    await delay(1500);
} throw Error('Confirmation pending; verify existing buffer before retry.'); }
try {
    if (await rpc(() => c.getGenesisHash()) !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')
        throw Error('Wrong network');
    if (programKey.publicKey.toBase58() !== JSON.parse(readFileSync('app/src/idl.json', 'utf8')).address)
        throw Error('Program ID mismatch');
    const [programData] = PublicKey.findProgramAddressSync([programKey.publicKey.toBuffer()], loader);
    const deployed = await rpc(() => c.getAccountInfo(programKey.publicKey));
    if (deployed?.executable) {
        const stored = await rpc(() => c.getAccountInfo(programData));
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (!deployed.owner.equals(loader) || !stored?.owner.equals(loader) || stored.data.readUInt32LE(0) !== 3 || stored.data[12] !== 1 || !stored.data.subarray(13, 45).equals(payer.publicKey.toBuffer()) || createHash('sha256').update(stored.data.subarray(45, 45 + bytes.length)).digest('hex') !== hash)
            throw Error('Existing deployment differs from the local build or authority. No buffer mutation performed.');
        console.log('PASS: existing executable, exact SHA-256 and original upgrade authority verified; no upload needed.');
        process.exit(0);
    }
    const found = await rpc(() => c.getProgramAccounts(loader, { filters: [{ dataSize: bytes.length + 37 }, { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(Buffer.from([1, 0, 0, 0])) } }, { memcmp: { offset: 5, bytes: payer.publicKey.toBase58() } }] }));
    if (found.length !== 1)
        throw Error(`Expected one existing owned buffer, found ${found.length}; no new keys/accounts created.`);
    const buffer = found[0].pubkey, info = found[0].account;
    if (!info.owner.equals(loader) || info.data.readUInt32LE(0) !== 1 || info.data[4] !== 1 || !info.data.subarray(5, 37).equals(payer.publicKey.toBuffer()))
        throw Error('Invalid buffer authority/state');
    const pending = [];
    const CHUNK = 900;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        const chunk = bytes.subarray(offset, offset + CHUNK);
        if (!info.data.subarray(37 + offset, 37 + offset + chunk.length).equals(chunk))
            pending.push({ offset, chunk });
    }
    console.log('Owned public buffer:', buffer.toBase58(), 'remaining chunks:', pending.length);
    writeFileSync('.anchor/week10-buffer-public.json', JSON.stringify({ address: buffer.toBase58(), bytes: bytes.length }, null, 2) + '\n');
    for (let i = 0; i < pending.length; i += 8) {
        const { blockhash } = await rpc(() => c.getLatestBlockhash('confirmed'));
        const signatures = [];
        const batch = pending.slice(i, i + 8);
        for (let j = 0; j < batch.length; j += 2) {
            const sent = await Promise.all(batch.slice(j, j + 2).map(async ({ offset, chunk }) => {
                const data = Buffer.alloc(16 + chunk.length);
                data.writeUInt32LE(1, 0);
                data.writeUInt32LE(offset, 4);
                data.writeBigUInt64LE(BigInt(chunk.length), 8);
                chunk.copy(data, 16);
                const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(new TransactionInstruction({ programId: loader, keys: [{ pubkey: buffer, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: false }], data }));
                tx.sign(payer);
                return rpc(() => c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2, preflightCommitment: 'confirmed' }));
            }));
            signatures.push(...sent);
            await delay(400);
        }
        await confirm(signatures);
        if (i % 32 === 0 || i + 8 >= pending.length)
            console.log('Uploaded', Math.min(i + 8, pending.length), '/', pending.length);
    }
    const complete = await rpc(() => c.getAccountInfo(buffer));
    if (!complete || !complete.data.subarray(37).equals(bytes))
        throw Error('Buffer bytecode does not match local build');
    const existing = await rpc(() => c.getAccountInfo(programKey.publicKey));
    const tx = new Transaction();
    if (!existing)
        tx.add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: programKey.publicKey, lamports: await rpc(() => c.getMinimumBalanceForRentExemption(36)), space: 36, programId: loader }));
    else if (existing.executable || !existing.owner.equals(loader) || existing.data.readUInt32LE(0) !== 0)
        throw Error('Unexpected existing Program account');
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0);
    data.writeBigUInt64LE(BigInt(bytes.length), 4);
    tx.add(new TransactionInstruction({ programId: loader, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: programData, isSigner: false, isWritable: true }, { pubkey: programKey.publicKey, isSigner: true, isWritable: true }, { pubkey: buffer, isSigner: false, isWritable: true }, { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: payer.publicKey, isSigner: true, isWritable: false }], data }));
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await rpc(() => c.getLatestBlockhash('confirmed'))).blockhash;
    tx.sign(payer, programKey);
    const signature = await rpc(() => c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2, preflightCommitment: 'confirmed' }));
    await confirm([signature]);
    const account = await rpc(() => c.getAccountInfo(programKey.publicKey)), stored = await rpc(() => c.getAccountInfo(programData));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (!account?.executable || !account.owner.equals(loader) || !stored?.owner.equals(loader) || stored.data.readUInt32LE(0) !== 3 || stored.data[12] !== 1 || !stored.data.subarray(13, 45).equals(payer.publicKey.toBuffer()) || createHash('sha256').update(stored.data.subarray(45, 45 + bytes.length)).digest('hex') !== hash)
        throw Error('Executable/hash verification failed');
    writeFileSync('.anchor/week10-deployment.json', JSON.stringify({ network: 'devnet', program: programKey.publicKey.toBase58(), programData: programData.toBase58(), binaryBytes: bytes.length, sha256: hash, signature, resumedOwnedBuffer: true }, null, 2) + '\n');
    console.log('PASS: real Devnet deployment, exact SHA-256, existing signer/program keys. Signature:', signature);
}
catch (e) {
    console.error(e.message);
    process.exitCode = 1;
}
