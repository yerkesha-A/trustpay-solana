import { Connection, ComputeBudgetProgram, Keypair, Transaction } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { ensureTestNetwork } from "./rpc";
import { requestWalletSignature, type TransactionSigner } from "./wallet-signing";
export function week13Transaction() {
    return new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 900000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }));
}
export async function sendWeek13Transaction(c: Connection, wallet: TransactionSigner, tx: Transaction, signers: Keypair[] = [], onSignature?: (signature: string) => void, validate?: () => void) {
    await ensureTestNetwork(c, "devnet");
    const block = await c.getLatestBlockhash("confirmed");
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = block.blockhash;
    if (signers.length)
        tx.partialSign(...signers);
    validate?.();
    const signed = await requestWalletSignature(wallet, tx, block.blockhash);
    validate?.();
    const signature = utils.bytes.bs58.encode(signed.signature!);
    onSignature?.(signature);
    await c.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 2 });
    const result = await c.confirmTransaction({ signature, ...block }, "confirmed");
    if (result.value.err)
        throw Error(JSON.stringify(result.value.err));
    return signature;
}
