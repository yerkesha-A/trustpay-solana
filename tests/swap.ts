import { expect } from "chai";
import { Keypair, Connection } from "@solana/web3.js";
import { quoteSwap, validateSwapApproval, swapBalances } from "../shared/swap";
import type { AmmMarket } from "../shared/market";
const owner = Keypair.generate().publicKey;
const a = Keypair.generate().publicKey, b = Keypair.generate().publicKey;
const market = () => ({ kind: "cpmm", feeRate: 2500n, readAt: Date.now(), pool: {
  reserveA: 1000000n, reserveB: 2000000n, decimalsA: 6, decimalsB: 6,
  state: { status: 0, mintA: a, mintB: b },
} }) as AmmMarket;
describe("Week12 swap approval regressions (no funds or lab)", () => {
  it("quotes both directions with bounded minimum received", () => {
    const m = market();
    for (const mint of [a,b]) {
      const q = quoteSwap(m, owner, mint, 10000n, 50);
      expect(q.output > q.minimum && q.minimum > 0n).eq(true);
      expect(q.outputMint.equals(mint.equals(a) ? b : a)).eq(true);
      validateSwapApproval(q, owner);
    }
  });
  it("rejects another signer, modified limits, output mint and direction", () => {
    const q = quoteSwap(market(), owner, a, 10000n, 50);
    expect(() => validateSwapApproval(q, Keypair.generate().publicKey)).to.throw("другому кошельку");
    for (const edited of [{...q, minimum: 1n}, {...q, output: 1n}, {...q, outputMint:a}, {...q, aToB:false}])
      expect(() => validateSwapApproval(edited, owner)).to.throw("изменена");
  });
  it("rejects expired, future, invalid timestamps and unrelated input mints", () => {
    const q = quoteSwap(market(), owner, a, 10000n, 50);
    expect(() => validateSwapApproval(q, owner, q.createdAt + 30001)).to.throw("устарела");
    expect(() => validateSwapApproval(q, owner, q.createdAt - 1)).to.throw("устарела");
    expect(() => validateSwapApproval({...q, createdAt:NaN}, owner)).to.throw("устарела");
    expect(() => quoteSwap(market(), owner, owner, 10000n, 50)).to.throw("не принадлежит");
  });
  it("treats absent wallet ATAs as zero without using escrow accounts", async () => {
    const c = { getMultipleAccountsInfo: async (keys: unknown[]) => { expect(keys.length).eq(2); return [null,null]; } } as unknown as Connection;
    expect(await swapBalances(c, market(), owner)).deep.eq([0n,0n]);
  });
});
