import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  buildVaultTransaction,
  liquidityAddresses,
  loadLiquidity,
} from "../shared/liquidity";
import {
  ensureTestNetwork,
  fetchWalletSnapshot,
  fetchRecentHistory,
  type HistoryItem,
} from "../shared/rpc";
const enabled = process.env.TRUSTPAY_WEEK10_DEVNET === "1";
(enabled ? describe : describe.skip)(
  "Week10 REAL Devnet Vault CPI and RPC",
  function () {
    this.timeout(240000);
    let c: Connection,
      payer: Keypair,
      other: Keypair,
      p: Program,
      mint: PublicKey,
      otherMint: PublicKey,
      addresses: ReturnType<typeof liquidityAddresses>,
      order: PublicKey,
      escrowVault: PublicKey,
      escrowBefore: Buffer;
    const evidence: {
      operation: string;
      signature: string;
      before?: string[];
      after?: string[];
    }[] = [];
    const snapshot = async () => {
      const v = await loadLiquidity(c, p, mint, payer.publicKey);
      if (!v) throw Error("Vault not initialized");
      return v;
    };
    const record = (value: Awaited<ReturnType<typeof snapshot>>) => [
      value.userTokens.toString(),
      value.userShares.toString(),
      value.reserveAmount.toString(),
      value.shareSupply.toString(),
    ];
    const failure = async (fn: () => Promise<unknown>, expected: string) => {
      try {
        await fn();
      } catch (e) {
        expect(
          String(e) + "\n" + ((e as { logs?: string[] }).logs || []).join("\n"),
        ).include(expected);
        return;
      }
      throw Error("Expected " + expected);
    };
    before(async () => {
      c = new Connection("https://api.devnet.solana.com", {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
        fetch: require("../scripts/devnet-fetch.cjs"),
      });
      await ensureTestNetwork(c, "devnet");
      payer = Keypair.fromSecretKey(
        Uint8Array.from(
          JSON.parse(readFileSync(".anchor/week09-wallet.json", "utf8")),
        ),
      );
      other = Keypair.fromSecretKey(
        Uint8Array.from(
          JSON.parse(readFileSync(".anchor/local-wallet.json", "utf8")),
        ),
      );
      p = new Program(
        JSON.parse(readFileSync("app/src/idl.json", "utf8")),
        new AnchorProvider(c, new Wallet(payer), { commitment: "confirmed" }),
      );
      const fixture = JSON.parse(
        readFileSync(".anchor/week09-fixture.json", "utf8"),
      );
      mint = new PublicKey(fixture.mintA);
      otherMint = new PublicKey(fixture.mintB);
      addresses = liquidityAddresses(p.programId, mint);
      const existing = await c.getAccountInfo(addresses.liquidityVault);
      if (!existing) {
        const tx = await buildVaultTransaction(
          c,
          new Wallet(payer),
          p.idl,
          "devnet",
          mint,
          "initialize",
        );
        const signature = await sendAndConfirmTransaction(c, tx, [payer], {
          commitment: "confirmed",
        });
        evidence.push({ operation: "initialize-vault", signature });
      }
      writeFileSync(
        ".anchor/week10-devnet-fixture.json",
        JSON.stringify(
          {
            network: "devnet",
            mint: mint.toBase58(),
            ...Object.fromEntries(
              Object.entries(addresses).map(([k, v]) => [k, v.toBase58()]),
            ),
          },
          null,
          2,
        ) + "\n",
      );
      const id = new BN(randomBytes(6).readUIntBE(0, 6));
      [order] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("order"),
          payer.publicKey.toBuffer(),
          id.toArrayLike(Buffer, "le", 8),
        ],
        p.programId,
      );
      [escrowVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), order.toBuffer()],
        p.programId,
      );
      const signature = await p.methods
        .createOrder(id, new BN(5_000_000), "Week10 Devnet escrow regression")
        .accountsStrict({
          client: payer.publicKey,
          freelancer: other.publicKey,
          mint,
          order,
          vault: escrowVault,
          source: getAssociatedTokenAddressSync(mint, payer.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      evidence.push({ operation: "create-escrow", signature });
      escrowBefore = (await c.getAccountInfo(order))!.data;
    });
    after(() => {
      if (evidence.length)
        writeFileSync(
          ".anchor/week10-devnet-evidence.json",
          JSON.stringify(
            {
              network: "devnet",
              program: p.programId.toBase58(),
              mint: mint.toBase58(),
              vault: addresses.liquidityVault.toBase58(),
              transactions: evidence,
            },
            null,
            2,
          ) + "\n",
        );
    });
    it("deposits real test tokens and issues exactly 1:1 shares via CPI", async () => {
      const before = await snapshot(),
        tx = await buildVaultTransaction(
          c,
          new Wallet(payer),
          p.idl,
          "devnet",
          mint,
          "deposit",
          10_000_000n,
        );
      const signature = await sendAndConfirmTransaction(c, tx, [payer], {
          commitment: "confirmed",
        }),
        after = await snapshot();
      expect(after.userShares - before.userShares).eq(10_000_000n);
      expect(before.userTokens - after.userTokens).eq(10_000_000n);
      expect(after.reserveAmount - before.reserveAmount).eq(10_000_000n);
      expect(after.shareSupply - before.shareSupply).eq(10_000_000n);
      evidence.push({
        operation: "deposit",
        signature,
        before: record(before),
        after: record(after),
      });
    });
    it("burns own shares and returns exact tokens through PDA CPI", async () => {
      const before = await snapshot(),
        tx = await buildVaultTransaction(
          c,
          new Wallet(payer),
          p.idl,
          "devnet",
          mint,
          "withdraw",
          4_000_000n,
        );
      const signature = await sendAndConfirmTransaction(c, tx, [payer], {
          commitment: "confirmed",
        }),
        after = await snapshot();
      expect(before.userShares - after.userShares).eq(4_000_000n);
      expect(after.userTokens - before.userTokens).eq(4_000_000n);
      expect(before.reserveAmount - after.reserveAmount).eq(4_000_000n);
      expect(before.shareSupply - after.shareSupply).eq(4_000_000n);
      evidence.push({
        operation: "withdraw",
        signature,
        before: record(before),
        after: record(after),
      });
    });
    it("rejects foreign shares, wrong token mint and escrow reserve substitution on chain", async () => {
      const userTokens = getAssociatedTokenAddressSync(mint, payer.publicKey),
        userShares = getAssociatedTokenAddressSync(
          addresses.sharesMint,
          payer.publicKey,
        );
      const otherTokens = (
        await getOrCreateAssociatedTokenAccount(c, payer, mint, other.publicKey)
      ).address;
      const base = {
        owner: payer.publicKey,
        mint,
        ...addresses,
        userTokens,
        userShares,
        tokenProgram: TOKEN_PROGRAM_ID,
      };
      await failure(
        () =>
          p.methods
            .withdrawLiquidity(new BN(1))
            .accountsStrict({
              ...base,
              owner: other.publicKey,
              userTokens: otherTokens,
            })
            .signers([other])
            .rpc(),
        "ConstraintTokenOwner",
      );
      await failure(
        () =>
          p.methods
            .depositLiquidity(new BN(1))
            .accountsStrict({
              ...base,
              userTokens: getAssociatedTokenAddressSync(
                otherMint,
                payer.publicKey,
              ),
            })
            .rpc(),
        "ConstraintTokenMint",
      );
      await failure(
        () =>
          p.methods
            .depositLiquidity(new BN(1))
            .accountsStrict({ ...base, reserve: escrowVault })
            .rpc(),
        "Constraint",
      );
      expect((await getAccount(c, escrowVault)).amount).eq(5_000_000n);
      expect((await c.getAccountInfo(order))!.data.equals(escrowBefore)).eq(
        true,
      );
    });
    it("rejects over-withdrawal and repeated full withdrawal without changing balances", async () => {
      const before = await snapshot();
      await failure(
        () =>
          buildVaultTransaction(
            c,
            new Wallet(payer),
            p.idl,
            "devnet",
            mint,
            "withdraw",
            before.userShares + 1n,
          ),
        "Недостаточно",
      );
      const tx = await buildVaultTransaction(
        c,
        new Wallet(payer),
        p.idl,
        "devnet",
        mint,
        "withdraw",
        before.userShares,
      );
      const signature = await sendAndConfirmTransaction(c, tx, [payer], {
          commitment: "confirmed",
        }),
        after = await snapshot();
      expect(after.userShares).eq(0n);
      evidence.push({
        operation: "withdraw-all",
        signature,
        before: record(before),
        after: record(after),
      });
      const userTokens = getAssociatedTokenAddressSync(mint, payer.publicKey),
        userShares = getAssociatedTokenAddressSync(
          addresses.sharesMint,
          payer.publicKey,
        );
      await failure(
        () =>
          p.methods
            .withdrawLiquidity(new BN(before.userShares.toString()))
            .accountsStrict({
              owner: payer.publicKey,
              mint,
              ...addresses,
              userTokens,
              userShares,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc(),
        "InsufficientShares",
      );
      expect((await snapshot()).reserveAmount).eq(after.reserveAmount);
    });
    it("preserves the escrow lifecycle and executes the real freelancer payout", async () => {
      const submission = await p.methods
        .submitWork()
        .accountsStrict({ freelancer: other.publicKey, order })
        .signers([other])
        .rpc();
      evidence.push({ operation: "submit-escrow", signature: submission });
      const destination = (
          await getOrCreateAssociatedTokenAccount(
            c,
            payer,
            mint,
            other.publicKey,
          )
        ).address,
        before = (await getAccount(c, destination)).amount;
      const signature = await p.methods
        .release()
        .accountsStrict({
          client: payer.publicKey,
          order,
          mint,
          vault: escrowVault,
          destination,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      evidence.push({ operation: "release-escrow", signature });
      expect((await getAccount(c, destination)).amount - before).eq(5_000_000n);
      expect((await getAccount(c, escrowVault)).amount).eq(0n);
    });
    it("reads real SOL/SPL balances and decodes confirmed Vault/escrow history", async () => {
      const wallet = await fetchWalletSnapshot(c, payer.publicKey);
      expect(wallet.solLamports! > 0n).eq(true);
      expect(wallet.tokens!.some((t) => t.mint === mint.toBase58())).eq(true);
      const result = await fetchRecentHistory(
        c,
        p,
        [payer.publicKey, addresses.liquidityVault, order],
        12,
      );
      expect(
        result.items.some((row) =>
          row.actions.some((action) => action.kind === "vault"),
        ),
      ).eq(true);
      expect(
        result.items.some((row) =>
          row.actions.some((action) => action.kind === "escrow"),
        ),
      ).eq(true);
      writeFileSync(
        ".anchor/week10-rpc-evidence.json",
        JSON.stringify(
          {
            network: "devnet",
            solLamports: wallet.solLamports!.toString(),
            tokens: wallet.tokens!.map((t) => ({
              ...t,
              amount: t.amount.toString(),
            })),
            history: result.items,
            warnings: result.warnings,
          },
          null,
          2,
        ) + "\n",
      );
    });
  },
);
