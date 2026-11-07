import { useState } from "react";
import SwapPanel from "./SwapPanel";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { utils } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { ArrowDownUp, ExternalLink, ShieldCheck } from "lucide-react";
import {
  assertDevnet,
  buildLiquidityTransaction,
  formatUnits,
  loadPool,
  parseUnits,
  quoteDeposit,
  quoteWithdraw,
  walletBalances,
  type Pool,
  type Quote,
} from "../../shared/defi";
const endpoint =
  import.meta.env.VITE_DEFI_RPC_URL || "https://api.devnet.solana.com";
const url = new URL(endpoint);
if (
  url.protocol !== "https:" ||
  !["api.devnet.solana.com", "devnet.helius-rpc.com"].includes(url.hostname)
)
  throw Error("DeFi RPC должен быть официальным Devnet RPC или Helius Devnet.");
const connection = new Connection(endpoint, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});
const explorer = (id: string, kind = "tx") =>
  `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
async function waitForConfirmation(signature: string) {
  for (let i = 0; i < 60; i++) {
    const status = (
      await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err) throw Error(JSON.stringify(status.err));
    if (
      status &&
      ["confirmed", "finalized"].includes(status.confirmationStatus || "")
    )
      return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error(
    "Подтверждение ещё не получено. Проверьте подпись в Explorer перед повторной отправкой.",
  );
}
export default function DeFiPanel() {
  const wallet = useAnchorWallet();
  const [poolId, setPoolId] = useState(import.meta.env.VITE_DEFI_POOL_ID || ""),
    [pool, setPool] = useState<Pool | null>(null),
    [balances, setBalances] = useState<bigint[]>([]);
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit"),
    [value, setValue] = useState(""),
    [bps, setBps] = useState("50"),
    [quote, setQuote] = useState<Quote | null>(null),
    [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [signature, setSignature] = useState("");
  async function refresh(address: PublicKey) {
    const data = await loadPool(connection, address);
    setPool(data);
    if (wallet)
      setBalances(await walletBalances(connection, data, wallet.publicKey));
    return data;
  }
  async function load() {
    setBusy(true);
    setError("");
    setQuote(null);
    setPool(null);
    setBalances([]);
    setNotice("");
    try {
      await assertDevnet(connection);
      await refresh(new PublicKey(poolId));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function calculate() {
    if (!pool) return;
    setBusy(true);
    setError("");
    setQuote(null);
    try {
      const data = await refresh(pool.address);
      setQuote(
        mode === "deposit"
          ? quoteDeposit(data, parseUnits(value, data.decimalsA), Number(bps))
          : quoteWithdraw(
              data,
              parseUnits(value, data.decimalsLp),
              Number(bps),
            ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (!wallet || !quote || !consent) return;
    setBusy(true);
    setError("");
    setSignature("");
    setNotice("Подтвердите транзакцию в Phantom…");
    try {
      const tx = await buildLiquidityTransaction(
        connection,
        wallet.publicKey,
        quote,
      );
      const signed = await wallet.signTransaction(tx);
      if (!signed.signature) throw Error("Кошелёк не подписал транзакцию.");
      setSignature(utils.bytes.bs58.encode(signed.signature));
      setQuote(null);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 2,
      });
      setSignature(sig);
      setNotice("Отправлено в Devnet. Ожидаем подтверждения…");
      setQuote(null);
      await waitForConfirmation(sig);
      window.dispatchEvent(
        new CustomEvent("trustpay:transaction-confirmed", {
          detail: { network: "devnet", signature: sig },
        }),
      );
      setNotice("Транзакция подтверждена в Devnet.");
      setConsent(false);
      try {
        await refresh(quote.pool.address);
      } catch (e) {
        setError(
          "Транзакция подтверждена, но обновить данные не удалось: " +
            String(e),
        );
      }
    } catch (e) {
      setError(String(e));
      setNotice("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="defi">
      <div className="intro">
        <div>
          <div className="eyebrow">НЕДЕЛЯ 9 · RAYDIUM CPMM</div>
          <h1>
            Свободные средства. Новые возможности<span>.</span>
          </h1>
          <p>
            Предоставляйте ликвидность в реальный DeFi-протокол на Solana
            Devnet.
          </p>
        </div>
        <span className="defi-network">● Solana Devnet</span>
      </div>
      <div className="defi-boundary">
        <ShieldCheck size={22} />
        <div>
          <strong>Escrow остаётся в escrow.</strong>
          <p>
            Этот раздел использует только свободные тестовые SPL-токены вашего
            кошелька. Средства заказов и их vault недоступны для DeFi.
          </p>
        </div>
      </div>
      <section className="projects defi-card">
        <div className="section-heading">
          <div>
            <h2>
              Ликвидность Raydium <ArrowDownUp size={17} />
            </h2>
            <p>
              Без обещаний доходности. LP может потерять стоимость относительно
              хранения токенов.
            </p>
          </div>
          <a
            href="https://github.com/raydium-io/raydium-cp-swap"
            target="_blank"
            rel="noreferrer"
          >
            Протокол <ExternalLink size={13} />
          </a>
        </div>
        <form
          className="pool-form"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <label>
            Адрес CPMM-пула Devnet
            <input
              name="pool"
              value={poolId}
              onChange={(e) => {
                setPoolId(e.target.value);
                setPool(null);
                setQuote(null);
                setBalances([]);
              }}
              disabled={busy}
              placeholder="Публичный адрес пула Raydium"
              required
            />
          </label>
          <button className="secondary" disabled={busy || !poolId}>
            Загрузить пул
          </button>
        </form>
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
            href={explorer(signature)}
            target="_blank"
            rel="noreferrer"
          >
            Транзакция Devnet: {signature.slice(0, 8)}…{" "}
            <ExternalLink size={13} />
          </a>
        )}
        {!pool ? (
          <div className="empty">
            <ArrowDownUp size={30} />
            <h3>
              {busy ? "Проверяем пул в Devnet…" : "Выберите настоящий пул"}
            </h3>
            <p>
              Данные и резервы поступают из RPC. Для учебной пары используйте
              скрипт подготовки из отчёта недели 9.
            </p>
          </div>
        ) : (
          <>
            <div className="defi-pool">
              <a
                href={explorer(pool.address.toBase58(), "address")}
                target="_blank"
                rel="noreferrer"
              >
                Пул: {pool.address.toBase58()} ↗
              </a>
              <div className="defi-assets">
                {[
                  [
                    pool.state.mintA,
                    pool.reserveA,
                    pool.decimalsA,
                    "Токен A",
                    balances[0],
                  ],
                  [
                    pool.state.mintB,
                    pool.reserveB,
                    pool.decimalsB,
                    "Токен B",
                    balances[1],
                  ],
                  [
                    pool.state.mintLp,
                    pool.supply,
                    pool.decimalsLp,
                    "LP-токен",
                    balances[2],
                  ],
                ].map(([mint, reserve, decimals, label, balance]) => (
                  <div key={String(label)}>
                    <strong>{String(label)}</strong>
                    <a
                      href={explorer(String(mint), "address")}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {String(mint)}
                    </a>
                    <small>
                      {label === "LP-токен"
                        ? "LP supply протокола"
                        : "Резерв пула"}
                      : {formatUnits(reserve as bigint, decimals as number)}
                    </small>
                    <p>
                      В вашем кошельке:{" "}
                      {wallet && balance !== undefined
                        ? formatUnits(balance as bigint, decimals as number)
                        : "Подключите кошелёк"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            {!wallet ? (
              <div className="defi-connect">
                <WalletMultiButton />
              </div>
            ) : (
              <div className="defi-operation">
                <div className="tabs">
                  {(["deposit", "withdraw"] as const).map((m) => (
                    <button
                      key={m}
                      disabled={busy}
                      className={mode === m ? "selected" : ""}
                      onClick={() => {
                        setMode(m);
                        setQuote(null);
                        setValue("");
                        setConsent(false);
                      }}
                    >
                      {m === "deposit"
                        ? "Внести ликвидность"
                        : "Вывести ликвидность"}
                    </button>
                  ))}
                </div>
                <form
                  className="liquidity-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void calculate();
                  }}
                >
                  <label>
                    {mode === "deposit"
                      ? "Количество токена A"
                      : "Количество LP для вывода"}
                    <input
                      name="amount"
                      value={value}
                      disabled={busy}
                      onChange={(e) => {
                        setValue(e.target.value);
                        setQuote(null);
                      }}
                      inputMode="decimal"
                      required
                      placeholder="0.00"
                    />
                  </label>
                  <label>
                    Slippage (bps, 50 = 0,5%)
                    <input
                      name="slippage"
                      value={bps}
                      disabled={busy}
                      onChange={(e) => {
                        setBps(e.target.value);
                        setQuote(null);
                      }}
                      type="number"
                      min="1"
                      max="500"
                      required
                    />
                  </label>
                  <button className="secondary" disabled={busy}>
                    Рассчитать
                  </button>
                </form>
                {quote && (
                  <div className="defi-quote">
                    <h3>
                      {quote.kind === "deposit"
                        ? "Вы вносите пару токенов"
                        : "Вы получаете пару токенов"}
                    </h3>
                    <dl>
                      <div>
                        <dt>Расчётное количество A / B</dt>
                        <dd>
                          {formatUnits(quote.amountA, pool.decimalsA)} /{" "}
                          {formatUnits(quote.amountB, pool.decimalsB)}
                        </dd>
                      </div>
                      <div>
                        <dt>
                          {quote.kind === "deposit"
                            ? "Максимум списания A / B"
                            : "Минимум получения A / B"}
                        </dt>
                        <dd>
                          {formatUnits(quote.limitA, pool.decimalsA)} /{" "}
                          {formatUnits(quote.limitB, pool.decimalsB)}
                        </dd>
                      </div>
                      <div>
                        <dt>
                          LP{" "}
                          {quote.kind === "deposit"
                            ? "к получению"
                            : "к сжиганию"}
                        </dt>
                        <dd>{formatUnits(quote.lp, pool.decimalsLp)}</dd>
                      </div>
                    </dl>
                    <p>
                      Quote действует 60 секунд. Нужны Devnet SOL на комиссию и
                      создание token accounts. Если цена выйдет за лимиты,
                      транзакция отклонится.
                    </p>
                    <label className="consent">
                      <input
                        type="checkbox"
                        checked={consent}
                        disabled={busy}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      Использую только свои свободные тестовые токены и понимаю
                      риск LP и непостоянных потерь.
                    </label>
                    <button
                      className="primary"
                      disabled={busy || !consent}
                      onClick={() => void execute()}
                    >
                      {quote.kind === "deposit"
                        ? "Подтвердить депозит"
                        : "Подтвердить вывод"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>
      <SwapPanel connection={connection} />
      <p className="defi-footnote">
        APR не рассчитывается: данных для подтверждённой оценки доходности нет.
        Депозит LP не гарантирует прибыль. Только тестовые токены, без Mainnet.
      </p>
    </div>
  );
}
