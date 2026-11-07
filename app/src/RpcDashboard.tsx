import { useEffect, useMemo, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { type Idl } from "@coral-xyz/anchor";
import {
  RefreshCw,
  ExternalLink,
  Wallet,
  LockKeyhole,
  Layers,
  Activity,
} from "lucide-react";
import rawIdl from "./idl.json";
import {
  ensureTestNetwork,
  validateTestEndpoint,
  rpcRetry,
  safeRpcError,
  readProgram,
  fetchWalletSnapshot,
  fetchRecentHistory,
  type WalletSnapshot,
  type HistoryItem,
  type TestNetwork,
} from "../../shared/rpc";
import {
  loadLiquidity,
  liquidityAddresses,
  buildVaultTransaction,
  sendVaultTransaction,
  TRANSACTION_CONFIRMED_EVENT,
  type LiquiditySnapshot,
} from "../../shared/liquidity";
import { formatUnits, parseUnits } from "../../shared/defi";
const idl = rawIdl as Idl;
const defaultMint = import.meta.env.VITE_LIQUIDITY_MINT || "";
const devnetRpc =
  import.meta.env.VITE_DASHBOARD_RPC_URL || "https://api.devnet.solana.com";
const localRpc = "http://127.0.0.1:8899";
const statuses: Record<string, string> = {
  funded: "В работе",
  submitted: "На проверке",
  cancelApproved: "Отмена согласована",
  paid: "Оплачен",
  refunded: "Возвращён",
};
type RpcOrder = {
  publicKey: PublicKey;
  account: {
    client: PublicKey;
    freelancer: PublicKey;
    mint: PublicKey;
    title: string;
    amount: { toString(): string };
    id: { toString(): string };
    status: Record<string, unknown>;
  };
};
type Data = {
  wallet: WalletSnapshot;
  deployment: "deployed" | "missing" | "unavailable";
  orders: RpcOrder[] | null;
  vault: LiquiditySnapshot | null;
  vaultAvailable: boolean;
  mintDecimals: number | null;
  activity: ConfirmedSignatureInfo[] | null;
  warnings: string[];
  updatedAt: string;
};
export default function RpcDashboard() {
  const wallet = useAnchorWallet();
  const [network, setNetwork] = useState<TestNetwork>("devnet"),
    [mintInput, setMintInput] = useState(defaultMint),
    [mintAddress, setMintAddress] = useState(defaultMint),
    [revision, setRevision] = useState(0);
  const [data, setData] = useState<Data | null>(null),
    [history, setHistory] = useState<HistoryItem[] | null>(null),
    [loading, setLoading] = useState(false),
    [historyLoading, setHistoryLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [historyError, setHistoryError] = useState(""),
    [notice, setNotice] = useState(""),
    [signature, setSignature] = useState("");
  const [amount, setAmount] = useState(""),
    [action, setAction] = useState<"deposit" | "withdraw">("deposit"),
    [historyTab, setHistoryTab] = useState<"all" | "vault" | "escrow">("all");
  const [consent, setConsent] = useState(false);
  const connection = useMemo(
    () =>
      new Connection(
        validateTestEndpoint(
          network === "devnet" ? devnetRpc : localRpc,
          network,
        ),
        {
          commitment: "confirmed",
          disableRetryOnRateLimit: true,
          fetch: (url, options) =>
            fetch(url, { ...options, signal: AbortSignal.timeout(15000) }),
        },
      ),
    [network],
  );
  const explorer = (id: string, kind = "address") =>
    `https://explorer.solana.com/${kind}/${id}?cluster=${network === "devnet" ? "devnet" : "custom&customUrl=" + encodeURIComponent(localRpc)}`;
  const publicKey = wallet?.publicKey.toBase58() || "";
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail || detail.network === network) setRevision((n) => n + 1);
    };
    window.addEventListener(TRANSACTION_CONFIRMED_EVENT, refresh);
    return () =>
      window.removeEventListener(TRANSACTION_CONFIRMED_EVENT, refresh);
  }, [network]);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setData(null);
    setHistory(null);
    setError("");
    setHistoryError("");
    setLoading(false);
    setHistoryLoading(false);
    if (!publicKey) return;
    setLoading(true);
    void (async () => {
      try {
        await ensureTestNetwork(connection, network);
        const owner = new PublicKey(publicKey),
          p = readProgram(connection, idl),
          warnings: string[] = [];
        const [walletResult, programResult] = await Promise.allSettled([
          fetchWalletSnapshot(connection, owner),
          rpcRetry(() => connection.getAccountInfo(p.programId)),
        ]);
        const walletData: WalletSnapshot =
          walletResult.status === "fulfilled"
            ? walletResult.value
            : {
                solLamports: null,
                tokens: null,
                warnings: [safeRpcError(walletResult.reason)],
              };
        warnings.push(...walletData.warnings);
        const deployment =
          programResult.status === "rejected"
            ? "unavailable"
            : programResult.value?.executable
              ? "deployed"
              : "missing";
        if (programResult.status === "rejected")
          warnings.push("Программа: " + safeRpcError(programResult.reason));
        let orders: RpcOrder[] | null = null,
          vault: LiquiditySnapshot | null = null,
          vaultAvailable = false,
          mintDecimals: number | null = null,
          activity: ConfirmedSignatureInfo[] | null = null;
        if (deployment === "deployed") {
          const orderClient = (
            p.account as unknown as {
              order: { all: (filters: unknown[]) => Promise<RpcOrder[]> };
            }
          ).order;
          const tasks = await Promise.allSettled([
            (async () => {
              const [client, worker] = await Promise.all([
                rpcRetry(() =>
                  orderClient.all([
                    { memcmp: { offset: 8, bytes: publicKey } },
                  ]),
                ),
                rpcRetry(() =>
                  orderClient.all([
                    { memcmp: { offset: 40, bytes: publicKey } },
                  ]),
                ),
              ]);
              return [
                ...new Map(
                  [...client, ...worker].map((o) => [
                    o.publicKey.toBase58(),
                    o,
                  ]),
                ).values(),
              ];
            })(),
            (async () => {
              if (!mintAddress) return null;
              const mint = new PublicKey(mintAddress);
              const mintData = await rpcRetry(() => getMint(connection, mint));
              return {
                decimals: mintData.decimals,
                vault: await loadLiquidity(connection, p, mint, owner),
              };
            })(),
            rpcRetry(() =>
              connection.getSignaturesForAddress(p.programId, { limit: 12 }),
            ),
          ]);
          if (tasks[0].status === "fulfilled") orders = tasks[0].value;
          else warnings.push("Заказы: " + safeRpcError(tasks[0].reason));
          if (tasks[1].status === "fulfilled") {
            vault = tasks[1].value?.vault ?? null;
            mintDecimals = tasks[1].value?.decimals ?? null;
            vaultAvailable = tasks[1].value !== null;
          } else
            warnings.push("Liquidity Vault: " + safeRpcError(tasks[1].reason));
          if (tasks[2].status === "fulfilled") activity = tasks[2].value;
          else warnings.push("Активность: " + safeRpcError(tasks[2].reason));
        }
        if (!current) return;
        setData({
          wallet: walletData,
          deployment,
          orders,
          vault,
          vaultAvailable,
          mintDecimals,
          activity,
          warnings: [...new Set(warnings)],
          updatedAt: new Date().toLocaleTimeString("ru-RU"),
        });
        setLoading(false);
        setHistoryLoading(true);
        const addresses = [owner];
        if (vault)
          addresses.push(
            vault.address,
            vault.reserve,
            getAssociatedTokenAddressSync(vault.sharesMint, owner),
          );
        if (orders)
          addresses.push(...orders.slice(0, 4).map((o) => o.publicKey));
        // Incoming SPL transfers may reference a token account instead of its wallet.
        addresses.push(
          ...(walletData.tokens || [])
            .flatMap((t) => t.accounts)
            .slice(0, 2)
            .map((a) => new PublicKey(a)),
        );
        const result = await fetchRecentHistory(
          connection,
          p,
          addresses,
          12,
          controller.signal,
        );
        if (current) {
          setHistory(result.items);
          setHistoryError(result.warnings.join(" "));
        }
      } catch (e) {
        if (current) setError(safeRpcError(e));
      } finally {
        if (current) {
          setLoading(false);
          setHistoryLoading(false);
        }
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [publicKey, connection, network, mintAddress, revision]);
  useEffect(() => {
    setSignature("");
    setNotice("");
    setConsent(false);
    setAmount("");
  }, [publicKey, network, mintAddress]);
  const decimalsFor = (mint: string) =>
    data?.wallet.tokens?.find((t) => t.mint === mint)?.decimals ??
    (mint === mintAddress ? data?.mintDecimals : null);
  const tokenAmount = (raw: string, mint: string) => {
    const decimals = decimalsFor(mint);
    return decimals == null
      ? `${raw} минимальных единиц`
      : formatUnits(BigInt(raw), decimals);
  };
  const filteredHistory = history?.filter(
    (row) =>
      historyTab === "all" ||
      row.actions.some(
        (a) =>
          a.kind === historyTab &&
          (historyTab !== "vault" || a.actor === publicKey),
      ),
  );
  function describeAction(item: HistoryItem["actions"][number]) {
    if (item.amount)
      return (
        item.name +
        " · " +
        (item.mint
          ? tokenAmount(item.amount, item.mint)
          : item.amount + " минимальных единиц")
      );
    const order = data?.orders?.find(
      (order) => order.publicKey.toBase58() === item.order,
    );
    if (
      order &&
      ["createOrder", "release", "refund"].includes(item.instruction || "")
    )
      return (
        item.name +
        " · " +
        tokenAmount(
          order.account.amount.toString(),
          order.account.mint.toBase58(),
        )
      );
    return item.name;
  }
  async function transact(kind: "initialize" | "deposit" | "withdraw") {
    if (!wallet || !data) return;
    setBusy(true);
    setError("");
    setSignature("");
    setNotice("Подтвердите транзакцию в кошельке…");
    try {
      const mint = new PublicKey(mintAddress);
      const value =
        kind === "initialize" ? 0n : parseUnits(amount, data.mintDecimals!);
      const tx = await buildVaultTransaction(
        connection,
        wallet,
        idl,
        network,
        mint,
        kind,
        value,
      );
      await sendVaultTransaction(connection, wallet, tx, (sig) => {
        setSignature(sig);
        setNotice("Транзакция подписана. Проверяем отправку и подтверждение…");
      });
      setNotice("Транзакция подтверждена. Данные обновляются из RPC.");
      setConsent(false);
      setAmount("");
      setRevision((n) => n + 1);
    } catch (e) {
      setError(safeRpcError(e));
      setNotice("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rpc-dashboard">
      <div className="intro">
        <div>
          <div className="eyebrow">НЕДЕЛЯ 10 · CPI + BLOCKCHAIN DATA</div>
          <h1>
            Ваши средства. Прозрачно<span>.</span>
          </h1>
          <p>Реальные балансы, добровольные депозиты и активность TrustPay.</p>
        </div>
        <div className="rpc-toolbar">
          <label>
            Сеть
            <select
              aria-label="Сеть"
              value={network}
              disabled={busy}
              onChange={(e) => {
                setNetwork(e.target.value as TestNetwork);
                const mint =
                  e.target.value === "devnet"
                    ? defaultMint
                    : import.meta.env.VITE_TEST_MINT || "";
                setMintAddress(mint);
                setMintInput(mint);
              }}
            >
              <option value="devnet">Solana Devnet</option>
              <option value="localnet">Local validator</option>
            </select>
          </label>
          <button
            className="secondary"
            disabled={!wallet || loading || historyLoading || busy}
            onClick={() => setRevision((n) => n + 1)}
          >
            <RefreshCw
              size={15}
              className={loading || historyLoading ? "spin" : ""}
            />
            Обновить RPC
          </button>
        </div>
      </div>
      {!wallet ? (
        <section className="projects">
          <div className="empty">
            <Wallet size={32} />
            <h3>Подключите кошелёк для чтения blockchain-данных</h3>
            <p>
              До подключения балансы не рассчитываются. Источник данных —
              выбранная тестовая сеть.
            </p>
            <WalletMultiButton />
          </div>
        </section>
      ) : (
        <>
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
              href={explorer(signature, "tx")}
              target="_blank"
              rel="noreferrer"
            >
              Подпись транзакции: {signature.slice(0, 8)}…{" "}
              <ExternalLink size={13} />
            </a>
          )}
          {loading && (
            <div className="rpc-loading" role="status">
              Загрузка данных из{" "}
              {network === "devnet" ? "Devnet" : "local validator"}…
            </div>
          )}
          {data && (
            <>
              {data.warnings.length > 0 && (
                <div className="rpc-warnings" role="alert">
                  {data.warnings.map((warning, i) => (
                    <p key={i}>{warning}</p>
                  ))}
                </div>
              )}
              {data.deployment === "missing" && (
                <div className="setup">
                  TrustPay ещё не развёрнут в этой сети. SOL/SPL-балансы и
                  история кошелька доступны; Vault и заказы появятся после
                  развёртывания.
                </div>
              )}
              <div className="rpc-asof">
                Источник:{" "}
                {network === "devnet" ? "Solana Devnet" : "локальный validator"}{" "}
                · Обновлено {data.updatedAt} ·{" "}
                <a href={explorer(publicKey)} target="_blank" rel="noreferrer">
                  Кошелёк ↗
                </a>
              </div>
              <section className="stats rpc-stats">
                <div>
                  <span className="stat-icon">
                    <Wallet size={20} />
                  </span>
                  <p>SOL кошелька</p>
                  <strong data-testid="sol-balance">
                    {data.wallet.solLamports === null
                      ? "—"
                      : formatUnits(data.wallet.solLamports, 9)}
                  </strong>
                  <small>
                    {network === "devnet"
                      ? "Devnet SOL · тестовые"
                      : "Local SOL · тестовые"}
                  </small>
                </div>
                <div>
                  <span className="stat-icon amber">
                    <LockKeyhole size={20} />
                  </span>
                  <p>Доступно из Vault</p>
                  <strong data-testid="user-deposit">
                    {data.vault
                      ? formatUnits(data.vault.userShares, data.vault.decimals)
                      : "—"}
                  </strong>
                  <small>Право вывода по shares 1:1</small>
                </div>
                <div>
                  <span className="stat-icon blue">
                    <Layers size={20} />
                  </span>
                  <p>Ваши share-токены</p>
                  <strong data-testid="share-balance">
                    {data.vault
                      ? formatUnits(data.vault.userShares, data.vault.decimals)
                      : "—"}
                  </strong>
                  <small>Не LP Raydium · отдельный mint</small>
                </div>
              </section>
              <section className="projects rpc-vault">
                <div className="section-heading">
                  <div>
                    <h2>Liquidity Vault · CPI</h2>
                    <p>
                      Добровольные SPL-депозиты, фиксированные shares 1:1. Без
                      доходности и доступа к escrow.
                    </p>
                  </div>
                  <span className="badge">
                    {network === "devnet" ? "Devnet" : "Localnet"}
                  </span>
                </div>
                <form
                  className="pool-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setMintAddress(mintInput.trim());
                    if (mintInput.trim() === mintAddress)
                      setRevision((n) => n + 1);
                  }}
                >
                  <label>
                    Underlying mint
                    <input
                      value={mintInput}
                      disabled={busy}
                      onChange={(e) => setMintInput(e.target.value)}
                      placeholder="Публичный адрес classic SPL mint"
                      required
                      list="wallet-mints"
                    />
                  </label>
                  <datalist id="wallet-mints">
                    {data.wallet.tokens
                      ?.filter((t) => t.program === TOKEN_PROGRAM_ID.toBase58())
                      .map((t) => (
                        <option key={t.mint} value={t.mint}>
                          {formatUnits(t.amount, t.decimals)}
                        </option>
                      ))}
                  </datalist>
                  <button className="secondary" disabled={busy || loading}>
                    Загрузить Vault
                  </button>
                </form>
                {data.vault ? (
                  <>
                    <div className="rpc-vault-details">
                      <a
                        href={explorer(data.vault.address.toBase58())}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Vault PDA: {data.vault.address.toBase58()} ↗
                      </a>
                      <a
                        href={explorer(data.vault.sharesMint.toBase58())}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Share mint: {data.vault.sharesMint.toBase58()} ↗
                      </a>
                      <div className="rpc-vault-numbers">
                        <span>
                          Резерв Vault{" "}
                          <strong data-testid="vault-reserve">
                            {formatUnits(
                              data.vault.reserveAmount,
                              data.vault.decimals,
                            )}
                          </strong>
                        </span>
                        <span>
                          Всего shares{" "}
                          <strong>
                            {formatUnits(
                              data.vault.shareSupply,
                              data.vault.decimals,
                            )}
                          </strong>
                        </span>
                        <span>
                          Свободно в ATA{" "}
                          <strong>
                            {formatUnits(
                              data.vault.userTokens,
                              data.vault.decimals,
                            )}
                          </strong>
                        </span>
                      </div>
                      <small>
                        Состояние RPC slot {data.vault.slot}. Излишки,
                        отправленные напрямую, не увеличивают ваши shares.
                      </small>
                    </div>
                    <div className="tabs">
                      {(["deposit", "withdraw"] as const).map((type) => (
                        <button
                          key={type}
                          disabled={busy}
                          className={action === type ? "selected" : ""}
                          onClick={() => {
                            setAction(type);
                            setAmount("");
                            setConsent(false);
                          }}
                        >
                          {type === "deposit"
                            ? "Добровольный депозит"
                            : "Вывод"}
                        </button>
                      ))}
                    </div>
                    <form
                      className="liquidity-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void transact(action);
                      }}
                    >
                      <label>
                        {action === "deposit"
                          ? "Сумма добровольного депозита"
                          : "Сумма вывода shares 1:1"}
                        <input
                          value={amount}
                          disabled={busy}
                          onChange={(e) => setAmount(e.target.value)}
                          inputMode="decimal"
                          required
                          placeholder="0.00"
                        />
                      </label>
                      <label className="rpc-consent">
                        <input
                          type="checkbox"
                          required
                          checked={consent}
                          disabled={busy}
                          onChange={(e) => setConsent(e.target.checked)}
                        />
                        Только свободные тестовые средства; escrow не
                        используется.
                      </label>
                      <button
                        className="primary"
                        disabled={busy || loading || !consent}
                      >
                        {action === "deposit"
                          ? "Внести в Vault"
                          : "Сжечь shares и вывести"}
                      </button>
                    </form>
                  </>
                ) : (
                  <div className="rpc-vault-empty">
                    <p>
                      {!mintAddress
                        ? "Выберите mint добровольного депозита."
                        : data.deployment !== "deployed"
                          ? "Vault недоступен до развёртывания программы."
                          : !data.vaultAvailable
                            ? "Не удалось прочитать mint/Vault. Проверьте ошибки RPC выше."
                            : "Vault этого mint ещё не создан."}
                    </p>
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        loading ||
                        data.deployment !== "deployed" ||
                        !data.vaultAvailable
                      }
                      onClick={() => void transact("initialize")}
                    >
                      Создать отдельный Vault
                    </button>
                  </div>
                )}
              </section>
              <section className="projects rpc-section">
                <div className="section-heading">
                  <div>
                    <h2>SPL-токены кошелька</h2>
                    <p>
                      Сумма по token accounts одного mint. Classic SPL и
                      Token-2022.
                    </p>
                  </div>
                </div>
                {data.wallet.tokens === null ? (
                  <p className="rpc-padding">Балансы токенов недоступны.</p>
                ) : data.wallet.tokens.length === 0 ? (
                  <p className="rpc-padding">
                    Загруженные RPC-ответы не содержат token accounts.
                  </p>
                ) : (
                  <div className="rpc-table-wrap">
                    <table className="rpc-table">
                      <thead>
                        <tr>
                          <th>Mint</th>
                          <th>Баланс</th>
                          <th>Стандарт / accounts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.wallet.tokens.map((t) => (
                          <tr key={t.program + ":" + t.mint}>
                            <td>
                              <a
                                href={explorer(t.mint)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {t.mint.slice(0, 8)}…{t.mint.slice(-6)} ↗
                              </a>
                            </td>
                            <td>{formatUnits(t.amount, t.decimals)}</td>
                            <td>
                              {t.program === TOKEN_PROGRAM_ID.toBase58()
                                ? "SPL Token"
                                : "Token-2022"}{" "}
                              · {t.accounts.length}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section className="projects rpc-section">
                <div className="section-heading">
                  <div>
                    <h2>Escrow-заказы</h2>
                    <p>Заказы этого кошелька в выбранной сети; обе роли.</p>
                  </div>
                </div>
                {data.orders === null ? (
                  <p className="rpc-padding">Данные заказов недоступны.</p>
                ) : data.orders.length === 0 ? (
                  <p className="rpc-padding">Заказов в этой сети пока нет.</p>
                ) : (
                  <div className="rpc-table-wrap">
                    <table className="rpc-table">
                      <thead>
                        <tr>
                          <th>Заказ</th>
                          <th>Статус</th>
                          <th>Сумма</th>
                          <th>Роль</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.orders.map((o) => (
                          <tr key={o.publicKey.toBase58()}>
                            <td>
                              <a
                                href={explorer(o.publicKey.toBase58())}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {o.account.title} ↗
                              </a>
                            </td>
                            <td>
                              {statuses[Object.keys(o.account.status)[0]] ||
                                "Неизвестный статус"}
                            </td>
                            <td>
                              {tokenAmount(
                                o.account.amount.toString(),
                                o.account.mint.toBase58(),
                              )}
                            </td>
                            <td>
                              {o.account.client.toBase58() === publicKey
                                ? "Заказчик"
                                : "Исполнитель"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section className="projects rpc-section">
                <div className="section-heading">
                  <div>
                    <h2>История транзакций</h2>
                    <p>
                      Последние 12 уникальных записей: кошелёк и до 8 связанных
                      адресов. Это ограниченное окно RPC, не полная архивная
                      история.
                    </p>
                  </div>
                </div>
                <div className="tabs">
                  {(
                    [
                      ["all", "Все"],
                      ["vault", "Депозиты / выводы Vault"],
                      ["escrow", "Escrow-платежи"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      className={historyTab === key ? "selected" : ""}
                      onClick={() => setHistoryTab(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {historyLoading ? (
                  <p className="rpc-padding" role="status">
                    Загрузка транзакций…
                  </p>
                ) : (
                  historyError && (
                    <div className="rpc-warnings">{historyError}</div>
                  )
                )}
                {!historyLoading &&
                  (filteredHistory == null ? (
                    <p className="rpc-padding">История недоступна.</p>
                  ) : filteredHistory.length === 0 ? (
                    <p className="rpc-padding">
                      В загруженном окне нет транзакций этой категории.
                    </p>
                  ) : (
                    <div className="rpc-table-wrap">
                      <table className="rpc-table">
                        <thead>
                          <tr>
                            <th>Транзакция / операция</th>
                            <th>Время</th>
                            <th>Результат</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredHistory.map((row) => (
                            <tr key={row.signature}>
                              <td>
                                <a
                                  href={explorer(row.signature, "tx")}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {row.signature.slice(0, 8)}… ↗
                                </a>
                                <small>
                                  {row.actions.length
                                    ? row.actions.map(describeAction).join("; ")
                                    : row.detailsAvailable
                                      ? "Прочая транзакция"
                                      : "Детали RPC не вернул"}
                                </small>
                              </td>
                              <td>
                                {row.blockTime
                                  ? new Date(
                                      row.blockTime * 1000,
                                    ).toLocaleString("ru-RU")
                                  : "Время недоступно"}
                              </td>
                              <td>
                                {row.err
                                  ? "Ошибка"
                                  : row.status === "finalized"
                                    ? "Финализирована"
                                    : row.status === "confirmed"
                                      ? "Подтверждена"
                                      : "Статус недоступен"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
              </section>
              <section className="projects rpc-section">
                <div className="section-heading">
                  <div>
                    <h2>
                      <Activity size={17} /> Активность TrustPay Program
                    </h2>
                    <p>
                      Последние 12 записей всей программы, включая других
                      пользователей.
                    </p>
                  </div>
                  <a
                    href={explorer(idl.address)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Program Explorer ↗
                  </a>
                </div>
                {data.activity === null ? (
                  <p className="rpc-padding">
                    Активность программы недоступна.
                  </p>
                ) : data.activity.length === 0 ? (
                  <p className="rpc-padding">
                    RPC не вернул транзакций программы.
                  </p>
                ) : (
                  <ul className="rpc-activity">
                    {data.activity.map((tx) => (
                      <li key={tx.signature}>
                        <a
                          href={explorer(tx.signature, "tx")}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {tx.signature.slice(0, 10)}… ↗
                        </a>
                        <span>slot {tx.slot}</span>
                        <span>
                          {tx.err
                            ? "Ошибка"
                            : tx.confirmationStatus === "finalized"
                              ? "Финализирована"
                              : "Подтверждена"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
