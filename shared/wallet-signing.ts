import { PublicKey, Transaction } from "@solana/web3.js";

export type TransactionSigner = {
  publicKey: PublicKey;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
};
// The adapter opens Phantom's approval UI. This function never supplies a signature.
export async function requestWalletSignature(
  wallet: TransactionSigner,
  transaction: Transaction,
  blockhash: string,
): Promise<Transaction> {
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = blockhash;
  const message = transaction.serializeMessage();
  const signed = await wallet.signTransaction(transaction);
  if (!signed.serializeMessage().equals(message))
    throw Error("Кошелёк изменил содержимое транзакции.");
  if (!signed.signature || !signed.verifySignatures())
    throw Error("Кошелёк не предоставил действительную подпись.");
  return signed;
}
