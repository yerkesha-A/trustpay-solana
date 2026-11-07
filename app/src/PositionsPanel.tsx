import { useEffect, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { WEEK13 } from "../../shared/week13-config";
import { formatUnits, parseUnits } from "../../shared/defi";
import { type ClmmMarket } from "../../shared/market";
import { positionMarket, clmmBalances, listPositions, loadPosition, quotePositionAdd, quotePositionIncrease, quotePositionRemove, buildPositionTransaction, validatePositionQuote, type Position, type PositionQuote } from "../../shared/positions";
import { sendWeek13Transaction } from "../../shared/transactions";
import { week13Connection as c, week13Explorer as explorer, confirmedFee } from "./week13-client";
const budget = (s: string, decimals: number) => /^0(?:\.0*)?$/.test(s) ? 0n : parseUnits(s, decimals);
export default function PositionsPanel() {
    const wallet = useAnchorWallet();
    const [poolId, setPoolId] = useState<string>(WEEK13.pool), [market, setMarket] = useState<ClmmMarket | null>(null);
    const [positions, setPositions] = useState<Position[]>([]), [selected, setSelected] = useState(""), [balances, setBalances] = useState<bigint[]>([]);
    const [mode, setMode] = useState("open"), [lower, setLower] = useState("0.9"), [upper, setUpper] = useState("1.1"), [a, setA] = useState("1"), [b, setB] = useState("1"), [percent, setPercent] = useState("50"), [bps, setBps] = useState("50");
    const [quote, setQuote] = useState<PositionQuote | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [signature, setSignature] = useState("");
    useEffect(() => { setQuote(null); setPositions([]); setSelected(""); setBalances([]); }, [wallet?.publicKey.toBase58()]);
    async function run(fn: () => Promise<void>) { setBusy(true); setError(""); setNotice(""); try {
        await fn();
    }
    catch (e) {
        setError(String(e));
        setNotice("");
    }
    finally {
        setBusy(false);
    } }
    async function refresh() {
        const m = await positionMarket(c, new PublicKey(poolId));
        setMarket(m);
        if (wallet) {
            setBalances(await clmmBalances(c, m, wallet.publicKey));
            setPositions(await listPositions(c, wallet.publicKey, m.address));
        }
        return m;
    }
    function change() { setQuote(null); }
    async function calculate() {
        if (!wallet)
            throw Error("Подключите Phantom.");
        setQuote(null);
        const m = await refresh();
        if (mode === "open")
            setQuote(quotePositionAdd(m, wallet.publicKey, lower, upper, budget(a, m.decimalsA), budget(b, m.decimalsB), Number(bps)));
        else {
            if (!selected)
                throw Error("Выберите позицию.");
            const p = await loadPosition(c, wallet.publicKey, new PublicKey(selected));
            if (mode === "increase")
                setQuote(quotePositionIncrease(m, p, budget(a, m.decimalsA), budget(b, m.decimalsB), Number(bps)));
            else {
                const n = Number(percent);
                if (mode === "decrease" && (!Number.isInteger(n) || n < 1 || n > 100))
                    throw Error("Вывод: 1–100%.");
                const liquidity = mode === "collect" ? 0n : mode === "close" ? BigInt(p.state.liquidity.toString()) : BigInt(p.state.liquidity.toString()) * BigInt(n) / 100n;
                if (mode === "decrease" && liquidity === 0n)
                    throw Error("Слишком маленькая доля вывода.");
                setQuote(quotePositionRemove(m, p, liquidity, Number(bps)));
            }
        }
    }
    async function execute() {
        if (!wallet || !quote)
            return;
        const approved = quote;
        setQuote(null);
        setSignature("");
        const built = await buildPositionTransaction(c, wallet.publicKey, approved, mode === "close");
        setNotice("Подтвердите CLMM-транзакцию в Phantom (Devnet)…");
        const sig = await sendWeek13Transaction(c, wallet, built.transaction, built.signers, setSignature, () => validatePositionQuote(approved, wallet.publicKey));
        setNotice("CLMM-транзакция подтверждена в Devnet.");
        setSelected(built.nftMint.toBase58());
        window.dispatchEvent(new CustomEvent("trustpay:transaction-confirmed", { detail: { network: "devnet", signature: sig } }));
        try {
            await refresh();
            if (mode === "close")
                setSelected("");
            setNotice("CLMM-транзакция подтверждена в Devnet." + await confirmedFee(sig));
        }
        catch (e) {
            setError("Подтверждено, но обновить данные не удалось: " + String(e));
        }
    }
    return <div className="defi week13-page">
  <div className="intro"><div><div className="eyebrow">RAYDIUM CLMM · DEVNET</div><h1>CLMM Positions</h1></div><span className="defi-network">● Solana Devnet</span></div>
  <div className="defi-boundary"><div><strong>Только свободные тестовые токены</strong><p>Escrow и Liquidity Vault не используются. Нужны Devnet SOL для NFT позиции, tick arrays и комиссии. Доход не гарантируется; вне диапазона ликвидность неактивна.</p></div></div>
  <section className="projects week13-card"><h2>Пул и позиции</h2>
   <form className="week13-form" onSubmit={e => { e.preventDefault(); change(); setMarket(null); setPositions([]); void run(async () => { await refresh(); }); }}><label>CLMM-пул Devnet<input value={poolId} disabled={busy} onChange={e => { setPoolId(e.target.value); setMarket(null); setPositions([]); setSelected(""); setBalances([]); change(); }}/></label><button className="secondary" disabled={busy}>Загрузить позиции</button></form>
   {!wallet && <WalletMultiButton />}
   {market && <>
    <p>Цена B/A: {market.price} · Tick: {market.state.tickCurrent} · Spacing: {market.state.tickSpacing} · Active L: {market.state.liquidity.toString()}</p>
    <p className="break-address">A: {market.state.mintA.toBase58()}<br />B: {market.state.mintB.toBase58()}</p>
    <p>Свободный баланс A / B: {balances.length ? `${formatUnits(balances[0], market.decimalsA)} / ${formatUnits(balances[1], market.decimalsB)}` : "—"}</p>
    <a href={explorer(market.address.toBase58(), "address")} target="_blank" rel="noreferrer">Пул в Explorer ↗</a>
    {positions.length === 0 && <p>{wallet ? "Открытых позиций в ATA этого кошелька не найдено." : "Подключите Phantom, чтобы загрузить позиции."}</p>}
    {positions.map(p => <article className="week13-item" key={p.nftMint.toBase58()}><p className="break-address">NFT: {p.nftMint.toBase58()}</p><p>Ticks: {p.state.tickLower} … {p.state.tickUpper} · L: {p.state.liquidity.toString()} · {market.state.tickCurrent >= p.state.tickLower && market.state.tickCurrent < p.state.tickUpper ? "В диапазоне" : "Вне диапазона"}</p><p>Записанные комиссии A / B: {formatUnits(BigInt(p.state.tokenFeesOwedA.toString()), market.decimalsA)} / {formatUnits(BigInt(p.state.tokenFeesOwedB.toString()), market.decimalsB)}. Ещё не записанные начисления определяются при обновлении позиции.</p></article>)}
    <form className="week13-form" onSubmit={e => { e.preventDefault(); void run(calculate); }}>
     <label>Операция<select disabled={busy} value={mode} onChange={e => { setMode(e.target.value); change(); }}><option value="open">Открыть позицию</option><option value="increase">Добавить ликвидность</option><option value="decrease">Уменьшить ликвидность</option><option value="collect">Собрать комиссии</option><option value="close">Вывести всё и закрыть</option></select></label>
     {mode !== "open" && <label>NFT позиции<select disabled={busy} required value={selected} onChange={e => { setSelected(e.target.value); change(); }}><option value="">Выберите NFT</option>{positions.map(p => <option key={p.nftMint.toBase58()} value={p.nftMint.toBase58()}>{p.nftMint.toBase58()}</option>)}</select></label>}
     {mode === "open" && <><label>Нижняя цена B/A<input required disabled={busy} value={lower} onChange={e => { setLower(e.target.value); change(); }}/></label><label>Верхняя цена B/A<input required disabled={busy} value={upper} onChange={e => { setUpper(e.target.value); change(); }}/></label></>}
     {(mode === "open" || mode === "increase") && <><label>Бюджет A<input required inputMode="decimal" disabled={busy} value={a} onChange={e => { setA(e.target.value); change(); }}/></label><label>Бюджет B<input required inputMode="decimal" disabled={busy} value={b} onChange={e => { setB(e.target.value); change(); }}/></label></>}
     {mode === "decrease" && <label>Доля вывода (%)<input type="number" min="1" max="100" required disabled={busy} value={percent} onChange={e => { setPercent(e.target.value); change(); }}/></label>}
     <label>Slippage позиции (bps)<input type="number" min="1" max="500" required disabled={busy} value={bps} onChange={e => { setBps(e.target.value); change(); }}/></label>
     <button className="secondary" disabled={busy || !wallet}>Рассчитать позицию</button>
    </form>
    {quote && <div className="defi-quote"><p>Ticks: {quote.tickLower} … {quote.tickUpper} · L: {quote.liquidity.toString()}</p><p>Количество A / B: {formatUnits(quote.amountA, market.decimalsA)} / {formatUnits(quote.amountB, market.decimalsB)}</p><p>{quote.kind === "add" ? "Максимум списания" : "Минимум получения"}: {formatUnits(quote.limitA, market.decimalsA)} / {formatUnits(quote.limitB, market.decimalsB)}</p><p>Quote: 30 секунд. Priority fee: 0 SOL; лимит: 900000 CU. Начисленные комиссии при выводе добавляются отдельно.</p><button className="primary" disabled={busy || !wallet} onClick={() => void run(execute)}>Подписать CLMM-транзакцию</button></div>}
   </>}
   {error && <div className="error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}{signature && <a className="tx" href={explorer(signature)} target="_blank" rel="noreferrer">Транзакция в Explorer ↗</a>}
  </section>
 </div>;
}
