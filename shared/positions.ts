import { Buffer } from "buffer";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount, getAccount, getMint, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { ClmmInstrument, PersonalPositionLayout, TickUtil, TickArrayUtil, LiquidityMathUtil, getPdaPoolId, getPdaTickArrayAddress, getPdaProtocolPositionAddress, getPdaPersonalPositionAddress, getPdaMetadataKey, getPdaExBitmapAccount } from "@raydium-io/raydium-sdk-v2";
import { CLMM_DEVNET, loadClmmMarket, clmmRange, type ClmmMarket } from "./market";
import { checkSlippage } from "./defi";
import { week13Transaction } from "./transactions";
import { ensureTestNetwork } from "./rpc";
export type Position = {
    address: PublicKey;
    nftMint: PublicKey;
    state: ReturnType<typeof PersonalPositionLayout.decode>;
    owner: PublicKey;
};
export type PositionQuote = {
    owner: PublicKey;
    pool: PublicKey;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    amountA: bigint;
    amountB: bigint;
    limitA: bigint;
    limitB: bigint;
    bps: number;
    createdAt: number;
    kind: "add" | "remove";
    position?: PublicKey;
};
const bn = (value: bigint) => new BN(value.toString());
export async function positionMarket(c: Connection, address: PublicKey) {
    const m = await loadClmmMarket(c, address);
    if (!getPdaPoolId(CLMM_DEVNET, m.state.configId, m.state.mintA, m.state.mintB).publicKey.equals(address))
        throw Error("Некорректный CLMM pool PDA.");
    if (m.state.rewardInfos.some(r => !r.mint.equals(PublicKey.default)))
        throw Error("Управление пулами с reward mint пока не поддерживается.");
    return m;
}
export function validateTicks(lower: number, upper: number, spacing: number) {
    if (!Number.isInteger(lower) || !Number.isInteger(upper) || lower >= upper || lower < -443636 || upper > 443636 || !Number.isInteger(spacing) || spacing <= 0 || lower % spacing !== 0 || upper % spacing !== 0)
        throw Error("Некорректный tick range.");
}
export function liquidityAmounts(m: ClmmMarket, lower: number, upper: number, liquidity: bigint, roundUp: boolean) {
    validateTicks(lower, upper, m.state.tickSpacing);
    if (liquidity < 0n || liquidity >= (1n << 128n))
        throw Error("Liquidity вне u128.");
    const amounts = LiquidityMathUtil.getAmountsForLiquidity(m.state.sqrtPriceX64, TickUtil.getSqrtPriceAtTick(lower), TickUtil.getSqrtPriceAtTick(upper), bn(liquidity), roundUp);
    return { amountA: BigInt(amounts.amountA.toString()), amountB: BigInt(amounts.amountB.toString()) };
}
export function quotePositionAddTicks(m: ClmmMarket, owner: PublicKey, tickLower: number, tickUpper: number, budgetA: bigint, budgetB: bigint, bps: number, position?: PublicKey): PositionQuote {
    checkSlippage(bps);
    validateTicks(tickLower, tickUpper, m.state.tickSpacing);
    if (budgetA < 0n || budgetB < 0n || budgetA >= (1n << 64n) || budgetB >= (1n << 64n) || budgetA + budgetB === 0n)
        throw Error("Некорректный бюджет A/B.");
    const liquidity = BigInt(LiquidityMathUtil.getLiquidityFromAmounts(m.state.sqrtPriceX64, TickUtil.getSqrtPriceAtTick(tickLower), TickUtil.getSqrtPriceAtTick(tickUpper), bn(budgetA * 10000n / BigInt(10000 + bps)), bn(budgetB * 10000n / BigInt(10000 + bps))).toString());
    if (liquidity === 0n)
        throw Error("Бюджета недостаточно для диапазона.");
    const { amountA, amountB } = liquidityAmounts(m, tickLower, tickUpper, liquidity, true);
    const limitA = (amountA * BigInt(10000 + bps) + 9999n) / 10000n, limitB = (amountB * BigInt(10000 + bps) + 9999n) / 10000n;
    if (limitA > budgetA || limitB > budgetB || limitA >= (1n << 64n) || limitB >= (1n << 64n))
        throw Error("Лимиты превышают бюджет/u64.");
    return { owner, pool: m.address, tickLower, tickUpper, liquidity, amountA, amountB, limitA, limitB, bps, createdAt: Date.now(), kind: "add", position };
}
export function quotePositionAdd(m: ClmmMarket, owner: PublicKey, lower: string, upper: string, budgetA: bigint, budgetB: bigint, bps: number, position?: PublicKey): PositionQuote {
    checkSlippage(bps);
    const range = clmmRange(m, lower, upper, budgetA, budgetB);
    return quotePositionAddTicks(m, owner, range.tickLower, range.tickUpper, budgetA, budgetB, bps, position);
}
export function quotePositionIncrease(m: ClmmMarket, p: Position, budgetA: bigint, budgetB: bigint, bps: number) {
    if (!p.state.poolId.equals(m.address))
        throw Error("Позиция другого пула.");
    return quotePositionAddTicks(m, p.owner, p.state.tickLower, p.state.tickUpper, budgetA, budgetB, bps, p.nftMint);
}
export function quotePositionRemove(m: ClmmMarket, p: Position, liquidity: bigint, bps: number): PositionQuote {
    checkSlippage(bps);
    if (!p.state.poolId.equals(m.address))
        throw Error("Позиция другого пула.");
    if (liquidity < 0n || liquidity > BigInt(p.state.liquidity.toString()))
        throw Error("Недостаточно liquidity позиции.");
    const amounts = liquidityAmounts(m, p.state.tickLower, p.state.tickUpper, liquidity, false);
    const limitA = amounts.amountA * BigInt(10000 - bps) / 10000n, limitB = amounts.amountB * BigInt(10000 - bps) / 10000n;
    if (liquidity > 0n && limitA + limitB === 0n)
        throw Error("Слишком маленький вывод.");
    return { owner: p.owner, pool: m.address, tickLower: p.state.tickLower, tickUpper: p.state.tickUpper, liquidity, ...amounts, limitA, limitB, bps, createdAt: Date.now(), kind: "remove", position: p.nftMint };
}
export function validatePositionQuote(q: PositionQuote, owner: PublicKey, now = Date.now()) {
    if (!owner.equals(q.owner))
        throw Error("Quote другого кошелька.");
    if (!Number.isFinite(q.createdAt) || now < q.createdAt || now - q.createdAt > 30000)
        throw Error("Quote истёк. Получите новый.");
    checkSlippage(q.bps);
    const expectedA = q.kind === "add" ? (q.amountA * BigInt(10000 + q.bps) + 9999n) / 10000n : q.amountA * BigInt(10000 - q.bps) / 10000n;
    const expectedB = q.kind === "add" ? (q.amountB * BigInt(10000 + q.bps) + 9999n) / 10000n : q.amountB * BigInt(10000 - q.bps) / 10000n;
    if (!["add", "remove"].includes(q.kind) || q.amountA < 0n || q.amountB < 0n || q.limitA !== expectedA || q.limitB !== expectedB)
        throw Error("Quote изменён.");
    if (q.liquidity < 0n || q.liquidity >= (1n << 128n) || q.limitA < 0n || q.limitB < 0n || q.limitA >= (1n << 64n) || q.limitB >= (1n << 64n))
        throw Error("Некорректные лимиты quote.");
}
export async function clmmBalances(c: Connection, m: ClmmMarket, owner: PublicKey) {
    const mints = [m.state.mintA, m.state.mintB];
    const addresses = mints.map(mint => getAssociatedTokenAddressSync(mint, owner));
    const infos = await c.getMultipleAccountsInfo(addresses);
    return infos.map((info, i) => {
        if (!info)
            return 0n;
        const a = unpackAccount(addresses[i], info);
        if (!a.owner.equals(owner) || !a.mint.equals(mints[i]) || a.isFrozen)
            throw Error("Некорректный или замороженный ATA.");
        return a.amount;
    });
}
export async function loadPosition(c: Connection, owner: PublicKey, nftMint: PublicKey): Promise<Position> {
    await ensureTestNetwork(c, "devnet");
    const address = getPdaPersonalPositionAddress(CLMM_DEVNET, nftMint).publicKey;
    const account = await c.getAccountInfo(address);
    if (!account?.owner.equals(CLMM_DEVNET) || account.data.length !== PersonalPositionLayout.span || account.data.subarray(0, 8).toString("hex") !== "466f967ee60f1975")
        throw Error("Позиция CLMM не найдена.");
    const state = PersonalPositionLayout.decode(account.data);
    if (!state.nftMint.equals(nftMint))
        throw Error("Некорректный NFT mint позиции.");
    const nft = await getMint(c, nftMint), ata = await getAccount(c, getAssociatedTokenAddressSync(nftMint, owner));
    if (nft.decimals !== 0 || nft.supply !== 1n || !ata.owner.equals(owner) || !ata.mint.equals(nftMint) || ata.amount !== 1n || ata.isFrozen)
        throw Error("Кошелёк не владеет NFT позиции.");
    return { address, nftMint, state, owner };
}
export async function listPositions(c: Connection, owner: PublicKey, pool: PublicKey) {
    await ensureTestNetwork(c, "devnet");
    const tokens = (await c.getTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })).value;
    const candidates = tokens.map(t => unpackAccount(t.pubkey, t.account)).filter(a => a.amount === 1n && !a.isFrozen).slice(0, 100);
    const result: Position[] = [];
    for (const token of candidates) {
        if (!getAssociatedTokenAddressSync(token.mint, owner).equals(token.address))
            continue;
        const account = await c.getAccountInfo(getPdaPersonalPositionAddress(CLMM_DEVNET, token.mint).publicKey);
        if (!account)
            continue;
        const p = await loadPosition(c, owner, token.mint);
        if (p.state.poolId.equals(pool))
            result.push(p);
    }
    return result;
}
function positionKeys(m: ClmmMarket, lower: number, upper: number) {
    validateTicks(lower, upper, m.state.tickSpacing);
    const startLower = TickArrayUtil.getTickArrayStartIndex(lower, m.state.tickSpacing), startUpper = TickArrayUtil.getTickArrayStartIndex(upper, m.state.tickSpacing);
    return { startLower, startUpper, lower: getPdaTickArrayAddress(CLMM_DEVNET, m.address, startLower).publicKey, upper: getPdaTickArrayAddress(CLMM_DEVNET, m.address, startUpper).publicKey, protocol: getPdaProtocolPositionAddress(CLMM_DEVNET, m.address, lower, upper).publicKey, bitmap: getPdaExBitmapAccount(CLMM_DEVNET, m.address).publicKey };
}
export async function buildPositionTransaction(c: Connection, owner: PublicKey, q: PositionQuote, close = false) {
    validatePositionQuote(q, owner);
    const m = await positionMarket(c, q.pool), s = m.state;
    validateTicks(q.tickLower, q.tickUpper, s.tickSpacing);
    const keys = positionKeys(m, q.tickLower, q.tickUpper), ataA = getAssociatedTokenAddressSync(s.mintA, owner), ataB = getAssociatedTokenAddressSync(s.mintB, owner);
    const tx = week13Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner, ataA, owner, s.mintA), createAssociatedTokenAccountIdempotentInstruction(owner, ataB, owner, s.mintB));
    let p: Position | undefined;
    if (q.position) {
        p = await loadPosition(c, owner, q.position);
        if (!p.state.poolId.equals(q.pool) || p.state.tickLower !== q.tickLower || p.state.tickUpper !== q.tickUpper)
            throw Error("Параметры позиции изменились.");
    }
    const fresh = liquidityAmounts(m, q.tickLower, q.tickUpper, q.liquidity, q.kind === "add");
    const signers: Keypair[] = [];
    let nftMint = q.position;
    if (q.kind === "add") {
        if (s.status & 1)
            throw Error("Добавление ликвидности приостановлено.");
        if (q.liquidity === 0n || fresh.amountA > q.limitA || fresh.amountB > q.limitB)
            throw Error("Цена вышла за slippage или liquidity=0.");
        const balances = await clmmBalances(c, m, owner);
        if (balances[0] < q.limitA || balances[1] < q.limitB)
            throw Error("Недостаточно свободных токенов A/B для лимитов.");
        if (p) {
            tx.add(ClmmInstrument.increaseLiquidityV2Instruction(CLMM_DEVNET, owner, getAssociatedTokenAddressSync(p.nftMint, owner), p.address, m.address, keys.protocol, keys.lower, keys.upper, ataA, ataB, s.vaultA, s.vaultB, s.mintA, s.mintB, bn(q.liquidity), bn(q.limitA), bn(q.limitB), null, keys.bitmap));
        }
        else {
            const nft = Keypair.generate();
            signers.push(nft);
            nftMint = nft.publicKey;
            tx.add(ClmmInstrument.openPositionV2Instruction(CLMM_DEVNET, owner, m.address, owner, nft.publicKey, getAssociatedTokenAddressSync(nft.publicKey, owner), getPdaMetadataKey(nft.publicKey).publicKey, keys.protocol, keys.lower, keys.upper, getPdaPersonalPositionAddress(CLMM_DEVNET, nft.publicKey).publicKey, ataA, ataB, s.vaultA, s.vaultB, s.mintA, s.mintB, q.tickLower, q.tickUpper, keys.startLower, keys.startUpper, bn(q.liquidity), bn(q.limitA), bn(q.limitB), false, null, keys.bitmap));
        }
    }
    else {
        if (!p)
            throw Error("Нужен NFT позиции.");
        if ((s.status & 2) || (q.liquidity === 0n && (s.status & 4)))
            throw Error("Вывод/сбор комиссий приостановлен.");
        if (q.liquidity > BigInt(p.state.liquidity.toString()) || fresh.amountA < q.limitA || fresh.amountB < q.limitB)
            throw Error("Liquidity/цена позиции изменилась.");
        tx.add(ClmmInstrument.decreaseLiquidityV2Instruction(CLMM_DEVNET, owner, getAssociatedTokenAddressSync(p.nftMint, owner), p.address, m.address, keys.protocol, keys.lower, keys.upper, ataA, ataB, s.vaultA, s.vaultB, s.mintA, s.mintB, [], bn(q.liquidity), bn(q.limitA), bn(q.limitB), keys.bitmap));
        if (close) {
            if (q.liquidity !== BigInt(p.state.liquidity.toString()))
                throw Error("Для закрытия выведите всю liquidity.");
            tx.add(ClmmInstrument.closePositionInstruction(CLMM_DEVNET, owner, p.nftMint, getAssociatedTokenAddressSync(p.nftMint, owner), p.address, false));
        }
    }
    validatePositionQuote(q, owner);
    return { transaction: tx, signers, nftMint: nftMint! };
}
export function positionPrices(m: ClmmMarket, p: Position) {
    return { lower: TickUtil.tickToPrice(p.state.tickLower, m.decimalsA, m.decimalsB).toString(), upper: TickUtil.tickToPrice(p.state.tickUpper, m.decimalsA, m.decimalsB).toString() };
}
