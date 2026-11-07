import { Buffer } from "buffer";
import BN from "bn.js";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import {
  CpmmPoolInfoLayout,
  makeDepositCpmmInInstruction,
  makeWithdrawCpmmInInstruction,
  getPdaPoolAuthority,
} from "@raydium-io/raydium-sdk-v2";

// Raydium CPMM Devnet program.
export const RAYDIUM_DEVNET = new PublicKey(
  "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
);
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const POOL_DISCRIMINATOR = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]);
const MAX_U64 = (1n << 64n) - 1n;
const bn = (value: bigint) => new BN(value.toString());
export function parseUnits(value: string, decimals: number): bigint {
  if (value.length > 80 || !/^\d+(\.\d+)?$/.test(value))
    throw Error("Введите положительное число без экспоненты.");
  const [whole, fractional = ""] = value.split(".");
  if (fractional.length > decimals)
    throw Error(`Максимум ${decimals} знаков после точки.`);
  const result =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fractional.padEnd(decimals, "0") || "0");
  if (result <= 0n || result > MAX_U64) throw Error("Сумма вне диапазона u64.");
  return result;
}
export function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const fraction = (value % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${value / base}${decimals && fraction ? "." + fraction : ""}`;
}
export function checkSlippage(bps: number) {
  if (!Number.isInteger(bps) || bps < 1 || bps > 500)
    throw Error("Slippage: от 1 до 500 bps.");
}
export type Pool = {
  address: PublicKey;
  state: ReturnType<typeof CpmmPoolInfoLayout.decode>;
  reserveA: bigint;
  reserveB: bigint;
  supply: bigint;
  decimalsA: number;
  decimalsB: number;
  decimalsLp: number;
};
export async function assertDevnet(connection: Connection) {
  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS)
    throw Error("DeFi разрешён только на настоящей Solana Devnet.");
  const program = await connection.getAccountInfo(RAYDIUM_DEVNET);
  if (!program?.executable)
    throw Error("Raydium CPMM не развёрнут в выбранной сети.");
}
export async function loadPool(
  connection: Connection,
  address: PublicKey,
  localFixture = false,
): Promise<Pool> {
  if (localFixture) {
    if (
      !["localhost", "127.0.0.1"].includes(
        new URL(connection.rpcEndpoint).hostname,
      )
    )
      throw Error("Fixture разрешён только на localhost.");
  } else await assertDevnet(connection);
  const account = await connection.getAccountInfo(address);
  if (
    !account ||
    !account.owner.equals(RAYDIUM_DEVNET) ||
    account.data.length !== CpmmPoolInfoLayout.span ||
    !account.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)
  )
    throw Error("Адрес не является пулом Raydium CPMM Devnet.");
  const state = CpmmPoolInfoLayout.decode(account.data);
  if (
    !state.mintProgramA.equals(TOKEN_PROGRAM_ID) ||
    !state.mintProgramB.equals(TOKEN_PROGRAM_ID)
  )
    throw Error("Поддерживаются только классические SPL-токены.");
  const addresses = [
    state.vaultA,
    state.vaultB,
    state.mintA,
    state.mintB,
    state.mintLp,
  ];
  const infos = await connection.getMultipleAccountsInfo(addresses);
  if (infos.some((info) => !info))
    throw Error("Не найдены vault или mint пула.");
  const a = unpackAccount(state.vaultA, infos[0]!),
    b = unpackAccount(state.vaultB, infos[1]!);
  const ma = unpackMint(state.mintA, infos[2]!),
    mb = unpackMint(state.mintB, infos[3]!),
    lp = unpackMint(state.mintLp, infos[4]!);
  const authority = getPdaPoolAuthority(RAYDIUM_DEVNET).publicKey;
  if (
    !a.mint.equals(state.mintA) ||
    !b.mint.equals(state.mintB) ||
    !a.owner.equals(authority) ||
    !b.owner.equals(authority) ||
    !lp.mintAuthority?.equals(authority)
  )
    throw Error("Некорректные vault или LP mint.");
  const reserveA =
    a.amount -
    BigInt(state.protocolFeesMintA.toString()) -
    BigInt(state.fundFeesMintA.toString()) -
    BigInt(state.creatorFeesMintA.toString());
  const reserveB =
    b.amount -
    BigInt(state.protocolFeesMintB.toString()) -
    BigInt(state.fundFeesMintB.toString()) -
    BigInt(state.creatorFeesMintB.toString());
  const supply = BigInt(state.lpAmount.toString());
  if (reserveA <= 0n || reserveB <= 0n || supply <= 0n)
    throw Error("Пул не имеет доступной ликвидности.");
  return {
    address,
    state,
    reserveA,
    reserveB,
    supply,
    decimalsA: ma.decimals,
    decimalsB: mb.decimals,
    decimalsLp: lp.decimals,
  };
}
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
export type Quote = {
  kind: "deposit" | "withdraw";
  lp: bigint;
  amountA: bigint;
  amountB: bigint;
  limitA: bigint;
  limitB: bigint;
  pool: Pool;
  createdAt: number;
};
export function quoteDeposit(
  pool: Pool,
  amountA: bigint,
  slippageBps: number,
): Quote {
  checkSlippage(slippageBps);
  if (amountA <= 0n || amountA > MAX_U64) throw Error("Некорректная сумма.");
  if (pool.state.status & 1) throw Error("Депозиты в этот пул остановлены.");
  const lp = (amountA * pool.supply) / pool.reserveA;
  if (lp <= 0n) throw Error("Сумма слишком мала для выпуска LP.");
  const a = ceil(lp * pool.reserveA, pool.supply),
    b = ceil(lp * pool.reserveB, pool.supply);
  const limitA = ceil(a * BigInt(10000 + slippageBps), 10000n),
    limitB = ceil(b * BigInt(10000 + slippageBps), 10000n);
  if ([lp, limitA, limitB].some((n) => n > MAX_U64))
    throw Error("Quote превышает u64.");
  return {
    kind: "deposit",
    lp,
    amountA: a,
    amountB: b,
    limitA,
    limitB,
    pool,
    createdAt: Date.now(),
  };
}
export function quoteWithdraw(
  pool: Pool,
  lp: bigint,
  slippageBps: number,
): Quote {
  checkSlippage(slippageBps);
  if (pool.state.status & 2) throw Error("Вывод из этого пула остановлен.");
  if (lp <= 0n || lp > pool.supply || lp > MAX_U64)
    throw Error("Некорректное количество LP.");
  const a = (lp * pool.reserveA) / pool.supply,
    b = (lp * pool.reserveB) / pool.supply;
  const limitA = (a * BigInt(10000 - slippageBps)) / 10000n,
    limitB = (b * BigInt(10000 - slippageBps)) / 10000n;
  if (limitA <= 0n || limitB <= 0n)
    throw Error("Сумма слишком мала для защищённого вывода.");
  return {
    kind: "withdraw",
    lp,
    amountA: a,
    amountB: b,
    limitA,
    limitB,
    pool,
    createdAt: Date.now(),
  };
}
export async function walletBalances(
  connection: Connection,
  pool: Pool,
  owner: PublicKey,
) {
  const mints = [pool.state.mintA, pool.state.mintB, pool.state.mintLp];
  const addresses = mints.map((m) => getAssociatedTokenAddressSync(m, owner));
  const infos = await connection.getMultipleAccountsInfo(addresses);
  return infos.map((info, i) =>
    info ? unpackAccount(addresses[i], info).amount : 0n,
  );
}
export async function buildLiquidityTransaction(
  connection: Connection,
  owner: PublicKey,
  quote: Quote,
  localFixture = false,
): Promise<Transaction> {
  if (!localFixture) await assertDevnet(connection);
  else if (
    !["localhost", "127.0.0.1"].includes(
      new URL(connection.rpcEndpoint).hostname,
    )
  )
    throw Error("Fixture разрешён только на localhost.");
  if (Date.now() - quote.createdAt > 60000)
    throw Error("Quote старше 60 секунд. Рассчитайте заново.");
  const { pool, lp, limitA, limitB } = quote;
  const balances = await walletBalances(connection, pool, owner);
  if (
    quote.kind === "deposit" &&
    (balances[0] < limitA || balances[1] < limitB)
  )
    throw Error("Недостаточно свободных токенов кошелька с учётом slippage.");
  if (quote.kind === "withdraw" && balances[2] < lp)
    throw Error("Недостаточно LP-токенов кошелька.");
  const s = pool.state;
  const [userA, userB, userLp] = [s.mintA, s.mintB, s.mintLp].map((m) =>
    getAssociatedTokenAddressSync(m, owner),
  );
  const tx = new Transaction();
  // Use wallet ATAs, not escrow accounts.
  for (const [ata, mint] of [
    [userA, s.mintA],
    [userB, s.mintB],
    [userLp, s.mintLp],
  ])
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ata,
        owner,
        mint,
      ),
    );
  const make =
    quote.kind === "deposit"
      ? makeDepositCpmmInInstruction
      : makeWithdrawCpmmInInstruction;
  tx.add(
    make(
      RAYDIUM_DEVNET,
      owner,
      getPdaPoolAuthority(RAYDIUM_DEVNET).publicKey,
      pool.address,
      userLp,
      userA,
      userB,
      s.vaultA,
      s.vaultB,
      s.mintA,
      s.mintB,
      s.mintLp,
      bn(lp),
      bn(limitA),
      bn(limitB),
    ),
  );
  tx.feePayer = owner;
  tx.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;
  return tx;
}
