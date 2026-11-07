import { readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { createTestPool } from "../scripts/lib/defi-fixture";
import {
  loadPool,
  quoteDeposit,
  quoteWithdraw,
  buildLiquidityTransaction,
  walletBalances,
  type Pool,
} from "../shared/defi";
const enabled = process.env.TRUSTPAY_DEFI_LOCAL === "1";
(enabled ? describe : describe.skip)(
  "Week09 official Devnet Raydium bytecode on local validator",
  function () {
    this.timeout(180000);
    const c = new Connection("http://127.0.0.1:8899", "confirmed"),
      payer = Keypair.generate();
    let pool: Pool,
      escrowVault: PublicKey,
      escrow: PublicKey,
      escrowData: Buffer;
    before(async () => {
      const sig = await c.requestAirdrop(payer.publicKey, 2e9);
      const block = await c.getLatestBlockhash();
      await c.confirmTransaction({ ...block, signature: sig });
      const fixture = await createTestPool(c, payer, true);
      pool = await loadPool(c, new PublicKey(fixture.pool), true);
      writeFileSync(
        ".anchor/week09-local-fixture.json",
        JSON.stringify(fixture, null, 2) + "\n",
      );
      const program = new Program(
        JSON.parse(readFileSync("app/src/idl.json", "utf8")),
        new AnchorProvider(c, new Wallet(payer), { commitment: "confirmed" }),
      );
      const id = new BN(1);
      [escrow] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("order"),
          payer.publicKey.toBuffer(),
          id.toArrayLike(Buffer, "le", 8),
        ],
        program.programId,
      );
      [escrowVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), escrow.toBuffer()],
        program.programId,
      );
      await program.methods
        .createOrder(
          id,
          new BN(25_000_000),
          "Escrow isolation during real DeFi",
        )
        .accountsStrict({
          client: payer.publicKey,
          freelancer: Keypair.generate().publicKey,
          mint: pool.state.mintA,
          order: escrow,
          vault: escrowVault,
          source: getAssociatedTokenAddressSync(
            pool.state.mintA,
            payer.publicKey,
          ),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: PublicKey.default,
        })
        .rpc();
      escrowData = (await c.getAccountInfo(escrow))!.data;
    });
    it("deposits into actual Raydium, mints exact LP and respects limits", async () => {
      pool = await loadPool(c, pool.address, true);
      const before = await walletBalances(c, pool, payer.publicKey),
        q = quoteDeposit(pool, 10_000_000n, 50);
      const tx = await buildLiquidityTransaction(c, payer.publicKey, q, true);
      await sendAndConfirmTransaction(c, tx, [payer], {
        commitment: "confirmed",
      });
      const after = await walletBalances(c, pool, payer.publicKey);
      expect(after[2] - before[2]).eq(q.lp);
      expect(before[0] - after[0] <= q.limitA).eq(true);
      expect(before[1] - after[1] <= q.limitB).eq(true);
    });
    it("burns actual LP and receives both assets above the minimum", async () => {
      pool = await loadPool(c, pool.address, true);
      const before = await walletBalances(c, pool, payer.publicKey),
        q = quoteWithdraw(pool, 5_000_000n, 50);
      await sendAndConfirmTransaction(
        c,
        await buildLiquidityTransaction(c, payer.publicKey, q, true),
        [payer],
        { commitment: "confirmed" },
      );
      const after = await walletBalances(c, pool, payer.publicKey);
      expect(before[2] - after[2]).eq(q.lp);
      expect(after[0] - before[0] >= q.limitA).eq(true);
      expect(after[1] - before[1] >= q.limitB).eq(true);
    });
    it("real protocol rejects impossible slippage limits atomically", async () => {
      pool = await loadPool(c, pool.address, true);
      const q = quoteDeposit(pool, 1_000_000n, 50),
        before = await walletBalances(c, pool, payer.publicKey);
      const tx = await buildLiquidityTransaction(c, payer.publicKey, q, true);
      // SDK instruction is 8-byte discriminator, LP u64, maxA u64, maxB u64.
      const instruction = tx.instructions[tx.instructions.length - 1];
      instruction.data.writeBigUInt64LE(1n, 16);
      let failed = false;
      try {
        await sendAndConfirmTransaction(c, tx, [payer], {
          commitment: "confirmed",
        });
      } catch (e) {
        failed = true;
        const logs = (e as { logs?: string[] }).logs || [];
        expect(String(e) + logs.join("\n")).match(
          /ExceededSlippage|slippage|0x1775/,
        );
      }
      expect(failed).eq(true);
      expect(await walletBalances(c, pool, payer.publicKey)).deep.eq(before);
    });
    it("keeps the funded TrustPay escrow balance and state unchanged", async () => {
      expect((await getAccount(c, escrowVault)).amount).eq(25_000_000n);
      expect((await c.getAccountInfo(escrow))!.data.equals(escrowData)).eq(
        true,
      );
    });
  },
);
