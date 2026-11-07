import { writeFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import { randomBytes } from "node:crypto";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  getMint,
  mintTo,
  freezeAccount,
  thawAccount,
  transfer,
} from "@solana/spl-token";
import { expect } from "chai";
import { liquidityAddresses } from "../shared/liquidity";

describe("Week10 isolated Liquidity Vault CPI", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  if (
    !/^http:\/\/(localhost|127\.0\.0\.1):/.test(provider.connection.rpcEndpoint)
  )
    throw Error("Local validator only");
  const p = anchor.workspace.Trustpay as anchor.Program,
    payer = (provider.wallet as anchor.Wallet).payer,
    attacker = Keypair.generate();
  let mint: PublicKey,
    otherMint: PublicKey,
    userTokens: PublicKey,
    userShares: PublicKey,
    attackerTokens: PublicKey,
    attackerShares: PublicKey,
    otherTokens: PublicKey,
    addresses: ReturnType<typeof liquidityAddresses>;
  const tokenBalance = async (address: PublicKey) =>
    (await getAccount(provider.connection, address)).amount;
  const supply = async () =>
    (await getMint(provider.connection, addresses.sharesMint)).supply;
  const call = (
    action: "depositLiquidity" | "withdrawLiquidity",
    amount: bigint,
    overrides: Record<string, PublicKey> = {},
    signer = payer,
  ) =>
    p.methods[action](new anchor.BN(amount.toString()))
      .accountsStrict({
        owner: signer.publicKey,
        mint,
        ...addresses,
        userTokens,
        userShares,
        tokenProgram: TOKEN_PROGRAM_ID,
        ...overrides,
      })
      .signers(signer === payer ? [] : [signer])
      .rpc();
  const fails = async (fn: () => Promise<unknown>, expected: string) => {
    try {
      await fn();
    } catch (e) {
      expect(
        String(e) + "\n" + ((e as { logs?: string[] }).logs || []).join("\n"),
      ).include(expected);
      return;
    }
    throw Error("Expected failure: " + expected);
  };
  before(async () => {
    mint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      payer.publicKey,
      6,
    );
    otherMint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6,
    );
    userTokens = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        mint,
        payer.publicKey,
      )
    ).address;
    otherTokens = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        otherMint,
        payer.publicKey,
      )
    ).address;
    attackerTokens = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        mint,
        attacker.publicKey,
      )
    ).address;
    addresses = liquidityAddresses(p.programId, mint);
    await p.methods
      .initializeLiquidityVault()
      .accountsStrict({
        payer: payer.publicKey,
        mint,
        ...addresses,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    userShares = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        addresses.sharesMint,
        payer.publicKey,
      )
    ).address;
    attackerShares = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        addresses.sharesMint,
        attacker.publicKey,
      )
    ).address;
    await mintTo(
      provider.connection,
      payer,
      mint,
      userTokens,
      payer,
      2_000_000_000n,
    );
  });
  after(() => {
    if (mint && addresses)
      writeFileSync(
        ".anchor/week10-local-fixture.json",
        JSON.stringify(
          {
            network: "localnet",
            mint: mint.toBase58(),
            liquidityVault: addresses.liquidityVault.toBase58(),
            sharesMint: addresses.sharesMint.toBase58(),
            reserve: addresses.reserve.toBase58(),
          },
          null,
          2,
        ) + "\n",
      );
  });
  beforeEach(async () => {
    const amount = await tokenBalance(userShares);
    if (amount > 0n) await call("withdrawLiquidity", amount);
  });
  it("initializes separate PDA reserve/share mint with no freeze authority", async () => {
    const reserve = await getAccount(provider.connection, addresses.reserve),
      shares = await getMint(provider.connection, addresses.sharesMint);
    expect(reserve.owner.equals(addresses.liquidityVault)).eq(true);
    expect(shares.mintAuthority!.equals(addresses.liquidityVault)).eq(true);
    expect(shares.freezeAuthority).eq(null);
    expect(shares.decimals).eq(6);
    expect(shares.supply).eq(0n);
  });
  it("deposits, mints 1:1 shares, partially withdraws and burns exact shares", async () => {
    const before = await tokenBalance(userTokens),
      reserve = await tokenBalance(addresses.reserve);
    await call("depositLiquidity", 100_000_000n);
    expect(await tokenBalance(userShares)).eq(100_000_000n);
    expect(await supply()).eq(100_000_000n);
    expect(await tokenBalance(userTokens)).eq(before - 100_000_000n);
    await call("withdrawLiquidity", 40_000_000n);
    expect(await tokenBalance(userShares)).eq(60_000_000n);
    expect(await supply()).eq(60_000_000n);
    expect(await tokenBalance(userTokens)).eq(before - 60_000_000n);
    expect(await tokenBalance(addresses.reserve)).eq(reserve + 60_000_000n);
  });
  it("rejects withdrawing more shares than the signer owns", async () => {
    await call("depositLiquidity", 10_000_000n);
    const before = await tokenBalance(addresses.reserve);
    await fails(
      () => call("withdrawLiquidity", 10_000_001n),
      "InsufficientShares",
    );
    expect(await tokenBalance(addresses.reserve)).eq(before);
    expect(await tokenBalance(userShares)).eq(10_000_000n);
  });
  it("rejects a foreign signer using another holder share account", async () => {
    await call("depositLiquidity", 10_000_000n);
    await fails(
      () =>
        call("withdrawLiquidity", 1n, { userTokens: attackerTokens }, attacker),
      "ConstraintTokenOwner",
    );
    expect(await tokenBalance(userShares)).eq(10_000_000n);
  });
  it("rejects redirecting the payout to a third-party token account", async () => {
    await call("depositLiquidity", 10_000_000n);
    await fails(
      () => call("withdrawLiquidity", 1n, { userTokens: attackerTokens }),
      "ConstraintTokenOwner",
    );
  });
  it("prevents repeated withdrawal after all shares are burned", async () => {
    await call("depositLiquidity", 5_000_000n);
    await call("withdrawLiquidity", 5_000_000n);
    const before = await tokenBalance(userTokens);
    await fails(
      () => call("withdrawLiquidity", 5_000_000n),
      "InsufficientShares",
    );
    expect(await tokenBalance(userTokens)).eq(before);
    expect(await supply()).eq(0n);
  });
  it("rejects wrong mint, token account, share mint and reserve", async () => {
    await fails(
      () => call("depositLiquidity", 1n, { userTokens: otherTokens }),
      "ConstraintTokenMint",
    );
    await fails(
      () => call("depositLiquidity", 1n, { mint: otherMint }),
      "Constraint",
    );
    await fails(
      () => call("depositLiquidity", 1n, { sharesMint: otherMint }),
      "Constraint",
    );
    await fails(
      () => call("depositLiquidity", 1n, { reserve: userTokens }),
      "Constraint",
    );
  });
  it("rejects zero, insufficient deposit and u64 maximum without wrapping", async () => {
    await fails(() => call("depositLiquidity", 0n), "InvalidVaultAmount");
    await fails(() => call("withdrawLiquidity", 0n), "InvalidVaultAmount");
    await fails(
      () => call("depositLiquidity", 18446744073709551615n),
      "InsufficientDepositTokens",
    );
    await fails(
      () => call("withdrawLiquidity", 18446744073709551615n),
      "InsufficientShares",
    );
  });
  it("rolls share burn back if the SPL transfer CPI fails", async () => {
    await call("depositLiquidity", 10_000_000n);
    const shares = await tokenBalance(userShares),
      reserve = await tokenBalance(addresses.reserve);
    await freezeAccount(provider.connection, payer, userTokens, mint, payer);
    try {
      await fails(() => call("withdrawLiquidity", 5_000_000n), "frozen");
      expect(await tokenBalance(userShares)).eq(shares);
      expect(await tokenBalance(addresses.reserve)).eq(reserve);
      expect(await supply()).eq(shares);
    } finally {
      await thawAccount(provider.connection, payer, userTokens, mint, payer);
    }
  });
  it("direct token donations do not create shares or increase user claims", async () => {
    await mintTo(
      provider.connection,
      payer,
      mint,
      addresses.reserve,
      payer,
      1_000_000n,
    );
    expect(await supply()).eq(0n);
    await call("depositLiquidity", 2_000_000n);
    expect(await tokenBalance(userShares)).eq(2_000_000n);
    await call("withdrawLiquidity", 2_000_000n);
    expect(await tokenBalance(addresses.reserve)).eq(1_000_000n);
    await fails(() => call("withdrawLiquidity", 1n), "InsufficientShares");
  });
  it("preserves escrow and rejects substituting escrow vault as deposit source", async () => {
    const id = new anchor.BN(randomBytes(6).readUIntBE(0, 6));
    const [order] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        payer.publicKey.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      p.programId,
    );
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), order.toBuffer()],
      p.programId,
    );
    await p.methods
      .createOrder(
        id,
        new anchor.BN(25_000_000),
        "Escrow isolated from Liquidity Vault",
      )
      .accountsStrict({
        client: payer.publicKey,
        freelancer: attacker.publicKey,
        mint,
        order,
        vault,
        source: userTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const before = (await provider.connection.getAccountInfo(order))!.data;
    await fails(
      () => call("depositLiquidity", 1n, { userTokens: vault }),
      "ConstraintTokenOwner",
    );
    await call("depositLiquidity", 10_000_000n);
    await call("withdrawLiquidity", 10_000_000n);
    expect(await tokenBalance(vault)).eq(25_000_000n);
    expect(
      (await provider.connection.getAccountInfo(order))!.data.equals(before),
    ).eq(true);
  });
  it("allows the legitimate new holder of transferred SPL shares to withdraw", async () => {
    await call("depositLiquidity", 3_000_000n);
    await transfer(
      provider.connection,
      payer,
      userShares,
      attackerShares,
      payer,
      3_000_000n,
    );
    const before = await tokenBalance(attackerTokens);
    await call(
      "withdrawLiquidity",
      3_000_000n,
      { userTokens: attackerTokens, userShares: attackerShares },
      attacker,
    );
    expect(await tokenBalance(attackerTokens)).eq(before + 3_000_000n);
    expect(await tokenBalance(userShares)).eq(0n);
  });
});
