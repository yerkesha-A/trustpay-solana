import { writeFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import { liquidityAddresses } from "../shared/liquidity";

describe("Week11 real multi-program CPI composition (local validator)", function () {
  this.timeout(120000);
  const provider = anchor.AnchorProvider.env();
  if (
    !/^http:\/\/(localhost|127\.0\.0\.1):/.test(provider.connection.rpcEndpoint)
  )
    throw Error("Local validator only");
  const p = anchor.workspace.Trustpay as anchor.Program,
    payer = (provider.wallet as anchor.Wallet).payer,
    c = provider.connection;
  let mint: PublicKey,
    userTokens: PublicKey,
    userShares: PublicKey,
    addresses: ReturnType<typeof liquidityAddresses>;
  const evidence: {
    operation: string;
    signature: string;
    innerProgramIds: string[];
    logs: string[];
  }[] = [];
  async function transaction(signature: string) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const value = await c.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw Error("Confirmed transaction metadata unavailable: " + signature);
  }
  async function trace(operation: string, signature: string) {
    const tx = await transaction(signature);
    expect(tx?.meta?.err).eq(null);
    const keys = tx!.transaction.message.getAccountKeys();
    const ids = [
      ...new Set(
        tx!.meta!.innerInstructions!.flatMap((group) =>
          group.instructions.map((ix) =>
            keys.get(ix.programIdIndex)!.toBase58(),
          ),
        ),
      ),
    ];
    const logs = tx!.meta!.logMessages || [];
    evidence.push({ operation, signature, innerProgramIds: ids, logs });
    return { ids, logs };
  }
  const accounts = (
    owner = payer.publicKey,
    tokens = userTokens,
    shares = userShares,
  ) => ({
    owner,
    mint,
    ...addresses,
    userTokens: tokens,
    userShares: shares,
    tokenProgram: TOKEN_PROGRAM_ID,
  });
  before(async () => {
    mint = await createMint(c, payer, payer.publicKey, null, 6);
    userTokens = (
      await getOrCreateAssociatedTokenAccount(c, payer, mint, payer.publicKey)
    ).address;
    await mintTo(c, payer, mint, userTokens, payer, 10_000_000);
    addresses = liquidityAddresses(p.programId, mint);
    userShares = getAssociatedTokenAddressSync(
      addresses.sharesMint,
      payer.publicKey,
    );
  });
  after(() =>
    writeFileSync(
      ".anchor/week11-cpi-local-evidence.json",
      JSON.stringify({ network: "localnet", transactions: evidence }, null, 2) +
        "\n",
    ),
  );
  it("initializes PDA accounts through real System and SPL Token inner instructions", async () => {
    const sig = await p.methods
      .initializeLiquidityVault()
      .accountsStrict({
        payer: payer.publicKey,
        mint,
        ...addresses,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const { ids } = await trace("initialize", sig);
    expect(ids).include(SystemProgram.programId.toBase58());
    expect(ids).include(TOKEN_PROGRAM_ID.toBase58());
    expect(
      (await getAccount(c, addresses.reserve)).owner.equals(
        addresses.liquidityVault,
      ),
    ).eq(true);
  });
  it("atomically composes ATA creation, its System/Token CPI, and TrustPay transfer/mint CPI", async () => {
    expect(await c.getAccountInfo(userShares)).eq(null);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        userShares,
        payer.publicKey,
        addresses.sharesMint,
      ),
    );
    tx.add(
      await p.methods
        .depositLiquidity(new anchor.BN(3_000_000))
        .accountsStrict(accounts())
        .instruction(),
    );
    const sig = await provider.sendAndConfirm(tx);
    const { ids, logs } = await trace("ata-and-deposit", sig);
    expect(ids).include(SystemProgram.programId.toBase58());
    expect(ids).include(TOKEN_PROGRAM_ID.toBase58());
    expect(
      logs.some(
        (l) =>
          l.includes(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) &&
          l.includes("invoke [1]"),
      ),
    ).eq(true);
    expect((await getAccount(c, userShares)).amount).eq(3_000_000n);
    expect((await getAccount(c, addresses.reserve)).amount).eq(3_000_000n);
  });
  it("withdraws using canonical PDA authority, without a reserve private key", async () => {
    const sig = await p.methods
      .withdrawLiquidity(new anchor.BN(1_000_000))
      .accountsStrict(accounts())
      .rpc();
    const { ids, logs } = await trace("withdraw", sig);
    expect(ids).include(TOKEN_PROGRAM_ID.toBase58());
    expect(logs.some((l) => l.includes("Instruction: Burn"))).eq(true);
    expect(logs.some((l) => l.includes("Instruction: TransferChecked"))).eq(
      true,
    );
    expect((await getAccount(c, userShares)).amount).eq(2_000_000n);
    expect((await getAccount(c, userTokens)).amount).eq(8_000_000n);
  });
  it("rejects a victim account and rolls back earlier ATA creation in the same real transaction", async () => {
    // Ephemeral local actor only; no persistent wallet/keypair is created.
    const attacker = Keypair.generate(),
      destination = getAssociatedTokenAddressSync(mint, attacker.publicKey);
    const before = (await getAccount(c, addresses.reserve)).amount;
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        destination,
        attacker.publicKey,
        mint,
      ),
    );
    tx.add(
      await p.methods
        .withdrawLiquidity(new anchor.BN(1))
        .accountsStrict(accounts(attacker.publicKey, destination, userShares))
        .instruction(),
    );
    let rejected = false;
    try {
      await provider.sendAndConfirm(tx, [attacker], { skipPreflight: true });
    } catch (e) {
      rejected = true;
    }
    expect(rejected).eq(true);
    expect(tx.signature).not.eq(null);
    const failed = await transaction(
      anchor.utils.bytes.bs58.encode(tx.signature!),
    );
    expect(failed?.meta?.err).not.eq(null);
    expect(failed?.meta?.logMessages?.join("\n")).include(
      "ConstraintTokenOwner",
    );
    expect(await c.getAccountInfo(destination)).eq(null);
    expect((await getAccount(c, addresses.reserve)).amount).eq(before);
    expect((await getAccount(c, userShares)).amount).eq(2_000_000n);
  });
});
