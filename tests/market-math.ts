import { expect } from "chai";
import BN from "bn.js";
import Decimal from "decimal.js";
import { PublicKey } from "@solana/web3.js";
import { TickUtil, CurveCalculator } from "@raydium-io/raydium-sdk-v2";
import {
  ammQuote,
  ammSpot,
  clmmRange,
  type AmmMarket,
  type ClmmMarket,
} from "../shared/market";
import type { Pool } from "../shared/defi";
const market = {
  kind: "cpmm",
  feeRate: 0n,
  pool: {
    reserveA: 1000n,
    reserveB: 1000n,
    decimalsA: 0,
    decimalsB: 0,
    state: { status: 0 },
  } as Pool,
} as AmmMarket;
const clmm = (tick = 0, decimalsA = 6, decimalsB = 6) =>
  ({
    kind: "clmm",
    decimalsA,
    decimalsB,
    state: {
      tickSpacing: 60,
      sqrtPriceX64: TickUtil.getSqrtPriceAtTick(tick),
      liquidity: new BN("1000000000"),
    },
  }) as ClmmMarket;
describe("Week11 market math (pure calculations, not blockchain evidence)", () => {
  it("computes constant-product output and slippage with conservative integer rounding", () => {
    const q = ammQuote(market, 100n, 100);
    expect(q.output).eq(90n);
    expect(q.minimum).eq(89n);
    expect(q.executionPrice).eq("0.9");
    expect(q.priceImpactPercent).eq("10");
    expect(q.fee).eq(0n);
  });
  it("matches the pinned Raydium SDK fee and curve for both directions", () => {
    const m = {
      ...market,
      feeRate: 2500n,
      pool: {
        ...market.pool,
        reserveA: 100000000003n,
        reserveB: 250000000007n,
      },
    };
    for (const direction of [true, false]) {
      const q = ammQuote(m, 123456789n, 50, direction);
      const expected = CurveCalculator.swapBaseInput(
        new BN("123456789"),
        new BN((direction ? m.pool.reserveA : m.pool.reserveB).toString()),
        new BN((direction ? m.pool.reserveB : m.pool.reserveA).toString()),
        new BN(2500),
        new BN(0),
        new BN(0),
        new BN(0),
        true,
      );
      expect(q.output.toString()).eq(expected.outputAmount.toString());
      expect(q.fee.toString()).eq(expected.tradeFee.toString());
    }
  });
  it("normalizes unequal decimals and reverses the quoted units", () => {
    const p = {
      ...market.pool,
      reserveA: 1_000_000n,
      reserveB: 2_000_000_000n,
      decimalsA: 6,
      decimalsB: 9,
    };
    expect(ammSpot(p)).eq("2");
    expect(ammSpot(p, false)).eq("0.5");
  });
  it("keeps u64 amounts exact and rejects dust, invalid bps, empty and paused pools", () => {
    expect(
      ammQuote(
        {
          ...market,
          pool: { ...market.pool, reserveA: 1n << 63n, reserveB: 1n << 63n },
        },
        9007199254740993n,
        50,
      ).output > 0n,
    ).eq(true);
    for (const v of [0n, -1n, 1n << 64n])
      expect(() => ammQuote(market, v, 50)).to.throw();
    for (const b of [0, 501, NaN, 1.1])
      expect(() => ammQuote(market, 100n, b)).to.throw();
    expect(() => ammQuote({ ...market, feeRate: 2500n }, 1n, 50)).to.throw();
    expect(() =>
      ammQuote({ ...market, pool: { ...market.pool, reserveA: 0n } }, 100n, 50),
    ).to.throw();
    expect(() =>
      ammQuote(
        {
          ...market,
          pool: { ...market.pool, state: { ...market.pool.state, status: 4 } },
        },
        100n,
        50,
      ),
    ).to.throw();
  });
  it("matches the independent Q64 amount equations inside an aligned range", () => {
    const m = clmm(),
      lo = TickUtil.tickToPrice(-600, m.decimalsA, m.decimalsB).toString(),
      hi = TickUtil.tickToPrice(600, m.decimalsA, m.decimalsB).toString();
    const q = clmmRange(m, lo, hi, 100000000n, 100000000n),
      Q = 1n << 64n,
      L = BigInt(q.liquidity),
      a = BigInt(TickUtil.getSqrtPriceAtTick(q.tickLower).toString()),
      b = BigInt(TickUtil.getSqrtPriceAtTick(q.tickUpper).toString()),
      ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
    expect(q.amountA).eq(ceil(L * (b - Q) * Q, Q * b));
    expect(q.amountB).eq(ceil(L * (Q - a), Q));
    expect(q.amountA <= 100000000n && q.amountB <= 100000000n).eq(true);
    expect(q.active).eq(true);
    expect(Number(q.potentialSharePercent)).closeTo(
      (Number(L) / (1e9 + Number(L))) * 100,
      1e-9,
    );
  });
  it("uses only A below range and only B above, without claiming active share", () => {
    const below = clmmRange(clmm(-1200), "0.99", "1.01", 100000000n, 0n);
    expect(below.amountA > 0n).eq(true);
    expect(below.amountB).eq(0n);
    expect(below.active).eq(false);
    expect(below.potentialSharePercent).eq("0");
    const above = clmmRange(clmm(1200), "0.99", "1.01", 0n, 100000000n);
    expect(above.amountA).eq(0n);
    expect(above.amountB > 0n).eq(true);
    expect(above.active).eq(false);
  });
  it("treats lower tick as active and upper tick as inactive", () => {
    const first = clmmRange(clmm(), "0.99", "1.01", 100000000n, 100000000n);
    const low = clmmRange(
      clmm(first.tickLower),
      first.lowerPrice,
      first.upperPrice,
      100000000n,
      100000000n,
    );
    const high = clmmRange(
      clmm(first.tickUpper),
      first.lowerPrice,
      first.upperPrice,
      100000000n,
      100000000n,
    );
    expect(low.active).eq(true);
    expect(high.active).eq(false);
  });
  it("aligns ticks outward, handles unequal decimals, and leaves unused budget", () => {
    const q = clmmRange(clmm(0, 9, 6), "990", "1010", 1000000000n, 2000000n);
    expect(q.tickLower % 60).eq(0);
    expect(q.tickUpper % 60).eq(0);
    expect(new Decimal(q.lowerPrice).lte(990)).eq(true);
    expect(new Decimal(q.upperPrice).gte(1010)).eq(true);
    expect(q.unusedA > 0n || q.unusedB > 0n).eq(true);
  });
  it("rejects reversed, nonfinite, zero, out-of-protocol ranges and invalid budgets", () => {
    for (const [a, b] of [
      ["1", "1"],
      ["2", "1"],
      ["0", "1"],
      ["-1", "1"],
      ["NaN", "1"],
      ["1", "Infinity"],
      ["abc", "2"],
      ["1e-100", "1"],
      ["1", "1e100"],
    ])
      expect(() => clmmRange(clmm(), a, b, 1000000n, 1000000n)).to.throw();
    for (const [a, b] of [
      [0n, 0n],
      [-1n, 1n],
      [1n << 64n, 1n],
    ])
      expect(() => clmmRange(clmm(), "0.99", "1.01", a, b)).to.throw();
    expect(() => clmmRange(clmm(), "0.99", "1.01", 1000000n, 0n)).to.throw();
  });
});
