import { useEffect, useRef, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Connection, PublicKey } from "@solana/web3.js";
import { ArrowDownUp, ExternalLink, Waves } from "lucide-react";
import Decimal from "decimal.js";
import {
  MARKET_POOLS,
  loadAmmMarket,
  loadClmmMarket,
  ammQuote,
  ammSpot,
  clmmRange,
  type Market,
} from "../../shared/market";
import { formatUnits, parseUnits } from "../../shared/defi";
import {
  fetchWalletSnapshot,
  safeRpcError,
  validateTestEndpoint,
  type WalletSnapshot,
} from "../../shared/rpc";
const endpoint = validateTestEndpoint(
  import.meta.env.VITE_DEFI_RPC_URL || "https://api.devnet.solana.com",
  "devnet",
);
const c = new Connection(endpoint, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
  fetch: (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(15000) }),
});
const link = (id: string) =>
  `https://explorer.solana.com/address/${id}?cluster=devnet`;
const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-5)}`;
const pretty = (s: string) => new Decimal(s).toSignificantDigits(8).toString();
export default function LiquidityPanel({ onLp }: { onLp: () => void }) {
  const wallet = useAnchorWallet();
  const [kind, setKind] = useState<"cpmm" | "clmm">("cpmm"),
    [address, setAddress] = useState<string>(MARKET_POOLS[0].address);
  const [market, setMarket] = useState<Market | null>(null),
    [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [amount, setAmount] = useState("1"),
    [bps, setBps] = useState("50"),
    [direction, setDirection] = useState("ab"),
    [lower, setLower] = useState(""),
    [upper, setUpper] = useState(""),
    [budgetA, setBudgetA] = useState("1"),
    [budgetB, setBudgetB] = useState("1");
  const [amm, setAmm] = useState<ReturnType<typeof ammQuote> | null>(null),
    [range, setRange] = useState<ReturnType<typeof clmmRange> | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const clearQuotes = () => {
    setAmm(null);
    setRange(null);
    setError("");
  };
  function select(value: string) {
    generation.current++;
    setBusy(false);
    setMarket(null);
    setSnapshot(null);
    clearQuotes();
    const item = MARKET_POOLS.find((p) => p.address === value);
    if (item) {
      setKind(item.kind);
      setAddress(item.address);
    }
  }
  async function refresh() {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    setMarket(null);
    setSnapshot(null);
    setAmm(null);
    setRange(null);
    try {
      const id = new PublicKey(address);
      const data =
        kind === "cpmm"
          ? await loadAmmMarket(c, id)
          : await loadClmmMarket(c, id);
      if (request !== generation.current) return;
      setMarket(data);
      if (data.kind === "clmm") {
        setLower(
          new Decimal(data.price).mul("0.9").toSignificantDigits(20).toString(),
        );
        setUpper(
          new Decimal(data.price).mul("1.1").toSignificantDigits(20).toString(),
        );
      }
      if (wallet) {
        const result = await fetchWalletSnapshot(c, wallet.publicKey);
        if (request === generation.current) setSnapshot(result);
      }
    } catch (e) {
      if (request === generation.current) setError(safeRpcError(e));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  function calculate() {
    clearQuotes();
    if (!market) return;
    try {
      if (Date.now() - market.readAt > 60000)
        throw Error("Данные старше 60 секунд. Обновите пул перед расчётом.");
      if (market.kind === "cpmm")
        setAmm(
          ammQuote(
            market,
            parseUnits(
              amount,
              direction === "ab"
                ? market.pool.decimalsA
                : market.pool.decimalsB,
            ),
            Number(bps),
            direction === "ab",
          ),
        );
      else
        setRange(
          clmmRange(
            market,
            lower,
            upper,
            budgetA === "0" ? 0n : parseUnits(budgetA, market.decimalsA),
            budgetB === "0" ? 0n : parseUnits(budgetB, market.decimalsB),
          ),
        );
    } catch (e) {
      setError(safeRpcError(e));
    }
  }
  const state = market?.kind === "cpmm" ? market.pool.state : market?.state;
  const mintA = state?.mintA.toBase58(),
    mintB = state?.mintB.toBase58();
  const decimalsA =
      market?.kind === "cpmm" ? market.pool.decimalsA : market?.decimalsA || 0,
    decimalsB =
      market?.kind === "cpmm" ? market.pool.decimalsB : market?.decimalsB || 0;
  const balance = (mint: string | undefined, decimals: number) => {
    if (!wallet) return "Подключите кошелёк";
    if (!snapshot?.tokens) return "—";
    return formatUnits(
      snapshot.tokens
        .filter((t) => t.mint === mint)
        .reduce((s, t) => s + t.amount, 0n),
      decimals,
    );
  };
  return (
    <div className="defi liquidity-page">
      <div className="intro">
        <div>
          <div className="eyebrow">RAYDIUM · AMM / CLMM</div>
          <h1>
            Ликвидность в вашем диапазоне<span>.</span>
          </h1>
          <p>
            Резервы Devnet-пулов и расчёт диапазона позиции.
          </p>
        </div>
        <span className="defi-network">● Solana Devnet</span>
      </div>
      <div className="defi-boundary">
        <Waves size={24} />
        <div>
          <strong>Добровольная ликвидность отдельно от платежей.</strong>
          <p>
            Расчёты используют данные Raydium. Escrow и shares TrustPay не дают
            доступа к средствам этого раздела.
          </p>
        </div>
      </div>
      <section className="panel defi-card">
        <div className="section-heading">
          <h2>
            <ArrowDownUp size={20} />
            DeFi / Liquidity
          </h2>
          <button className="secondary" onClick={onLp}>
            Депозит / вывод CPMM LP
          </button>
        </div>
        <div className="market-catalog" aria-label="Доступные пулы">
          {MARKET_POOLS.map((p) => (
            <button
              key={p.address}
              className={
                address === p.address
                  ? "market-choice selected"
                  : "market-choice"
              }
              onClick={() => select(p.address)}
            >
              <span>{p.kind.toUpperCase()}</span>
              <strong>{p.label}</strong>
              <small>{short(p.address)} · Devnet</small>
            </button>
          ))}
        </div>
        <div className="pool-form">
          <label>
            Тип пула
            <select
              aria-label="Тип пула"
              value={kind}
              onChange={(e) => {
                generation.current++;
                setBusy(false);
                setKind(e.target.value as typeof kind);
                setMarket(null);
                setSnapshot(null);
                clearQuotes();
              }}
            >
              <option value="cpmm">Raydium CPMM</option>
              <option value="clmm">Raydium CLMM</option>
            </select>
          </label>
          <label>
            Адрес пула
            <input
              value={address}
              onChange={(e) => {
                generation.current++;
                setBusy(false);
                setAddress(e.target.value);
                setMarket(null);
                setSnapshot(null);
                clearQuotes();
              }}
              spellCheck={false}
            />
          </label>
          <button className="primary" disabled={busy} onClick={refresh}>
            {busy ? "Чтение RPC…" : "Обновить пул"}
          </button>
        </div>
        <p className="market-help">
          Каталог содержит публичные адреса. Наличие и состояние каждого пула
          проверяются через RPC при загрузке. Можно ввести другой адрес
          поддерживаемого Devnet-пула.
        </p>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        {!market && !busy && !error && (
          <div className="defi-pool">
            Выберите пул и нажмите «Обновить пул». Балансы появятся после чтения
            сети.
          </div>
        )}
        {market && state && (
          <>
            <div className="defi-pool">
              <a href={link(address)} target="_blank" rel="noreferrer">
                Пул: {address} <ExternalLink size={12} />
              </a>
              <p className="market-help">
                RPC slot {market.slot} ·{" "}
                {new Date(market.readAt).toLocaleTimeString()} ·
                последовательное чтение, данные могут измениться
              </p>
              <div className="defi-assets market-assets">
                <div>
                  <strong>Токен A</strong>
                  <a href={link(mintA!)} target="_blank" rel="noreferrer">
                    {mintA}
                  </a>
                  <p>
                    Резерв:{" "}
                    <b data-testid="market-reserve-a">
                      {formatUnits(
                        market.kind === "cpmm"
                          ? market.pool.reserveA
                          : market.reserveA,
                        decimalsA,
                      )}
                    </b>
                  </p>
                  <small>
                    Ваш баланс:{" "}
                    <span data-testid="market-balance-a">
                      {balance(mintA, decimalsA)}
                    </span>
                  </small>
                </div>
                <div>
                  <strong>Токен B</strong>
                  <a href={link(mintB!)} target="_blank" rel="noreferrer">
                    {mintB}
                  </a>
                  <p>
                    Резерв:{" "}
                    <b>
                      {formatUnits(
                        market.kind === "cpmm"
                          ? market.pool.reserveB
                          : market.reserveB,
                        decimalsB,
                      )}
                    </b>
                  </p>
                  <small>Ваш баланс: {balance(mintB, decimalsB)}</small>
                </div>
                <div>
                  <strong>Цена · B за 1 A</strong>
                  <p className="market-price" data-testid="market-price">
                    {pretty(
                      market.kind === "cpmm"
                        ? ammSpot(market.pool)
                        : market.price,
                    )}
                  </p>
                  <small>
                    Комиссия:{" "}
                    {market.kind === "cpmm"
                      ? new Decimal(market.feeRate.toString())
                          .div(10000)
                          .toString()
                      : market.feeRate / 10000}
                    %
                  </small>
                  <p>
                    {market.kind === "clmm"
                      ? `Активная L: ${market.state.liquidity.toString()} · tick ${market.state.tickCurrent}`
                      : `LP supply: ${formatUnits(market.pool.supply, market.pool.decimalsLp)}`}
                  </p>
                </div>
              </div>
              {market.kind === "clmm" && (
                <p className="market-help">
                  Резервы — баланс vault, включая накопленные комиссии; это не
                  TVL в USD и не активная ликвидность L. Активная L берётся из
                  PoolState. Статус пула: {market.state.status}.
                </p>
              )}
              {!wallet && <WalletMultiButton />}
              {wallet && (
                <p className="market-help">
                  SOL кошелька:{" "}
                  {snapshot?.solLamports === null || !snapshot
                    ? "—"
                    : formatUnits(snapshot.solLamports, 9)}{" "}
                  · {short(wallet.publicKey.toBase58())}
                </p>
              )}
              {snapshot?.warnings.map((w) => (
                <p role="status" className="error" key={w}>
                  {w}
                </p>
              ))}
            </div>
            {market.kind === "cpmm" ? (
              <>
                <div className="liquidity-form">
                  <label>
                    Направление
                    <select
                      aria-label="Направление"
                      value={direction}
                      onChange={(e) => {
                        setDirection(e.target.value);
                        clearQuotes();
                      }}
                    >
                      <option value="ab">A → B</option>
                      <option value="ba">B → A</option>
                    </select>
                  </label>
                  <label>
                    Количество для расчёта
                    <input
                      aria-label="Количество AMM"
                      value={amount}
                      onChange={(e) => {
                        setAmount(e.target.value);
                        clearQuotes();
                      }}
                      inputMode="decimal"
                    />
                  </label>
                  <label>
                    Slippage, bps
                    <input
                      aria-label="Slippage AMM"
                      value={bps}
                      onChange={(e) => {
                        setBps(e.target.value);
                        clearQuotes();
                      }}
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={calculate}
                  >
                    Рассчитать AMM
                  </button>
                </div>
                {amm && (
                  <div className="defi-quote" data-testid="amm-quote">
                    <h3>Предварительная котировка · без отправки обмена</h3>
                    <dl>
                      <div>
                        <dt>Ожидаемый выход</dt>
                        <dd>
                          {formatUnits(
                            amm.output,
                            direction === "ab" ? decimalsB : decimalsA,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Минимум при slippage {bps} bps</dt>
                        <dd>
                          {formatUnits(
                            amm.minimum,
                            direction === "ab" ? decimalsB : decimalsA,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Price impact без комиссии, с округлением</dt>
                        <dd>{pretty(amm.priceImpactPercent)}%</dd>
                      </div>
                      <div>
                        <dt>Цена исполнения, output / input</dt>
                        <dd>{pretty(amm.executionPrice)}</dd>
                      </div>
                      <div>
                        <dt>Комиссия во входном токене</dt>
                        <dd>
                          {formatUnits(
                            amm.fee,
                            direction === "ab" ? decimalsA : decimalsB,
                          )}
                        </dd>
                      </div>
                    </dl>
                    <p>
                      CPMM: x·y=k. Это локальный расчёт по RPC-резервам, не
                      транзакция и не гарантия исполнения. Для настоящих
                      операций ликвидности откройте «Депозит / вывод CPMM LP»;
                      после подтверждения там перечитайте пул здесь.
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="liquidity-form">
                  <label>
                    Нижняя цена B/A
                    <input
                      aria-label="Нижняя цена"
                      value={lower}
                      onChange={(e) => {
                        setLower(e.target.value);
                        clearQuotes();
                      }}
                    />
                  </label>
                  <label>
                    Верхняя цена B/A
                    <input
                      aria-label="Верхняя цена"
                      value={upper}
                      onChange={(e) => {
                        setUpper(e.target.value);
                        clearQuotes();
                      }}
                    />
                  </label>
                </div>
                <div className="liquidity-form">
                  <label>
                    Бюджет токена A
                    <input
                      aria-label="Бюджет A"
                      value={budgetA}
                      onChange={(e) => {
                        setBudgetA(e.target.value);
                        clearQuotes();
                      }}
                      inputMode="decimal"
                    />
                  </label>
                  <label>
                    Бюджет токена B
                    <input
                      aria-label="Бюджет B"
                      value={budgetB}
                      onChange={(e) => {
                        setBudgetB(e.target.value);
                        clearQuotes();
                      }}
                      inputMode="decimal"
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={calculate}
                  >
                    Рассчитать диапазон
                  </button>
                </div>
                {range && (
                  <div className="defi-quote" data-testid="clmm-quote">
                    <h3>
                      {range.active
                        ? "Цена внутри диапазона"
                        : "Цена вне диапазона"}
                    </h3>
                    <div className="range-track">
                      <span>{pretty(range.lowerPrice)}</span>
                      <strong>{pretty(market.price)} B/A</strong>
                      <span>{pretty(range.upperPrice)}</span>
                    </div>
                    <dl>
                      <div>
                        <dt>Ticks с шагом {market.state.tickSpacing}</dt>
                        <dd>
                          {range.tickLower} … {range.tickUpper}
                        </dd>
                      </div>
                      <div>
                        <dt>Необходимо A / B</dt>
                        <dd>
                          {formatUnits(range.amountA, decimalsA)} /{" "}
                          {formatUnits(range.amountB, decimalsB)}
                        </dd>
                      </div>
                      <div>
                        <dt>Неиспользованный бюджет A / B</dt>
                        <dd>
                          {formatUnits(range.unusedA, decimalsA)} /{" "}
                          {formatUnits(range.unusedB, decimalsB)}
                        </dd>
                      </div>
                      <div>
                        <dt>Расчётная L</dt>
                        <dd>{range.liquidity}</dd>
                      </div>
                      <div>
                        <dt>Потенциальная доля активной L при текущей цене</dt>
                        <dd>{pretty(range.potentialSharePercent)}%</dd>
                      </div>
                    </dl>
                    <p>
                      Доля = L позиции / (текущая активная L + L позиции) только
                      внутри диапазона. Это не доля TVL, не доля всех позиций и
                      не прогноз доходности. Границы округлены наружу к ticks
                      протокола.
                    </p>
                  </div>
                )}
                <div className="market-limitation">
                  <strong>CLMM: чтение и расчёт, без открытия позиции</strong>
                  <p>
                    Для проверочного пула у проектного кошелька нет необходимых
                    токенов пары. Подписанный путь открытия и закрытия позиции
                    не проверен и здесь не предоставляется. Расчёт бюджета не
                    означает внесение средств.
                  </p>
                  <button className="secondary" disabled>
                    Открытие позиции недоступно
                  </button>
                  <p>
                    Вне диапазона позиция становится односторонней: ниже — A,
                    выше — B; торговые комиссии не начисляются до возвращения
                    цены в диапазон. Возможны непостоянные потери. Выбор узкого
                    диапазона повышает риск выхода цены.
                  </p>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
