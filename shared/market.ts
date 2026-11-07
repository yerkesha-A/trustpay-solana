import { Buffer } from "buffer";
import BN from "bn.js";
import Decimal from "decimal.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import {
  PoolInfoLayout,
  ClmmConfigLayout,
  CpmmConfigInfoLayout,
  TickUtil,
  LiquidityMathUtil,
} from "@raydium-io/raydium-sdk-v2";
import { loadPool, checkSlippage, type Pool } from "./defi";
import { ensureTestNetwork, rpcRetry } from "./rpc";

const D = Decimal.clone({ precision: 70 });
const dec = (n: string | number | bigint) => new D(n.toString());
export const CLMM_DEVNET = new PublicKey(
  "DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH",
);
// Pool accounts are validated through Devnet RPC.
export const MARKET_POOLS = [
  {
    kind: "cpmm",
    address: "8biZWzVLXx9AC5N2c3mJjbeGLGMRJzuDksCSibnvHsB3",
    label: "CPMM · TrustPay",
  },
  {
    kind: "clmm",
    address: "14gmqbdnjAFyRi1Vg3B7Fe6JGMut4CjbABXY1HqfvJnk",
    label: "CLMM · публичный Devnet-пул",
  },
] as const;
const poolDisc = Buffer.from("f7ede3f5d7c3de46", "hex");
const configDisc = Buffer.from("daf42168cbcb2b6f", "hex");
export type AmmMarket = {
  kind: "cpmm";
  pool: Pool;
  feeRate: bigint;
  slot: number;
  readAt: number;
};
export type ClmmMarket = {
  kind: "clmm";
  address: PublicKey;
  state: ReturnType<typeof PoolInfoLayout.decode>;
  reserveA: bigint;
  reserveB: bigint;
  decimalsA: number;
  decimalsB: number;
  feeRate: number;
  price: string;
  slot: number;
  readAt: number;
};
export type Market = AmmMarket | ClmmMarket;
export async function loadAmmMarket(
  c: Connection,
  address: PublicKey,
): Promise<AmmMarket> {
  await ensureTestNetwork(c, "devnet");
  const pool = await rpcRetry(() => loadPool(c, address));
  const info = await rpcRetry(() => c.getAccountInfo(pool.state.configId));
  if (
    !info ||
    !info.owner.equals((await import("./defi")).RAYDIUM_DEVNET) ||
    info.data.length !== CpmmConfigInfoLayout.span ||
    !info.data.subarray(0, 8).equals(configDisc)
  )
    throw Error("Некорректный CPMM config.");
  const config = CpmmConfigInfoLayout.decode(info.data);
  const feeRate = BigInt(config.tradeFeeRate.toString());
  if (feeRate < 0n || feeRate >= 1_000_000n)
    throw Error("Некорректная комиссия пула.");
  if (pool.state.enableCreatorFee && !config.creatorFeeRate.isZero())
    throw Error(
      "Котировка пула с дополнительной creator fee не поддерживается.",
    );
  return {
    kind: "cpmm",
    pool,
    feeRate,
    slot: await rpcRetry(() => c.getSlot()),
    readAt: Date.now(),
  };
}
export async function loadClmmMarket(
  c: Connection,
  address: PublicKey,
): Promise<ClmmMarket> {
  await ensureTestNetwork(c, "devnet");
  const result = await rpcRetry(() =>
    c.getMultipleAccountsInfoAndContext([CLMM_DEVNET, address]),
  );
  const [program, account] = result.value;
  if (
    !program?.executable ||
    !account?.owner.equals(CLMM_DEVNET) ||
    account.data.length !== PoolInfoLayout.span ||
    !account.data.subarray(0, 8).equals(poolDisc)
  )
    throw Error("Адрес не является поддерживаемым Raydium CLMM Devnet-пулом.");
  const state = PoolInfoLayout.decode(account.data);
  const keys = [
    state.mintA,
    state.mintB,
    state.vaultA,
    state.vaultB,
    state.configId,
  ];
  const response = await rpcRetry(() =>
    c.getMultipleAccountsInfoAndContext(keys, {
      minContextSlot: result.context.slot,
    }),
  );
  if (response.value.some((a) => !a))
    throw Error("Не найдены mint, reserve или config CLMM.");
  const infos = response.value.map((a) => a!);
  if (infos.slice(0, 4).some((i) => !i.owner.equals(TOKEN_PROGRAM_ID)))
    throw Error(
      "CLMM-калькулятор поддерживает только classic SPL, без Token-2022 transfer fees.",
    );
  const ma = unpackMint(keys[0], infos[0]),
    mb = unpackMint(keys[1], infos[1]);
  const a = unpackAccount(keys[2], infos[2]),
    b = unpackAccount(keys[3], infos[3]);
  const cfg = infos[4];
  if (
    !cfg.owner.equals(CLMM_DEVNET) ||
    cfg.data.length !== ClmmConfigLayout.span ||
    !cfg.data.subarray(0, 8).equals(configDisc)
  )
    throw Error("Некорректный CLMM config.");
  const config = ClmmConfigLayout.decode(cfg.data);
  if (
    !a.owner.equals(address) ||
    !b.owner.equals(address) ||
    !a.mint.equals(state.mintA) ||
    !b.mint.equals(state.mintB) ||
    ma.decimals !== state.mintDecimalsA ||
    mb.decimals !== state.mintDecimalsB ||
    config.tickSpacing !== state.tickSpacing ||
    state.tickSpacing <= 0 ||
    state.sqrtPriceX64.lten(0) ||
    state.liquidity.isNeg() ||
    config.tradeFeeRate >= 1_000_000
  )
    throw Error("Нарушены связи CLMM mint/reserve/config.");
  for (const [vault, mint] of [
    [state.vaultA, state.mintA],
    [state.vaultB, state.mintB],
  ]) {
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool_vault"), address.toBuffer(), mint.toBuffer()],
      CLMM_DEVNET,
    );
    if (!vault.equals(expected)) throw Error("Некорректный CLMM vault PDA.");
  }
  return {
    kind: "clmm",
    address,
    state,
    reserveA: a.amount,
    reserveB: b.amount,
    decimalsA: ma.decimals,
    decimalsB: mb.decimals,
    feeRate: config.tradeFeeRate,
    price: dec(state.sqrtPriceX64.toString())
      .div(dec(2).pow(64))
      .pow(2)
      .mul(dec(10).pow(ma.decimals - mb.decimals))
      .toSignificantDigits(24)
      .toString(),
    slot: response.context.slot,
    readAt: Date.now(),
  };
}
export function ammSpot(pool: Pool, aToB = true): string {
  const a = aToB ? pool.reserveA : pool.reserveB,
    b = aToB ? pool.reserveB : pool.reserveA;
  if (a <= 0n || b <= 0n) throw Error("Пустой пул.");
  return dec(b)
    .div(dec(a))
    .mul(
      dec(10).pow(
        aToB
          ? pool.decimalsA - pool.decimalsB
          : pool.decimalsB - pool.decimalsA,
      ),
    )
    .toSignificantDigits(24)
    .toString();
}
export function ammQuote(
  market: AmmMarket,
  input: bigint,
  bps: number,
  aToB = true,
) {
  checkSlippage(bps);
  if (input <= 0n || input > (1n << 64n) - 1n)
    throw Error("Сумма вне диапазона u64.");
  if (market.pool.state.status & 4) throw Error("Обмены в пуле остановлены.");
  if (market.feeRate < 0n || market.feeRate >= 1_000_000n)
    throw Error("Некорректная комиссия.");
  const x = aToB ? market.pool.reserveA : market.pool.reserveB,
    y = aToB ? market.pool.reserveB : market.pool.reserveA;
  if (x <= 0n || y <= 0n) throw Error("Пустой пул.");
  const fee = (input * market.feeRate + 999999n) / 1000000n,
    net = input - fee;
  if (net <= 0n) throw Error("Сумма слишком мала после комиссии.");
  const output = (net * y) / (x + net),
    minimum = (output * BigInt(10000 - bps)) / 10000n;
  if (minimum <= 0n) throw Error("Сумма слишком мала для slippage-защиты.");
  const scale = dec(10).pow(
    aToB
      ? market.pool.decimalsA - market.pool.decimalsB
      : market.pool.decimalsB - market.pool.decimalsA,
  );
  const execution = dec(output).div(dec(input)).mul(scale);
  // Curve impact excludes fee, but includes conservative integer rounding.
  const impact = dec(1)
    .sub(
      dec(output)
        .div(dec(net))
        .div(dec(y).div(dec(x))),
    )
    .mul(100);
  return {
    input,
    fee,
    output,
    minimum,
    executionPrice: execution.toSignificantDigits(24).toString(),
    priceImpactPercent: impact.toSignificantDigits(12).toString(),
    spot: ammSpot(market.pool, aToB),
  };
}
export function clmmRange(
  m: ClmmMarket,
  lower: string,
  upper: string,
  budgetA: bigint,
  budgetB: bigint,
) {
  if (lower.length > 80 || upper.length > 80)
    throw Error("Слишком длинная цена.");
  let lo: Decimal, hi: Decimal;
  try {
    lo = dec(lower);
    hi = dec(upper);
  } catch {
    throw Error("Введите корректные цены.");
  }
  if (!lo.isFinite() || !hi.isFinite() || lo.lte(0) || hi.lte(lo))
    throw Error("Нужен диапазон 0 < нижняя цена < верхняя цена.");
  const spacing = m.state.tickSpacing;
  if (!Number.isInteger(spacing) || spacing <= 0)
    throw Error("Некорректный tick spacing.");
  const minTick = Math.ceil(-443636 / spacing) * spacing,
    maxTick = Math.floor(443636 / spacing) * spacing;
  const minPrice = TickUtil.tickToPrice(minTick, m.decimalsA, m.decimalsB),
    maxPrice = TickUtil.tickToPrice(maxTick, m.decimalsA, m.decimalsB);
  if (lo.lt(minPrice) || hi.gt(maxPrice))
    throw Error("Цена вне допустимых ticks протокола.");
  const tickLower =
    Math.floor(TickUtil.priceToTick(lo, m.decimalsA, m.decimalsB) / spacing) *
    spacing;
  const tickUpper =
    Math.ceil(TickUtil.priceToTick(hi, m.decimalsA, m.decimalsB) / spacing) *
    spacing;
  if (tickLower < minTick || tickUpper > maxTick || tickLower >= tickUpper)
    throw Error("Диапазон не содержит допустимых ticks.");
  const max = (1n << 64n) - 1n;
  if (
    budgetA < 0n ||
    budgetB < 0n ||
    budgetA > max ||
    budgetB > max ||
    budgetA + budgetB === 0n
  )
    throw Error("Задайте ненулевой бюджет A/B в пределах u64.");
  const sqrtLo = TickUtil.getSqrtPriceAtTick(tickLower),
    sqrtHi = TickUtil.getSqrtPriceAtTick(tickUpper),
    current = m.state.sqrtPriceX64;
  const liquidity = LiquidityMathUtil.getLiquidityFromAmounts(
    current,
    sqrtLo,
    sqrtHi,
    new BN(budgetA.toString()),
    new BN(budgetB.toString()),
  );
  if (liquidity.isZero() || liquidity.bitLength() > 128)
    throw Error(
      "Бюджета недостаточно для выбранного диапазона или liquidity превышает u128.",
    );
  const amounts = LiquidityMathUtil.getAmountsForLiquidity(
    current,
    sqrtLo,
    sqrtHi,
    liquidity,
    true,
  );
  const amountA = BigInt(amounts.amountA.toString()),
    amountB = BigInt(amounts.amountB.toString());
  if (amountA > budgetA || amountB > budgetB)
    throw Error(
      "Округление превысило бюджет. Увеличьте бюджет на минимальную единицу.",
    );
  const active = current.gte(sqrtLo) && current.lt(sqrtHi);
  const potentialShare = active
    ? dec(liquidity.toString())
        .div(dec(m.state.liquidity.toString()).add(liquidity.toString()))
        .mul(100)
        .toSignificantDigits(12)
        .toString()
    : "0";
  return {
    tickLower,
    tickUpper,
    lowerPrice: TickUtil.tickToPrice(tickLower, m.decimalsA, m.decimalsB)
      .toSignificantDigits(24)
      .toString(),
    upperPrice: TickUtil.tickToPrice(tickUpper, m.decimalsA, m.decimalsB)
      .toSignificantDigits(24)
      .toString(),
    liquidity: liquidity.toString(),
    amountA,
    amountB,
    unusedA: budgetA - amountA,
    unusedB: budgetB - amountB,
    active,
    potentialSharePercent: potentialShare,
  };
}
