import { Buffer } from "buffer";
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getMint,
} from "@solana/spl-token";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import rawIdl from "./idl.json";
export const network = import.meta.env.VITE_NETWORK || "localnet";
export const endpoint = import.meta.env.VITE_RPC_URL || "http://127.0.0.1:8899";
const url = new URL(endpoint);
if (!(
  (network === "localnet" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
  (network === "devnet" &&
    (url.hostname === "api.devnet.solana.com" ||
      url.hostname === "devnet.helius-rpc.com") &&
    url.protocol === "https:")
))
  throw new Error("Разрешены только localhost и проверенные Devnet RPC.");
export const connection = new Connection(endpoint, "confirmed");
export const configured = Boolean(rawIdl && import.meta.env.VITE_PROGRAM_ID);
export const short = (s: string) => s.slice(0, 5) + "…" + s.slice(-5);
export const explorer = (s: string, kind = "tx") =>
  `https://explorer.solana.com/${kind}/${s}?cluster=${network === "devnet" ? "devnet" : "custom&customUrl=" + encodeURIComponent(endpoint)}`;
export type Order = {
  publicKey: PublicKey;
  account: {
    client: PublicKey;
    freelancer: PublicKey;
    mint: PublicKey;
    id: BN;
    amount: BN;
    title: string;
    status: Record<string, object>;
  };
};
export function program(wallet: AnchorWallet) {
  const idl = rawIdl as unknown as Idl;
  if (!configured || idl.address !== import.meta.env.VITE_PROGRAM_ID)
    throw new Error("Соберите программу и синхронизируйте IDL / program ID.");
  return new Program(
    idl,
    new AnchorProvider(connection, wallet, { commitment: "confirmed" }),
  );
}
export function units(value: string, decimals: number) {
  if (!/^\d+(\.\d+)?$/.test(value))
    throw new Error("Введите положительную сумму.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error(`Максимум ${decimals} знаков после точки.`);
  const amount =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount <= 0n || amount > 18446744073709551615n)
    throw new Error("Сумма вне диапазона u64.");
  return new BN(amount.toString());
}
export async function create(
  wallet: AnchorWallet,
  title: string,
  freelancer: string,
  mintText: string,
  amount: string,
) {
  const p = program(wallet),
    mint = new PublicKey(mintText),
    worker = new PublicKey(freelancer);
  const meta = await getMint(connection, mint);
  const id = new BN(
    crypto
      .getRandomValues(new Uint32Array(2))
      .reduce((v, n) => (v << 32n) + BigInt(n), 0n)
      .toString(),
  );
  const [order] = PublicKey.findProgramAddressSync(
    [
      new TextEncoder().encode("order"),
      wallet.publicKey.toBuffer(),
      id.toArrayLike(Buffer, "le", 8),
    ],
    p.programId,
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("vault"), order.toBuffer()],
    p.programId,
  );
  return p.methods
    .createOrder(id, units(amount, meta.decimals), title)
    .accountsStrict({
      client: wallet.publicKey,
      freelancer: worker,
      mint,
      order,
      vault,
      source: getAssociatedTokenAddressSync(mint, wallet.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}
export async function act(wallet: AnchorWallet, order: Order, action: string) {
  const p = program(wallet);
  if (action === "submitWork" || action === "allowCancel")
    return p.methods[action]()
      .accountsStrict({ freelancer: wallet.publicKey, order: order.publicKey })
      .rpc();
  const owner =
    action === "release" ? order.account.freelancer : order.account.client;
  const destination = getAssociatedTokenAddressSync(order.account.mint, owner);
  const [vault] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("vault"), order.publicKey.toBuffer()],
    p.programId,
  );
  return p.methods[action]()
    .accountsStrict({
      client: wallet.publicKey,
      order: order.publicKey,
      mint: order.account.mint,
      vault,
      destination,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        destination,
        owner,
        order.account.mint,
      ),
    ])
    .rpc();
}
export async function confirm(signature: string) {
  // Confirm the submitted signature without replacing its blockhash.
  for (let i = 0; i < 60; i++) {
    const result = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (result?.err) throw new Error(JSON.stringify(result.err));
    if (
      result &&
      ["confirmed", "finalized"].includes(result.confirmationStatus || "")
    )
      return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    "Подтверждение пока не получено. Проверьте транзакцию в Explorer перед повтором.",
  );
}
