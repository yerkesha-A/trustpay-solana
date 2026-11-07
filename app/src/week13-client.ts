import { Connection } from "@solana/web3.js";
import { validateTestEndpoint } from "../../shared/rpc";
export const week13Connection = new Connection(validateTestEndpoint(import.meta.env.VITE_DEFI_RPC_URL || "https://api.devnet.solana.com", "devnet"), { commitment: "confirmed", disableRetryOnRateLimit: true });
export const week13Explorer = (id: string, kind = "tx") => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
export async function confirmedFee(signature: string) {
    const tx = await week13Connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    return tx?.meta ? ` Сетевая комиссия: ${tx.meta.fee / 1e9} SOL.` : " Комиссия доступна в Explorer.";
}
