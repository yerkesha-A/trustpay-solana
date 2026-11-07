import { randomBytes } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("TrustPay: real local-validator escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  if (
    !/^http:\/\/(127\.0\.0\.1|localhost):/.test(provider.connection.rpcEndpoint)
  )
    throw new Error("Tests are local-validator only");
  const p = anchor.workspace.Trustpay as Program;
  const client = (provider.wallet as anchor.Wallet).payer;
  const freelancer = Keypair.generate(),
    attacker = Keypair.generate();
  let mint: PublicKey,
    source: PublicKey,
    destination: PublicKey,
    wrongDestination: PublicKey,
    wrongMint: PublicKey,
    wrongMintDestination: PublicKey;
  let counter = randomBytes(6).readUIntBE(0, 6);
  const balance = async (a: PublicKey) =>
    (await getAccount(provider.connection, a)).amount;
  const rejects = async (f: () => Promise<unknown>, message: string) => {
    try {
      await f();
    } catch (e) {
      const failure = e as { logs?: string[] };
      expect(String(e) + "\n" + (failure.logs || []).join("\n")).to.include(
        message,
      );
      return;
    }
    throw new Error("Expected transaction to fail: " + message);
  };
  before(async () => {
    for (const k of [freelancer, attacker]) {
      const signature = await provider.connection.requestAirdrop(
        k.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL,
      );
      const latest = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({ signature, ...latest });
    }
    mint = await createMint(
      provider.connection,
      client,
      client.publicKey,
      null,
      6,
    );
    source = await createAccount(
      provider.connection,
      client,
      mint,
      client.publicKey,
    );
    destination = await createAccount(
      provider.connection,
      client,
      mint,
      freelancer.publicKey,
    );
    wrongDestination = await createAccount(
      provider.connection,
      client,
      mint,
      attacker.publicKey,
    );
    wrongMint = await createMint(
      provider.connection,
      client,
      client.publicKey,
      null,
      6,
    );
    wrongMintDestination = await createAccount(
      provider.connection,
      client,
      wrongMint,
      freelancer.publicKey,
    );
    await mintTo(
      provider.connection,
      client,
      mint,
      source,
      client,
      1_000_000_000n,
    );
  });
  function addresses(id: BN) {
    const [order] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        client.publicKey.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      p.programId,
    );
    const [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), order.toBuffer()],
      p.programId,
    );
    return { order, vault };
  }
  async function create(amount = 100_000_000, title = "Build TrustPay") {
    const id = new BN(++counter),
      { order, vault } = addresses(id);
    await p.methods
      .createOrder(id, new BN(amount), title)
      .accountsStrict({
        client: client.publicKey,
        freelancer: freelancer.publicKey,
        mint,
        order,
        vault,
        source,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { id, order, vault };
  }
  const action = (name: string, order: PublicKey, signer = freelancer) =>
    p.methods[name]()
      .accountsStrict({ freelancer: signer.publicKey, order })
      .signers([signer])
      .rpc();
  const settle = (
    name: string,
    order: PublicKey,
    vault: PublicKey,
    to: PublicKey,
    signer = client,
  ) =>
    p.methods[name]()
      .accountsStrict({
        client: signer.publicKey,
        order,
        mint,
        vault,
        destination: to,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers(signer === client ? [] : [signer])
      .rpc();
  it("atomically funds the vault and records immutable participants", async () => {
    const before = await balance(source);
    const { order, vault } = await create();
    expect(await balance(vault)).eq(100_000_000n);
    expect(await balance(source)).eq(before - 100_000_000n);
    const state = await (p.account as any).order.fetch(order);
    expect(state.client.equals(client.publicKey)).eq(true);
    expect(state.freelancer.equals(freelancer.publicKey)).eq(true);
    expect(state.status).deep.eq({ funded: {} });
  });
  it("pays exactly once after freelancer submission and client approval", async () => {
    const { order, vault } = await create();
    const before = await balance(destination);
    await action("submitWork", order);
    await settle("release", order, vault, destination);
    expect(await balance(destination)).eq(before + 100_000_000n);
    expect(await balance(vault)).eq(0n);
    await rejects(
      () => settle("release", order, vault, destination),
      "InvalidStatus",
    );
    expect(await balance(destination)).eq(before + 100_000_000n);
  });
  it("requires freelancer consent for refund and prevents repeated refund", async () => {
    const { order, vault } = await create();
    await rejects(
      () => settle("refund", order, vault, source),
      "InvalidStatus",
    );
    await action("allowCancel", order);
    const before = await balance(source);
    await settle("refund", order, vault, source);
    expect(await balance(source)).eq(before + 100_000_000n);
    await rejects(
      () => settle("refund", order, vault, source),
      "InvalidStatus",
    );
  });
  it("rejects unauthorized submission, cancellation and release", async () => {
    const { order, vault } = await create();
    await rejects(
      () => action("submitWork", order, attacker),
      "ConstraintHasOne",
    );
    await rejects(
      () => action("allowCancel", order, attacker),
      "ConstraintHasOne",
    );
    await action("submitWork", order);
    await rejects(
      () => settle("release", order, vault, destination, attacker),
      "ConstraintHasOne",
    );
    expect(await balance(vault)).eq(100_000_000n);
  });
  it("prevents release before submission and refund after submission", async () => {
    const { order, vault } = await create();
    await rejects(
      () => settle("release", order, vault, destination),
      "InvalidStatus",
    );
    await action("submitWork", order);
    await rejects(() => action("allowCancel", order), "InvalidStatus");
    await rejects(
      () => settle("refund", order, vault, source),
      "InvalidStatus",
    );
  });
  it("rejects a substituted vault and wrong recipient or mint", async () => {
    const a = await create(),
      b = await create();
    await action("submitWork", a.order);
    await rejects(
      () => settle("release", a.order, b.vault, destination),
      "ConstraintSeeds",
    );
    await rejects(
      () => settle("release", a.order, a.vault, wrongDestination),
      "InvalidRecipient",
    );
    await rejects(
      () => settle("release", a.order, a.vault, wrongMintDestination),
      "ConstraintTokenMint",
    );
    expect(await balance(a.vault)).eq(100_000_000n);
  });
  it("validates zero amount and UTF-8 title length atomically", async () => {
    await rejects(() => create(0), "InvalidAmount");
    await rejects(() => create(1, "я".repeat(61)), "InvalidTitle");
    await rejects(() => create(1, "  "), "InvalidTitle");
  });
  it("rejects duplicate order IDs", async () => {
    const { id, order, vault } = await create();
    await rejects(
      () =>
        p.methods
          .createOrder(id, new BN(1), "Duplicate")
          .accountsStrict({
            client: client.publicKey,
            freelancer: freelancer.publicKey,
            mint,
            order,
            vault,
            source,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
      "already in use",
    );
  });
  it("rejects insufficient token balance without creating an order", async () => {
    const id = new BN(++counter),
      { order, vault } = addresses(id);
    await rejects(
      () =>
        p.methods
          .createOrder(id, new BN("18446744073709551615"), "Too much")
          .accountsStrict({
            client: client.publicKey,
            freelancer: freelancer.publicKey,
            mint,
            order,
            vault,
            source,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
      "insufficient funds",
    );
    expect(await provider.connection.getAccountInfo(order)).eq(null);
  });
  it("rejects self-dealing, invalid freelancer and a token source owned by someone else", async () => {
    for (const [worker, tokenSource, expected] of [
      [client.publicKey, source, "InvalidParty"],
      [PublicKey.default, source, "InvalidParty"],
      [freelancer.publicKey, wrongDestination, "ConstraintTokenOwner"],
    ] as const) {
      const id = new BN(++counter),
        { order, vault } = addresses(id);
      const before = await balance(tokenSource);
      await rejects(
        () =>
          p.methods
            .createOrder(id, new BN(1), "Invalid accounts")
            .accountsStrict({
              client: client.publicKey,
              freelancer: worker,
              mint,
              order,
              vault,
              source: tokenSource,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .rpc(),
        expected,
      );
      expect(await provider.connection.getAccountInfo(order)).eq(null);
      expect(await balance(tokenSource)).eq(before);
    }
  });
  it("rejects a refund to a third party and an unauthorized client", async () => {
    const { order, vault } = await create();
    await action("allowCancel", order);
    await rejects(
      () => settle("refund", order, vault, wrongDestination),
      "InvalidRecipient",
    );
    await rejects(
      () => settle("refund", order, vault, source, attacker),
      "ConstraintHasOne",
    );
    expect(await balance(vault)).eq(100_000_000n);
  });
});
