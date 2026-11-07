import { expect } from "chai";
import { PublicKey, Connection } from "@solana/web3.js";
import {
  assertDevnet,
  parseUnits,
  formatUnits,
  quoteDeposit,
  quoteWithdraw,
  type Pool,
} from "../shared/defi";
const pool = {
  address: PublicKey.default,
  state: { status: 0 },
  reserveA: 1_000_000_003n,
  reserveB: 2_000_000_007n,
  supply: 1_000_000_000n,
  decimalsA: 6,
  decimalsB: 6,
  decimalsLp: 9,
} as Pool;
describe("Week09 liquidity arithmetic and network guards (no protocol simulation)", () => {
  it("parses token amounts exactly beyond Number precision", () => {
    expect(parseUnits("18446744073.709551615", 9)).eq(18446744073709551615n);
    expect(formatUnits(1234567890123456789n, 9)).eq("1234567890.123456789");
  });
  it("rejects zero, negative, exponent, extra decimals, u64 overflow", () => {
    for (const v of ["0", "-1", "1e3", "1.0000001", "18446744073709551616"])
      expect(() => parseUnits(v, 6)).to.throw();
  });
  it("deposit rounds required reserves up and caps maximum spending", () => {
    const q = quoteDeposit(pool, 1_000_000n, 50);
    expect(q.lp).eq(999999n);
    expect(q.amountA).eq(1_000_000n);
    expect(q.amountB).eq(1_999_999n);
    expect(q.limitA >= q.amountA && q.limitB >= q.amountB).eq(true);
    expect(q.limitA).eq(1_005_000n);
  });
  it("withdraw rounds receipts down and enforces nonzero minimums", () => {
    const q = quoteWithdraw(pool, 1_000_000n, 50);
    expect(q.amountA).eq(1_000_000n);
    expect(q.amountB).eq(2_000_000n);
    expect(q.limitA).eq(995_000n);
    expect(q.limitB).eq(1_990_000n);
  });
  it("rejects dust, disabled operations and invalid slippage", () => {
    expect(() => quoteDeposit(pool, 0n, 50)).to.throw();
    expect(() => quoteWithdraw(pool, 1n, 50)).to.throw();
    expect(() => quoteWithdraw(pool, pool.supply + 1n, 50)).to.throw();
    for (const bps of [0, 501, 1.5, NaN])
      expect(() => quoteDeposit(pool, 100n, bps)).to.throw();
    expect(() =>
      quoteDeposit({ ...pool, state: { ...pool.state, status: 1 } }, 100n, 50),
    ).to.throw();
    expect(() =>
      quoteWithdraw({ ...pool, state: { ...pool.state, status: 2 } }, 100n, 50),
    ).to.throw();
  });
  it("rejects Mainnet genesis before reading protocol accounts", async () => {
    let read = false;
    const c = {
      getGenesisHash: async () =>
        "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      getAccountInfo: async () => {
        read = true;
        return null;
      },
    } as unknown as Connection;
    try {
      await assertDevnet(c);
      throw Error("Guard failed");
    } catch (e) {
      expect(String(e)).include("настоящей Solana Devnet");
    }
    expect(read).eq(false);
  });
});
