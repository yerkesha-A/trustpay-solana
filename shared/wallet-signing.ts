import { PublicKey, Transaction, Message } from "@solana/web3.js";
import { decodeComputeBudget } from "./swap-budget";

export type TransactionSigner = {
  publicKey: PublicKey;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
};
// Compare resolved instructions and permissions, not account-table order.
export function signingMessageSnapshot(message: Message) {
  return {
    payer: message.accountKeys[0].toBase58(),
    blockhash: message.recentBlockhash,
    accounts: message.accountKeys.map((key, index) => ({
      address: key.toBase58(), signer: message.isAccountSigner(index),
      writable: message.isAccountWritable(index),
    })).sort((a, b) => a.address.localeCompare(b.address)),
    instructions: message.instructions.map(ix => ({
      program: message.accountKeys[ix.programIdIndex].toBase58(),
      accounts: ix.accounts.map(index => message.accountKeys[index].toBase58()),
      data: ix.data,
    })),
  };
}
export async function requestWalletSignature(
  wallet: TransactionSigner,
  transaction: Transaction,
  blockhash: string,
): Promise<Transaction> {
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = blockhash;
  const before = transaction.serializeMessage();
  // Snapshot before awaiting: the wallet may mutate the input.
  const expected = signingMessageSnapshot(Message.from(before));
  const signed = await wallet.signTransaction(transaction);
  const after = signed.serializeMessage();
  const actual = signingMessageSnapshot(Message.from(after));
  const sameMeaning = JSON.stringify(expected) === JSON.stringify(actual);
  // Store public message bytes locally for diagnosing wallet changes.
  const diagnostic = {
    checkedAt: new Date().toISOString(),
    sameBytes: before.equals(after), sameMeaning,
    beforeMessageBase64: before.toString("base64"),
    afterMessageBase64: after.toString("base64"),
    before: expected, after: actual,
    beforeComputeBudget: decodeComputeBudget(Message.from(before)),
    afterComputeBudget: decodeComputeBudget(Message.from(after)),
  };
  if (typeof globalThis !== "undefined") {
    const browser = globalThis as unknown as { sessionStorage?: { setItem(key: string, value: string): void } };
    try { browser.sessionStorage?.setItem("trustpay:swap-signing-diagnostic", JSON.stringify(diagnostic)); } catch { /* Storage may be disabled. */ }
  }
  if (!sameMeaning) {
    const changed = (Object.keys(expected) as Array<keyof typeof expected>)
      .filter(key => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]));
    throw Error("Кошелёк изменил содержимое транзакции: " + changed.join(", ") + ". Отправка отменена.");
  }
  if (!signed.signature || !signed.verifySignatures())
    throw Error("Кошелёк не предоставил действительную подпись.");
  return signed;
}
