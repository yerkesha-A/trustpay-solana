import { useEffect, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { BN, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "./idl.json";
import { WEEK13 } from "../../shared/week13-config";
import { formatUnits } from "../../shared/defi";
import { listPayments, stablecoinBalance, buildPayment, buildPaymentAction, assertPaymentAction, type Payment, type PaymentAction } from "../../shared/payments";
import { sendWeek13Transaction } from "../../shared/transactions";
import { week13Connection as c, week13Explorer as explorer, confirmedFee } from "./week13-client";
const labels: Record<string, string> = { funded: "Средства внесены", submitted: "Работа сдана", cancelApproved: "Отмена согласована", paid: "Выплачен", refunded: "Возвращён" };
const actions: Array<[
    PaymentAction,
    string
]> = [["submitWork", "Сдать работу"], ["allowCancel", "Согласовать отмену"], ["release", "Выплатить"], ["refund", "Вернуть средства"]];
export default function PaymentsPanel() {
    const wallet = useAnchorWallet();
    const [payments, setPayments] = useState<Payment[]>([]), [balance, setBalance] = useState<bigint | null>(null);
    const [worker, setWorker] = useState(""), [amount, setAmount] = useState("1"), [title, setTitle] = useState("");
    const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [signature, setSignature] = useState("");
    async function refresh() { if (!wallet)
        return; setBalance(await stablecoinBalance(c, wallet.publicKey)); setPayments(await listPayments(c, wallet, idl as Idl)); }
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
    useEffect(() => { setPayments([]); setBalance(null); if (wallet)
        void run(refresh); }, [wallet?.publicKey.toBase58()]);
    async function send(tx: Parameters<typeof sendWeek13Transaction>[2]) {
        if (!wallet)
            throw Error("Подключите Phantom.");
        setSignature("");
        setNotice("Подтвердите платёж в Phantom (Devnet)…");
        const sig = await sendWeek13Transaction(c, wallet, tx, [], setSignature);
        setNotice("Транзакция подтверждена в Devnet.");
        window.dispatchEvent(new CustomEvent("trustpay:transaction-confirmed", { detail: { network: "devnet", signature: sig } }));
        try {
            await refresh();
            setNotice("Транзакция подтверждена в Devnet." + await confirmedFee(sig));
        }
        catch (e) {
            setError("Подтверждено, но данные не обновились: " + String(e));
        }
    }
    return <div className="defi week13-page">
  <div className="intro"><div><div className="eyebrow">PAYMENTS · DEVNET</div><h1>Stablecoin Payments</h1></div><span className="defi-network">● Solana Devnet</span></div>
  <div className="defi-boundary"><div><strong>Mock USD — имитация stablecoin</strong><p>Тестовый SPL-токен. Это не USDC, не RWA и не актив с резервным обеспечением. Фиксированная стоимость не гарантируется.</p></div></div>
  <section className="projects week13-card"><h2>Платёж через escrow</h2>
   <p className="break-address">Mint: <a target="_blank" rel="noreferrer" href={explorer(WEEK13.stableMint, "address")}>{WEEK13.stableMint}</a> · decimals: 6</p>
   <p>Свободно: {balance === null ? "—" : formatUnits(balance, 6)} Mock USD</p>
   {!wallet ? <WalletMultiButton /> : <form className="week13-form" onSubmit={e => {
                e.preventDefault();
                void run(async () => {
                    const values = crypto.getRandomValues(new Uint32Array(2));
                    const id = new BN(((BigInt(values[0]) << 32n) | BigInt(values[1])).toString());
                    const result = await buildPayment(c, wallet, idl as Idl, new PublicKey(worker), amount, title, id);
                    await send(result.transaction);
                });
            }}>
    <label>Название работы (on-chain)<input required maxLength={120} value={title} disabled={busy} onChange={e => setTitle(e.target.value)}/></label>
    <label>Адрес исполнителя<input required value={worker} disabled={busy} onChange={e => setWorker(e.target.value)}/></label>
    <label>Количество Mock USD<input required inputMode="decimal" value={amount} disabled={busy} onChange={e => setAmount(e.target.value)}/></label>
    <button className="primary" disabled={busy}>Создать и внести средства</button>
   </form>}
   <p className="warning">Отмена требует согласия исполнителя до сдачи работы. Арбитража и автоматического возврата нет. Название публично: не указывайте персональные данные. Внесённые средства недоступны для DeFi.</p>
   {error && <div className="error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
   {signature && <a className="tx" href={explorer(signature)} target="_blank" rel="noreferrer">Транзакция в Explorer ↗</a>}
  </section>
  <section className="projects week13-card"><div className="section-heading"><h2>Мои платежи</h2><button className="secondary" disabled={busy || !wallet} onClick={() => void run(refresh)}>Обновить платежи</button></div>
   {!payments.length && <p>{wallet ? "Платежей Mock USD пока нет." : "Подключите кошелёк для просмотра."}</p>}
   {payments.map(p => <article className="week13-item" key={p.publicKey.toBase58()}><h3>{p.account.title}</h3><p>{formatUnits(BigInt(p.account.amount.toString()), 6)} Mock USD · {labels[Object.keys(p.account.status)[0]]}</p>
    <p className="break-address">Заказчик: {p.account.client.toBase58()}<br />Исполнитель: {p.account.freelancer.toBase58()}</p>
    <a href={explorer(p.publicKey.toBase58(), "address")} target="_blank" rel="noreferrer">Order PDA ↗</a>
    <div className="week13-actions">{actions.filter(([action]) => { try {
            assertPaymentAction(p.account, wallet!.publicKey, action);
            return true;
        }
        catch {
            return false;
        } }).map(([action, label]) => <button className="secondary" disabled={busy} key={action} onClick={() => void run(async () => { if (wallet)
            await send(await buildPaymentAction(c, wallet, idl as Idl, p.publicKey, action)); })}>{label}</button>)}</div>
   </article>)}
  </section>
 </div>;
}
