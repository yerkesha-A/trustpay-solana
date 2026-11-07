import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  ShieldCheck,
  LayoutDashboard,
  ArrowUpRight,
  Plus,
  RefreshCw,
  LockKeyhole,
  CircleCheck,
  Wallet,
  Moon,
  Sun,
  ExternalLink,
  X,
} from "lucide-react";
import {
  act,
  configured,
  confirm,
  connection,
  create,
  explorer,
  network,
  Order,
  program,
  short,
} from "./chain";
import { getMint } from "@solana/spl-token";
import type { ConfirmedSignatureInfo } from "@solana/web3.js";
import RpcSectionBoundary from "./RpcSectionBoundary";
const RpcDashboard = lazy(() => import("./RpcDashboard"));
const LiquidityPanel = lazy(() => import("./LiquidityPanel"));
const DeFiPanel = lazy(() => import("./DeFiPanel"));
const PaymentsPanel = lazy(() => import("./PaymentsPanel"));
const PositionsPanel = lazy(() => import("./PositionsPanel"));
const labels: Record<string, string> = {
  funded: "В работе",
  submitted: "На проверке",
  cancelApproved: "Отмена согласована",
  paid: "Оплачен",
  refunded: "Возвращён",
};
export default function App() {
  const wallet = useAnchorWallet();
  const [view, setView] = useState<
    "projects" | "defi" | "dashboard" | "liquidity" | "payments" | "positions"
  >("projects");
  const [role, setRole] = useState<"client" | "freelancer">("client"),
    [orders, setOrders] = useState<Order[]>([]),
    [decimals, setDecimals] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [signature, setSignature] = useState(""),
    [modal, setModal] = useState(false),
    [detail, setDetail] = useState<Order | null>(null),
    [dark, setDark] = useState(false),
    [tab, setTab] = useState("Все заказы");
  const [history, setHistory] = useState<ConfirmedSignatureInfo[]>([]),
    [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    setHistory([]);
    if (!detail) return;
    let current = true;
    setHistoryLoading(true);
    connection
      .getSignaturesForAddress(detail.publicKey, { limit: 20 })
      .then((rows) => {
        if (current) setHistory(rows);
      })
      .catch((e) => {
        if (current) setError(String(e));
      })
      .finally(() => {
        if (current) setHistoryLoading(false);
      });
    return () => {
      current = false;
    };
  }, [detail]);
  const refresh = useCallback(async () => {
    if (!wallet || !configured) {
      setOrders([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const p = program(wallet);
      if (!(await connection.getAccountInfo(p.programId)))
        throw new Error("Программа ещё не развёрнута в выбранной сети.");
      const all = (await (p.account as any).order.all()) as Order[];
      const mine = all.filter(
        (o) =>
          o.account.client.equals(wallet.publicKey) ||
          o.account.freelancer.equals(wallet.publicKey),
      );
      const mints = [...new Set(mine.map((o) => o.account.mint.toBase58()))];
      const entries = await Promise.all(
        mints.map(
          async (mint) =>
            [
              mint,
              (
                await getMint(
                  connection,
                  mine.find((o) => o.account.mint.toBase58() === mint)!.account
                    .mint,
                )
              ).decimals,
            ] as const,
        ),
      );
      setDecimals(Object.fromEntries(entries));
      setOrders(mine);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [wallet]);
  useEffect(() => {
    setOrders([]);
    setSignature("");
    setNotice("");
    void refresh();
  }, [refresh]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError("");
    setSignature("");
    setNotice("Подтвердите транзакцию в Phantom…");
    try {
      const sig = await fn();
      setSignature(sig);
      setNotice("Транзакция отправлена. Ожидаем подтверждения…");
      await confirm(sig);
      window.dispatchEvent(
        new CustomEvent("trustpay:transaction-confirmed", {
          detail: { network, signature: sig },
        }),
      );
      setNotice("Транзакция подтверждена");
      setModal(false);
      setDetail(null);
      await refresh();
    } catch (e) {
      setError(String(e));
      setNotice("");
    } finally {
      setBusy(false);
    }
  };
  const visible = orders.filter(
    (o) => wallet && o.account[role].equals(wallet.publicKey),
  );
  const active = visible.filter(
    (o) => !["paid", "refunded"].includes(Object.keys(o.account.status)[0]),
  );
  const filtered = visible.filter(
    (o) =>
      tab === "Все заказы" ||
      (tab === "Активные" ? active.includes(o) : !active.includes(o)),
  );
  const amount = (o: Order) => {
    const d = decimals[o.account.mint.toBase58()];
    if (d === undefined) return o.account.amount.toString() + " units";
    const value = BigInt(o.account.amount.toString()),
      base = 10n ** BigInt(d);
    return `${value / base}${d ? "." + (value % base).toString().padStart(d, "0").replace(/0+$/, "") : ""}`.replace(
      /\.$/,
      "",
    );
  };
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="/">
          <span className="brand-icon">
            <ShieldCheck size={25} />
          </span>
          TrustPay<span className="dot">.</span>
        </a>
        <div className="workspace">WORKSPACE</div>
        <button
          className={view === "projects" ? "nav active" : "nav"}
          onClick={() => {
            setView("projects");
            setDetail(null);
            setTab("Все заказы");
          }}
        >
          <LayoutDashboard size={19} /> Обзор проектов <span>↗</span>
        </button>
        <button
          className={view === "defi" ? "nav active" : "nav"}
          onClick={() => setView("defi")}
        >
          <ArrowUpRight size={19} /> DeFi · Raydium <span>↗</span>
        </button>
        <button
          className={view === "liquidity" ? "nav active" : "nav"}
          onClick={() => setView("liquidity")}
        >
          <ArrowUpRight size={19} /> DeFi / Liquidity <span>↗</span>
        </button>
        <button
          className={view === "dashboard" ? "nav active" : "nav"}
          onClick={() => setView("dashboard")}
        >
          <LayoutDashboard size={19} /> RPC Dashboard <span>↗</span>
        </button>
        <button className={view === "payments" ? "nav active" : "nav"} onClick={() => setView("payments")}><Wallet size={19} /> Stablecoin Payments <span>↗</span></button>
        <button className={view === "positions" ? "nav active" : "nav"} onClick={() => setView("positions")}><ArrowUpRight size={19} /> CLMM Positions <span>↗</span></button>
        <div className="sidebar-bottom">
          <div className="security">
            <LockKeyhole size={21} />
            <strong>Escrow</strong>
            <p>Тестовые токены хранятся в escrow до подтверждения работы.</p>
            <small>Независимый аудит не проводился</small>
          </div>
          <div className="network">
            <i />
            {network === "devnet" ? "Solana Devnet" : "Local validator"}
            <span>TEST ONLY</span>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            Workspace <span>/</span>{" "}
            {view === "payments" ? "Stablecoin Payments" : view === "positions" ? "CLMM Positions" : view === "liquidity"
              ? "DeFi / Liquidity"
              : view === "dashboard"
                ? "RPC Dashboard"
                : view === "defi"
                  ? "DeFi · Raydium"
                  : "Обзор проектов"}
          </div>
          <div className="header-actions">
            <button
              className="icon"
              aria-label="Переключить тему"
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <WalletMultiButton />
          </div>
        </header>
        <div className="content">
          <div className="mobile-sections">
            <button onClick={() => setView("payments")}>Stablecoin Payments</button>
            <button onClick={() => setView("positions")}>CLMM Positions</button>
            <button onClick={() => setView("projects")}>Проекты</button>
            <button onClick={() => setView("defi")}>DeFi · Raydium</button>
            <button onClick={() => setView("dashboard")}>RPC Dashboard</button>
            <button onClick={() => setView("liquidity")}>
              DeFi / Liquidity
            </button>
          </div>
          {view === "payments" || view === "positions" ? (
            <RpcSectionBoundary key={view}><Suspense fallback={<p>Загрузка…</p>}>
              {view === "payments" ? <PaymentsPanel key={wallet?.publicKey.toBase58() || "disconnected"}/> : <PositionsPanel key={wallet?.publicKey.toBase58() || "disconnected"}/>}
            </Suspense></RpcSectionBoundary>
          ) : view === "liquidity" ? (
            <RpcSectionBoundary key="liquidity">
              <Suspense fallback={<p>Загрузка Liquidity…</p>}>
                <LiquidityPanel
                  key={wallet?.publicKey.toBase58() || "disconnected"}
                  onLp={() => setView("defi")}
                />
              </Suspense>
            </RpcSectionBoundary>
          ) : view === "dashboard" ? (
            <RpcSectionBoundary key="dashboard">
              <Suspense fallback={<p>Загрузка RPC Dashboard…</p>}>
                <RpcDashboard
                  key={wallet?.publicKey.toBase58() || "disconnected"}
                />
              </Suspense>
            </RpcSectionBoundary>
          ) : view === "defi" ? (
            <RpcSectionBoundary key="defi">
              <Suspense fallback={<p>Загрузка DeFi…</p>}>
                <DeFiPanel
                  key={wallet?.publicKey.toBase58() || "disconnected"}
                />
              </Suspense>
            </RpcSectionBoundary>
          ) : (
            <>
              <div className="intro">
                <div>
                  <div className="eyebrow">ПЛАТЕЖИ БЕЗ ЛИШНИХ РИСКОВ</div>
                  <h1>
                    Ваша работа. Под защитой<span>.</span>
                  </h1>
                  <p>Заказы, статусы и выплаты.</p>
                </div>
                <button
                  className="primary"
                  disabled={!wallet || !configured || busy}
                  onClick={() => setModal(true)}
                >
                  <Plus size={18} />
                  Создать заказ
                </button>
              </div>
              <div className="role-switch">
                <button
                  className={role === "client" ? "selected" : ""}
                  onClick={() => setRole("client")}
                >
                  Я заказчик
                </button>
                <button
                  className={role === "freelancer" ? "selected" : ""}
                  onClick={() => setRole("freelancer")}
                >
                  Я исполнитель
                </button>
                <span>
                  <ShieldCheck size={14} /> Только тестовые средства
                </span>
              </div>
              <section className="stats">
                <div>
                  <span className="stat-icon">
                    <LayoutDashboard size={20} />
                  </span>
                  <p>Всего проектов</p>
                  <strong>{visible.length.toString().padStart(2, "0")}</strong>
                  <small>В выбранной роли</small>
                </div>
                <div>
                  <span className="stat-icon amber">
                    <LockKeyhole size={20} />
                  </span>
                  <p>Активные escrow</p>
                  <strong>{active.length.toString().padStart(2, "0")}</strong>
                  <small>Средства под защитой контракта</small>
                </div>
                <div>
                  <span className="stat-icon blue">
                    <CircleCheck size={20} />
                  </span>
                  <p>Завершённые проекты</p>
                  <strong>
                    {visible
                      .filter((o) => "paid" in o.account.status)
                      .length.toString()
                      .padStart(2, "0")}
                  </strong>
                  <small>Результат принят и оплачен</small>
                </div>
              </section>
              <section className="projects">
                <div className="section-heading">
                  <div>
                    <h2>
                      Мои проекты <span>{visible.length}</span>
                    </h2>
                    <p>От первого брифа до последней выплаты.</p>
                  </div>
                  <button
                    className="secondary"
                    disabled={loading || busy || !wallet || !configured}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw size={15} className={loading ? "spin" : ""} />{" "}
                    Обновить
                  </button>
                </div>
                <div className="tabs">
                  {["Все заказы", "Активные", "Завершённые"].map((t) => (
                    <button
                      key={t}
                      className={tab === t ? "selected" : ""}
                      onClick={() => setTab(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                {!configured && (
                  <div className="setup">
                    Программа ещё не настроена. Выполните anchor build, anchor
                    keys sync, npm run sync:idl и укажите program ID в
                    app/.env.local.
                  </div>
                )}
                {error && (
                  <div className="error" role="alert">
                    {error}
                  </div>
                )}
                {notice && (
                  <div className="notice" role="status">
                    {notice}
                  </div>
                )}
                {signature && (
                  <a
                    className="tx"
                    target="_blank"
                    rel="noreferrer"
                    href={explorer(signature)}
                  >
                    Транзакция: {short(signature)} <ExternalLink size={14} />
                  </a>
                )}
                {loading ? (
                  <div className="empty">Загрузка данных из Solana…</div>
                ) : filtered.length === 0 ? (
                  <div className="empty">
                    <div className="empty-icon">
                      <Wallet size={29} />
                      <span>
                        <ShieldCheck size={16} />
                      </span>
                    </div>
                    <h3>
                      {wallet
                        ? "Нет заказов"
                        : "Кошелёк не подключён"}
                    </h3>
                    <p>
                      {wallet
                        ? "В выбранной категории нет заказов."
                        : "Подключите Phantom, чтобы увидеть заказы."}
                    </p>
                    {!wallet ? (
                      <WalletMultiButton />
                    ) : (
                      <button
                        className="primary"
                        disabled={!configured || busy}
                        onClick={() => setModal(true)}
                      >
                        <Plus size={17} />
                        Создать первый заказ
                      </button>
                    )}
                    <small>
                      <LockKeyhole size={12} /> Реальные данные сети. Никаких
                      демонстрационных платежей.
                    </small>
                  </div>
                ) : (
                  <div className="order-list">
                    {filtered.map((o) => (
                      <button
                        className="order-row"
                        key={o.publicKey.toBase58()}
                        onClick={() => setDetail(o)}
                      >
                        <span className="project-icon">
                          {o.account.title.slice(0, 1).toUpperCase()}
                        </span>
                        <span>
                          <strong>{o.account.title}</strong>
                          <small>
                            #{o.account.id.toString()} ·{" "}
                            {short(
                              o.account[
                                role === "client" ? "freelancer" : "client"
                              ].toBase58(),
                            )}
                          </small>
                        </span>
                        <span className="badge">
                          {labels[Object.keys(o.account.status)[0]]}
                        </span>
                        <span className="money">
                          {amount(o)}
                          <small>{short(o.account.mint.toBase58())}</small>
                        </span>
                        <ArrowUpRight size={18} />
                      </button>
                    ))}
                  </div>
                )}
              </section>
              <section className="how">
                <div>
                  <span className="eyebrow">ПРОСТОЙ ПУТЬ К РЕЗУЛЬТАТУ</span>
                  <h2>Доверие встроено в каждый шаг.</h2>
                  <p>
                    Вы договариваетесь о работе. Смарт-контракт хранит оплату.
                  </p>
                </div>
                <div className="steps">
                  {[
                    [
                      "01",
                      "Создайте заказ",
                      "Укажите исполнителя и внесите тестовые токены.",
                    ],
                    [
                      "02",
                      "Получите результат",
                      "Исполнитель отправляет работу на проверку.",
                    ],
                    [
                      "03",
                      "Подтвердите выплату",
                      "После вашего одобрения токены получает исполнитель.",
                    ],
                  ].map(([n, t, d]) => (
                    <div key={n}>
                      <span>{n}</span>
                      <strong>{t}</strong>
                      <p>{d}</p>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
          <footer>
            <span>© TrustPay</span>
            <span>
              Solana <i /> Только Localnet / Devnet
            </span>
          </footer>
        </div>
      </main>
      {(modal || detail) && (
        <div className="overlay">
          <section
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={modal ? "Создать заказ" : "Детали заказа"}
          >
            <button
              className="close icon"
              disabled={busy}
              aria-label="Закрыть"
              onClick={() => {
                setModal(false);
                setDetail(null);
              }}
            >
              <X />
            </button>
            {modal ? (
              <>
                <h2>Новый escrow-заказ</h2>
                <p>Создание и оплата выполняются одной транзакцией.</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    void run(() =>
                      create(
                        wallet!,
                        String(data.get("title")),
                        String(data.get("freelancer")),
                        String(data.get("mint")),
                        String(data.get("amount")),
                      ),
                    );
                  }}
                >
                  <label>
                    Название
                    <input name="title" required maxLength={120} />
                  </label>
                  <label>
                    Кошелёк исполнителя
                    <input
                      name="freelancer"
                      required
                      placeholder="Solana public key"
                    />
                  </label>
                  <label>
                    Mint тестового SPL-токена
                    <input
                      name="mint"
                      required
                      defaultValue={import.meta.env.VITE_TEST_MINT || ""}
                    />
                  </label>
                  <label>
                    Сумма
                    <input
                      name="amount"
                      required
                      inputMode="decimal"
                      placeholder="100.00"
                    />
                  </label>
                  <p className="warning">
                    Отмена требует согласия исполнителя до сдачи работы. После
                    сдачи доступна только выплата. Арбитража и автоматического
                    возврата нет. Потребуются тестовые SOL для комиссии.
                  </p>
                  <button className="primary" disabled={busy}>
                    Создать и внести токены
                  </button>
                </form>
              </>
            ) : (
              detail && (
                <>
                  <h2>{detail.account.title}</h2>
                  <span className="badge">
                    {labels[Object.keys(detail.account.status)[0]]}
                  </span>
                  <dl>
                    {[
                      ["Заказчик", detail.account.client.toBase58()],
                      ["Исполнитель", detail.account.freelancer.toBase58()],
                      ["Mint", detail.account.mint.toBase58()],
                      ["Сумма", amount(detail)],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <a
                    href={explorer(detail.publicKey.toBase58(), "address")}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Заказ в Explorer ↗
                  </a>
                  <h3 className="history-title">Транзакции заказа</h3>
                  {historyLoading ? (
                    <p>Загрузка истории…</p>
                  ) : history.length === 0 ? (
                    <p>RPC не вернул историю транзакций.</p>
                  ) : (
                    <ul className="history">
                      {history.map((tx) => (
                        <li key={tx.signature}>
                          <a
                            href={explorer(tx.signature)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {short(tx.signature)} ↗
                          </a>
                          <span>
                            {tx.err
                              ? "Ошибка"
                              : tx.confirmationStatus === "finalized"
                                ? "Финализирована"
                                : tx.confirmationStatus === "confirmed"
                                  ? "Подтверждена"
                                  : "Подтверждается"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="actions">
                    {wallet &&
                      detail.account.freelancer.equals(wallet.publicKey) &&
                      "funded" in detail.account.status && (
                        <>
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() =>
                              void run(() => act(wallet, detail, "submitWork"))
                            }
                          >
                            Работа выполнена
                          </button>
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(() => act(wallet, detail, "allowCancel"))
                            }
                          >
                            Согласовать отмену
                          </button>
                        </>
                      )}
                    {wallet &&
                      detail.account.client.equals(wallet.publicKey) &&
                      "submitted" in detail.account.status && (
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() =>
                            void run(() => act(wallet, detail, "release"))
                          }
                        >
                          Принять работу и выплатить
                        </button>
                      )}
                    {wallet &&
                      detail.account.client.equals(wallet.publicKey) &&
                      "cancelApproved" in detail.account.status && (
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() =>
                            void run(() => act(wallet, detail, "refund"))
                          }
                        >
                          Вернуть средства
                        </button>
                      )}
                  </div>
                  <p className="warning">
                    Арбитража нет. Отмена возможна с согласия исполнителя
                    до сдачи работы.
                  </p>
                </>
              )
            )}
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            {busy && <p role="status">{notice}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
