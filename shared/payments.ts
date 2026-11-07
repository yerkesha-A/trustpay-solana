import { Buffer } from "buffer";
import { AnchorProvider, BN, Idl, Program, type Wallet } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getMint, getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { parseUnits } from "./defi";
import { ensureTestNetwork } from "./rpc";
import { week13Transaction } from "./transactions";
import { WEEK13 } from "./week13-config";
export const TRUSTPAY_PROGRAM = new PublicKey("ojfaRp5p9b8ZyK5VH5VQQQYxTWy8hi3QTorcTHtN19A");
export type Payment = {
    publicKey: PublicKey;
    account: {
        client: PublicKey;
        freelancer: PublicKey;
        mint: PublicKey;
        amount: BN;
        id: BN;
        title: string;
        status: Record<string, object>;
    };
};
export type PaymentWallet = Pick<Wallet, "publicKey" | "signTransaction" | "signAllTransactions">;
export function paymentProgram(c: Connection, wallet: PaymentWallet, idl: Idl) {
    if (idl.address !== TRUSTPAY_PROGRAM.toBase58())
        throw Error("Неправильный program ID.");
    return new Program(idl, new AnchorProvider(c, wallet, { commitment: "confirmed" }));
}
export async function stablecoinMint(c: Connection) {
    await ensureTestNetwork(c, "devnet");
    const mint = new PublicKey(WEEK13.stableMint);
    const data = await getMint(c, mint, "confirmed", TOKEN_PROGRAM_ID);
    if (!data.isInitialized || data.decimals !== WEEK13.decimals)
        throw Error("Некорректный Mock USD mint/decimals.");
    return { mint, ...data };
}
export async function stablecoinBalance(c: Connection, owner: PublicKey) {
    const { mint } = await stablecoinMint(c);
    const ata = getAssociatedTokenAddressSync(mint, owner);
    if (!await c.getAccountInfo(ata))
        return 0n;
    const account = await getAccount(c, ata);
    if (!account.owner.equals(owner) || !account.mint.equals(mint) || account.isFrozen)
        throw Error("Некорректный или замороженный ATA.");
    return account.amount;
}
export async function listPayments(c: Connection, wallet: PaymentWallet, idl: Idl) {
    await stablecoinMint(c);
    const rows = await (paymentProgram(c, wallet, idl).account as any).order.all() as Payment[];
    return rows.filter(p => p.account.mint.toBase58() === WEEK13.stableMint &&
        (p.account.client.equals(wallet.publicKey) || p.account.freelancer.equals(wallet.publicKey)));
}
export function validatePaymentParties(client: PublicKey, worker: PublicKey) {
    if (client.equals(worker) || worker.equals(PublicKey.default))
        throw Error("Нужен другой адрес исполнителя.");
}
export async function buildPayment(c: Connection, wallet: PaymentWallet, idl: Idl, worker: PublicKey, amountText: string, title: string, id: BN) {
    validatePaymentParties(wallet.publicKey, worker);
    if (!title.trim() || Buffer.byteLength(title) > 120)
        throw Error("Название: 1–120 байт.");
    const { mint, decimals } = await stablecoinMint(c);
    const amount = parseUnits(amountText, decimals);
    if (await stablecoinBalance(c, wallet.publicKey) < amount)
        throw Error("Недостаточно свободных Mock USD.");
    const [order] = PublicKey.findProgramAddressSync([Buffer.from("order"), wallet.publicKey.toBuffer(), id.toArrayLike(Buffer, "le", 8)], TRUSTPAY_PROGRAM);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), order.toBuffer()], TRUSTPAY_PROGRAM);
    const instruction = await paymentProgram(c, wallet, idl).methods.createOrder(id, new BN(amount.toString()), title).accountsStrict({
        client: wallet.publicKey, freelancer: worker, mint, order, vault, source: getAssociatedTokenAddressSync(mint, wallet.publicKey), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    return { transaction: week13Transaction().add(instruction), order };
}
export type PaymentAction = "submitWork" | "allowCancel" | "release" | "refund";
export function assertPaymentAction(account: Payment["account"], owner: PublicKey, action: PaymentAction) {
    const workerAction = action === "submitWork" || action === "allowCancel";
    if (!(workerAction ? account.freelancer : account.client).equals(owner))
        throw Error("Нет полномочий для этой операции.");
    const status = Object.keys(account.status)[0];
    const required = workerAction ? "funded" : action === "release" ? "submitted" : "cancelApproved";
    if (status !== required)
        throw Error("Операция недоступна в текущем статусе.");
    if (account.mint.toBase58() !== WEEK13.stableMint)
        throw Error("Платёж использует другой mint.");
}
export async function buildPaymentAction(c: Connection, wallet: PaymentWallet, idl: Idl, address: PublicKey, action: PaymentAction) {
    await stablecoinMint(c);
    const p = paymentProgram(c, wallet, idl);
    const a = await (p.account as any).order.fetch(address) as Payment["account"];
    const [canonical] = PublicKey.findProgramAddressSync([Buffer.from("order"), a.client.toBuffer(), a.id.toArrayLike(Buffer, "le", 8)], TRUSTPAY_PROGRAM);
    if (!canonical.equals(address))
        throw Error("Некорректный order PDA.");
    assertPaymentAction(a, wallet.publicKey, action);
    if (action === "submitWork" || action === "allowCancel")
        return week13Transaction().add(await p.methods[action]().accountsStrict({ freelancer: wallet.publicKey, order: address }).instruction());
    const recipient = action === "release" ? a.freelancer : a.client;
    const destination = getAssociatedTokenAddressSync(a.mint, recipient);
    const [vault] = PublicKey.findProgramAddressSync([Buffer.from("vault"), address.toBuffer()], TRUSTPAY_PROGRAM);
    return week13Transaction().add(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, destination, recipient, a.mint), await p.methods[action]().accountsStrict({ client: wallet.publicKey, order: address, mint: a.mint, vault, destination, tokenProgram: TOKEN_PROGRAM_ID }).instruction());
}
