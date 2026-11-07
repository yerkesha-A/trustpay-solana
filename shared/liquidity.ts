import { Buffer } from "buffer";
import {
  AnchorProvider,
  BN,
  Program,
  utils,
  type Idl,
} from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { ensureTestNetwork, rpcRetry, type TestNetwork } from "./rpc";
export type SigningWallet = Pick<
  AnchorProvider["wallet"],
  "publicKey" | "signTransaction" | "signAllTransactions"
>;
export const TRANSACTION_CONFIRMED_EVENT = "trustpay:transaction-confirmed";
export function liquidityAddresses(programId: PublicKey, mint: PublicKey) {
  const [liquidityVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity"), mint.toBuffer()],
    programId,
  );
  const [sharesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_shares"), liquidityVault.toBuffer()],
    programId,
  );
  const [reserve] = PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_reserve"), liquidityVault.toBuffer()],
    programId,
  );
  return { liquidityVault, sharesMint, reserve };
}
export type LiquiditySnapshot = {
  address: PublicKey;
  mint: PublicKey;
  sharesMint: PublicKey;
  reserve: PublicKey;
  decimals: number;
  reserveAmount: bigint;
  shareSupply: bigint;
  userShares: bigint;
  userTokens: bigint;
  slot: number;
};
export async function loadLiquidity(
  c: Connection,
  p: Program,
  mint: PublicKey,
  owner: PublicKey,
): Promise<LiquiditySnapshot | null> {
  const { liquidityVault, sharesMint, reserve } = liquidityAddresses(
    p.programId,
    mint,
  );
  const account = await rpcRetry(() => c.getAccountInfo(liquidityVault));
  if (!account) return null;
  if (!account.owner.equals(p.programId))
    throw Error("Liquidity Vault принадлежит другой программе.");
  const state = p.coder.accounts.decode<{
    mint: PublicKey;
    sharesMint: PublicKey;
    reserve: PublicKey;
  }>("liquidityVault", account.data);
  if (
    !state.mint.equals(mint) ||
    !state.sharesMint.equals(sharesMint) ||
    !state.reserve.equals(reserve)
  )
    throw Error("Неверные PDA или mint Liquidity Vault.");
  const userShares = getAssociatedTokenAddressSync(sharesMint, owner),
    userTokens = getAssociatedTokenAddressSync(mint, owner);
  const data = await rpcRetry(() =>
    c.getMultipleAccountsInfoAndContext(
      [reserve, sharesMint, mint, userShares, userTokens],
      "confirmed",
    ),
  );
  const infos = data.value;
  if (!infos[0] || !infos[1] || !infos[2])
    throw Error("Не найдены резерв или mint Vault.");
  const reserveData = unpackAccount(reserve, infos[0]),
    shares = unpackMint(sharesMint, infos[1]),
    underlying = unpackMint(mint, infos[2]);
  if (
    !reserveData.owner.equals(liquidityVault) ||
    !reserveData.mint.equals(mint) ||
    !shares.mintAuthority?.equals(liquidityVault) ||
    shares.decimals !== underlying.decimals
  )
    throw Error("Нарушена конфигурация Liquidity Vault.");
  if (reserveData.amount < shares.supply)
    throw Error("Резерв не покрывает выпущенные shares.");
  return {
    address: liquidityVault,
    mint,
    sharesMint,
    reserve,
    decimals: underlying.decimals,
    reserveAmount: reserveData.amount,
    shareSupply: shares.supply,
    userShares: infos[3] ? unpackAccount(userShares, infos[3]).amount : 0n,
    userTokens: infos[4] ? unpackAccount(userTokens, infos[4]).amount : 0n,
    slot: data.context.slot,
  };
}
export async function buildVaultTransaction(
  c: Connection,
  wallet: SigningWallet,
  idl: Idl,
  network: TestNetwork,
  mint: PublicKey,
  action: "initialize" | "deposit" | "withdraw",
  amount = 0n,
): Promise<Transaction> {
  await ensureTestNetwork(c, network);
  const programInfo = await rpcRetry(() =>
    c.getAccountInfo(new PublicKey(idl.address)),
  );
  if (!programInfo?.executable)
    throw Error("TrustPay не развёрнут в выбранной сети.");
  const p = new Program(
    idl,
    new AnchorProvider(c, wallet, { commitment: "confirmed" }),
  );
  const addresses = liquidityAddresses(p.programId, mint);
  if (action === "initialize")
    return p.methods
      .initializeLiquidityVault()
      .accountsStrict({
        payer: wallet.publicKey,
        mint,
        ...addresses,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
  if (amount <= 0n || amount > 18446744073709551615n)
    throw Error("Сумма вне диапазона u64.");
  const data = await loadLiquidity(c, p, mint, wallet.publicKey);
  if (!data) throw Error("Сначала создайте Liquidity Vault для этого mint.");
  if (action === "deposit" && data.userTokens < amount)
    throw Error("Недостаточно свободных токенов в ATA кошелька.");
  if (action === "withdraw" && data.userShares < amount)
    throw Error("Недостаточно собственных share-токенов для вывода.");
  const userTokens = getAssociatedTokenAddressSync(mint, wallet.publicKey),
    userShares = getAssociatedTokenAddressSync(
      addresses.sharesMint,
      wallet.publicKey,
    );
  const method =
    action === "deposit"
      ? p.methods.depositLiquidity(new BN(amount.toString()))
      : p.methods.withdrawLiquidity(new BN(amount.toString()));
  return method
    .accountsStrict({
      owner: wallet.publicKey,
      mint,
      ...addresses,
      userTokens,
      userShares,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        userTokens,
        wallet.publicKey,
        mint,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        userShares,
        wallet.publicKey,
        addresses.sharesMint,
      ),
    ])
    .transaction();
}
export async function sendVaultTransaction(
  c: Connection,
  wallet: SigningWallet,
  tx: Transaction,
  onSignature: (signature: string) => void,
) {
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (
    await rpcRetry(() => c.getLatestBlockhash("confirmed"))
  ).blockhash;
  const signed = await wallet.signTransaction(tx);
  if (!signed.signature) throw Error("Кошелёк не подписал транзакцию.");
  const signature = utils.bytes.bs58.encode(signed.signature);
  onSignature(signature);
  await c.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 2,
  });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const status = (
      await rpcRetry(() =>
        c.getSignatureStatuses([signature], { searchTransactionHistory: true }),
      )
    ).value[0];
    if (status?.err)
      throw Error("Транзакция отклонена: " + JSON.stringify(status.err));
    if (
      status &&
      ["confirmed", "finalized"].includes(status.confirmationStatus || "")
    )
      return signature;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw Error(
    "Подтверждение ещё не получено. Проверьте подпись в Explorer перед повтором.",
  );
}
