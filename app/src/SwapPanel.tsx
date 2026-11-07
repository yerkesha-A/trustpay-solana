import { useEffect, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { formatUnits, parseUnits } from "../../shared/defi";
import { MARKET_POOLS, loadAmmMarket, type AmmMarket } from "../../shared/market";
import { buildSwapTransaction, quoteSwap, swapBalances, validateSwapApproval, type SwapQuote } from "../../shared/swap";

export default function SwapPanel({ connection }: { connection: Connection }) {
  const wallet = useAnchorWallet();
  const [address, setAddress] = useState<string>(MARKET_POOLS[0].address);
  const [market, setMarket] = useState<AmmMarket | null>(null);
  const [balances, setBalances] = useState<bigint[]>([]);
  const [reverse, setReverse] = useState(false);
  const [amount, setAmount] = useState("");
  const [bps, setBps] = useState("50");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [signature, setSignature] = useState("");
  useEffect(() => { setQuote(null); setBalances([]); }, [wallet?.publicKey.toBase58()]);
  async function refresh() {
    const m = await loadAmmMarket(connection, new PublicKey(address));
    setMarket(m);
    if (wallet) setBalances(await swapBalances(connection, m, wallet.publicKey));
    return m;
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function execute() {
    if (!wallet || !quote) return;
    const approved = quote;
    setQuote(null); setSignature("");
    const tx = await buildSwapTransaction(connection, wallet.publicKey, approved);
    const block = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = wallet.publicKey; tx.recentBlockhash = block.blockhash;
    setNotice("Подтвердите обмен тестовых токенов в кошельке…");
    const signed = await wallet.signTransaction(tx);
    validateSwapApproval(approved, wallet.publicKey);
    if (!signed.signature) throw Error("Подпись отсутствует.");
    setSignature(utils.bytes.bs58.encode(signed.signature));
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 2 });
    setSignature(sig); setNotice("Отправлено. Ожидаем подтверждения Devnet…");
    const result = await connection.confirmTransaction({ signature: sig, ...block }, "confirmed");
    if (result.value.err) throw Error(JSON.stringify(result.value.err));
    setNotice("Swap подтверждён в Devnet.");
    window.dispatchEvent(new CustomEvent("trustpay:transaction-confirmed", { detail: { network: "devnet", signature: sig } }));
    try { await refresh(); } catch (e) { setError("Swap подтверждён, обновление балансов не удалось: " + String(e)); }
  }
  const inputDecimals = market ? (reverse ? market.pool.decimalsB : market.pool.decimalsA) : 0;
  const outputDecimals = market ? (reverse ? market.pool.decimalsA : market.pool.decimalsB) : 0;
  return <section className="projects defi-card swap-card" aria-label="Raydium Swap">
    <h2>Raydium Swap · Devnet</h2>
    <p>Только свободные SPL-токены кошелька. Quote действует 30 секунд. Нужны тестовые SOL для комиссии и ATA.</p>
    <form className="pool-form" onSubmit={e => { e.preventDefault(); void run(async () => { setQuote(null); setMarket(null); await refresh(); }); }}>
      <label>CPMM-пул для обмена<input value={address} disabled={busy} onChange={e => { setAddress(e.target.value); setMarket(null); setQuote(null); setBalances([]); }} /></label>
      <button className="secondary" disabled={busy}>Загрузить swap-пул</button>
    </form>
    {market && <>
      <p style={{ overflowWrap: "anywhere" }}>A: {market.pool.state.mintA.toBase58()}<br />B: {market.pool.state.mintB.toBase58()}</p>
      <p>Резервы A / B: {formatUnits(market.pool.reserveA, market.pool.decimalsA)} / {formatUnits(market.pool.reserveB, market.pool.decimalsB)}</p>
      <p>Свободный баланс A / B: {wallet && balances.length ? `${formatUnits(balances[0], market.pool.decimalsA)} / ${formatUnits(balances[1], market.pool.decimalsB)}` : "Подключите кошелёк и обновите пул"}</p>
      <form className="liquidity-form" onSubmit={e => { e.preventDefault(); void run(async () => {
        setQuote(null); if (!wallet) throw Error("Подключите кошелёк.");
        const m = await refresh(); const input = parseUnits(amount, inputDecimals);
        const q = quoteSwap(m, wallet.publicKey, reverse ? m.pool.state.mintB : m.pool.state.mintA, input, Number(bps));
        const b = await swapBalances(connection, m, wallet.publicKey);
        if (b[reverse ? 1 : 0] < input) throw Error("Недостаточно свободных токенов.");
        setQuote(q);
      }); }}>
        <label>Направление<select disabled={busy} value={String(reverse)} onChange={e => { setReverse(e.target.value === "true"); setQuote(null); }}><option value="false">A → B</option><option value="true">B → A</option></select></label>
        <label>Количество для обмена<input inputMode="decimal" required disabled={busy} value={amount} onChange={e => { setAmount(e.target.value); setQuote(null); }} /></label>
        <label>Slippage swap (bps)<input type="number" min="1" max="500" required disabled={busy} value={bps} onChange={e => { setBps(e.target.value); setQuote(null); }} /></label>
        <button className="secondary" disabled={busy || !wallet}>Получить котировку</button>
      </form>
    </>}
    {quote && <div className="defi-quote"><p>Ожидается: {formatUnits(quote.output, outputDecimals)} · Минимум получения: {formatUnits(quote.minimum, outputDecimals)}</p><p>Комиссия: {formatUnits(quote.fee, inputDecimals)} · Price impact: {quote.priceImpactPercent}%</p><button className="primary" disabled={busy || !wallet} onClick={() => void run(execute)}>Подписать swap тестовых токенов</button></div>}
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {signature && <a className="tx" target="_blank" rel="noreferrer" href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}>Проверить транзакцию в Explorer ↗</a>}
  </section>;
}
