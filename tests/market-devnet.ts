import { expect } from "chai";
import { writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { unpackAccount, getMint } from "@solana/spl-token";
import {
  MARKET_POOLS,
  CLMM_DEVNET,
  loadAmmMarket,
  loadClmmMarket,
  ammQuote,
  clmmRange,
} from "../shared/market";
import { fetchWalletSnapshot } from "../shared/rpc";
const enabled = process.env.TRUSTPAY_WEEK11_DEVNET === "1";
(enabled ? describe : describe.skip)(
  "Week11 REAL Devnet AMM/CLMM RPC (read-only)",
  function () {
    this.timeout(180000);
    const c = new Connection("https://api.devnet.solana.com", {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetch: require("../scripts/devnet-fetch.cjs"),
    });
    const evidence: Record<string, unknown> = {
      network: "devnet",
      verifiedAt: new Date().toISOString(),
      transactionsSent: 0,
    };
    after(() => {
      writeFileSync(
        "docs/week11-devnet-evidence.json",
        JSON.stringify(
          evidence,
          (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
          2,
        ) + "\n",
      );
    });
    it("loads the existing real CPMM, on-chain fee and both reserve directions", async () => {
      const market = await loadAmmMarket(
        c,
        new PublicKey(MARKET_POOLS[0].address),
      );
      expect(market.pool.reserveA > 0n && market.pool.reserveB > 0n).eq(true);
      const forward = ammQuote(market, 1_000_000n, 50),
        reverse = ammQuote(market, 1_000_000n, 50, false);
      expect(forward.minimum > 0n && reverse.minimum > 0n).eq(true);
      evidence.cpmm = {
        address: market.pool.address.toBase58(),
        mintA: market.pool.state.mintA.toBase58(),
        mintB: market.pool.state.mintB.toBase58(),
        reserveA: market.pool.reserveA.toString(),
        reserveB: market.pool.reserveB.toString(),
        feeRateMillionths: market.feeRate.toString(),
        slot: market.slot,
        forward,
        reverse,
      };
    });
    it("validates a live CLMM and computes a tick-aligned budget from its real sqrt price", async () => {
      const market = await loadClmmMarket(
        c,
        new PublicKey(MARKET_POOLS[1].address),
      );
      expect(market.state.liquidity.gtn(0)).eq(true);
      const Decimal = require("decimal.js");
      const lo = new Decimal(market.price).mul("0.9").toString(),
        hi = new Decimal(market.price).mul("1.1").toString();
      const range = clmmRange(
        market,
        lo,
        hi,
        10n ** BigInt(market.decimalsA),
        10n ** BigInt(market.decimalsB),
      );
      expect(range.active).eq(true);
      expect(range.amountA > 0n && range.amountB > 0n).eq(true);
      const owner = new PublicKey(
        "8uctBg6jVu2Y1bTKojWjn1K3dSkBGXGVRCxXPyF9DnMM",
      );
      const balances = [];
      for (const mint of [market.state.mintA, market.state.mintB]) {
        const rows = await c.getTokenAccountsByOwner(owner, { mint });
        balances.push(
          rows.value.reduce(
            (s, row) => s + unpackAccount(row.pubkey, row.account).amount,
            0n,
          ),
        );
      }
      const mintBInfo = await getMint(c, market.state.mintB);
      expect(mintBInfo.mintAuthority?.equals(owner) || false).eq(false);
      evidence.clmm = {
        mintBAuthority: mintBInfo.mintAuthority?.toBase58() || null,
        projectControlsMintB: false,
        program: CLMM_DEVNET.toBase58(),
        address: market.address.toBase58(),
        config: market.state.configId.toBase58(),
        mintA: market.state.mintA.toBase58(),
        mintB: market.state.mintB.toBase58(),
        vaultA: market.state.vaultA.toBase58(),
        vaultB: market.state.vaultB.toBase58(),
        reserveA: market.reserveA.toString(),
        reserveB: market.reserveB.toString(),
        liquidity: market.state.liquidity.toString(),
        sqrtPriceX64: market.state.sqrtPriceX64.toString(),
        tickCurrent: market.state.tickCurrent,
        tickSpacing: market.state.tickSpacing,
        price: market.price,
        feeRateMillionths: market.feeRate,
        slot: market.slot,
        range,
        projectWalletTokenBalances: balances.map((v) => v.toString()),
        positionOpened: false,
        limitation:
          "Read-only integration and range calculations. Project wallet has no funded pair for an in-range position; open/close position path is not implemented or claimed tested.",
      };
      const wallet = await fetchWalletSnapshot(c, owner);
      expect(wallet.solLamports !== null).eq(true);
      evidence.wallet = {
        address: owner.toBase58(),
        solLamports: wallet.solLamports?.toString(),
        warnings: wallet.warnings,
      };
    });
    it("rejects a genuine CPMM account supplied as a CLMM pool", async () => {
      try {
        await loadClmmMarket(c, new PublicKey(MARKET_POOLS[0].address));
        throw Error("Expected rejection");
      } catch (e) {
        expect(String(e)).include("не является");
      }
      evidence.wrongProtocolRejected = true;
    });
  },
);
