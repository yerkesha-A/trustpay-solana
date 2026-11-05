import { readFileSync, writeFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";
import {
  loadPool,
  quoteDeposit,
  quoteWithdraw,
  buildLiquidityTransaction,
  walletBalances,
  RAYDIUM_DEVNET,
} from "../shared/defi";
const enabled = process.env.TRUSTPAY_DEFI_DEVNET === "1";
(enabled ? describe : describe.skip)(
  "Week09 REAL Raydium Devnet transactions",
  function () {
    this.timeout(240000);
    let c: Connection, payer: Keypair, pool: PublicKey;
    const evidence: {
      operation: string;
      signature: string;
      before: string[];
      after: string[];
    }[] = [];
    before(() => {
      c = new Connection("https://api.devnet.solana.com", {
        commitment: "confirmed",
        disableRetryOnRateLimit: true,
      });
      payer = Keypair.fromSecretKey(
        Uint8Array.from(
          JSON.parse(readFileSync(".anchor/week09-wallet.json", "utf8")),
        ),
      );
      pool = new PublicKey(
        JSON.parse(readFileSync(".anchor/week09-fixture.json", "utf8")).pool,
      );
    });
    after(() => {
      if (evidence.length)
        writeFileSync(
          ".anchor/week09-evidence.json",
          JSON.stringify(
            {
              network: "devnet",
              program: RAYDIUM_DEVNET.toBase58(),
              pool: pool.toBase58(),
              transactions: evidence,
            },
            null,
            2,
          ) + "\n",
        );
    });
    it("adds real liquidity from wallet ATAs and receives LP", async () => {
      const snapshot = await loadPool(c, pool),
        before = await walletBalances(c, snapshot, payer.publicKey);
      const q = quoteDeposit(snapshot, 10_000_000n, 50);
      const tx = await buildLiquidityTransaction(c, payer.publicKey, q);
      const signature = await sendAndConfirmTransaction(c, tx, [payer], {
        commitment: "confirmed",
      });
      const after = await walletBalances(
        c,
        await loadPool(c, pool),
        payer.publicKey,
      );
      expect(before[0] - after[0] <= q.limitA && before[0] > after[0]).eq(true);
      expect(before[1] - after[1] <= q.limitB && before[1] > after[1]).eq(true);
      expect(after[2] - before[2]).eq(q.lp);
      evidence.push({
        operation: "deposit",
        signature,
        before: before.map(String),
        after: after.map(String),
      });
      console.log("Devnet deposit:", signature);
    });
    it("withdraws real LP, burns it and returns both assets", async () => {
      const snapshot = await loadPool(c, pool),
        before = await walletBalances(c, snapshot, payer.publicKey);
      const q = quoteWithdraw(snapshot, 5_000_000n, 50);
      const tx = await buildLiquidityTransaction(c, payer.publicKey, q);
      const signature = await sendAndConfirmTransaction(c, tx, [payer], {
        commitment: "confirmed",
      });
      const after = await walletBalances(
        c,
        await loadPool(c, pool),
        payer.publicKey,
      );
      expect(after[0] - before[0] >= q.limitA).eq(true);
      expect(after[1] - before[1] >= q.limitB).eq(true);
      expect(before[2] - after[2]).eq(q.lp);
      evidence.push({
        operation: "withdraw",
        signature,
        before: before.map(String),
        after: after.map(String),
      });
      console.log("Devnet withdrawal:", signature);
    });
    it("rejects insufficient wallet assets and stale quotes before signature", async () => {
      const snapshot = await loadPool(c, pool),
        q = quoteDeposit(snapshot, 1_000_000n, 50);
      q.createdAt -= 61000;
      try {
        await buildLiquidityTransaction(c, payer.publicKey, q);
        throw Error("Expected rejection");
      } catch (e) {
        expect(String(e)).include("старше 60");
      }
      const huge = quoteDeposit(snapshot, 1_000_000_000_000n, 50);
      try {
        await buildLiquidityTransaction(c, payer.publicKey, huge);
        throw Error("Expected rejection");
      } catch (e) {
        expect(String(e)).include("Недостаточно");
      }
    });
  },
);
