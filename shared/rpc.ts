import {
  Connection,
  PublicKey,
  type ConfirmedSignatureInfo,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  Program,
  BorshInstructionCoder,
  type Idl,
  type Provider,
} from "@coral-xyz/anchor";

export type TestNetwork = "devnet" | "localnet";
export const DEVNET_GENESIS_ID = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS_ID = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export function safeRpcError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const clean = text.replace(
    /([?&](?:api-key|api_key|token)=)[^&\s"']+/gi,
    "$1[redacted]",
  );
  return /429|too many requests|rate.limit/i.test(clean)
    ? "RPC ограничил частоту запросов. Повторите обновление через несколько секунд."
    : clean;
}
export function validateTestEndpoint(endpoint: string, network: TestNetwork) {
  const url = new URL(endpoint);
  const valid =
    network === "devnet"
      ? url.protocol === "https:" &&
        ["api.devnet.solana.com", "devnet.helius-rpc.com"].includes(
          url.hostname,
        )
      : ["http:", "https:"].includes(url.protocol) &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!valid)
    throw Error(
      "Допустимы только Solana Devnet / Helius Devnet или локальный RPC.",
    );
  return endpoint;
}
export async function rpcRetry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; delayMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const { attempts = 3, delayMs = 350, signal } = options;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw Error("Запрос отменён.");
    try {
      return await fn();
    } catch (e) {
      const retryable =
        /429|too many requests|rate.limit|fetch failed|failed to fetch|network|timeout|503|502|node is unhealthy|-32005/i.test(
          String(e),
        );
      if (!retryable || attempt === attempts - 1) throw Error(safeRpcError(e));
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          reject(Error("Запрос отменён."));
        };
        const timer = setTimeout(
          () => {
            signal?.removeEventListener("abort", cancel);
            resolve();
          },
          delayMs * 2 ** attempt,
        );
        signal?.addEventListener("abort", cancel, { once: true });
      });
    }
  }
  throw Error("RPC недоступен.");
}
const checked = new WeakMap<Connection, Promise<void>>();
export async function ensureTestNetwork(c: Connection, network: TestNetwork) {
  validateTestEndpoint(c.rpcEndpoint, network);
  let check = checked.get(c);
  if (!check) {
    check = (async () => {
      const hash = await rpcRetry(() => c.getGenesisHash());
      if (
        hash === MAINNET_GENESIS_ID ||
        (network === "devnet" && hash !== DEVNET_GENESIS_ID) ||
        (network === "localnet" && hash === DEVNET_GENESIS_ID)
      )
        throw Error("RPC отвечает из другой сети. Операция остановлена.");
    })();
    checked.set(c, check);
  }
  try {
    await check;
  } catch (e) {
    checked.delete(c);
    throw e;
  }
}
export function readProgram(c: Connection, idl: Idl) {
  return new Program(idl, { connection: c } as Provider);
}
export type TokenBalance = {
  mint: string;
  decimals: number;
  amount: bigint;
  accounts: string[];
  program: string;
};
export type WalletSnapshot = {
  solLamports: bigint | null;
  tokens: TokenBalance[] | null;
  warnings: string[];
};
export async function fetchWalletSnapshot(
  c: Connection,
  owner: PublicKey,
): Promise<WalletSnapshot> {
  const results = await Promise.allSettled([
    rpcRetry(() => c.getBalance(owner, "confirmed")),
    rpcRetry(() =>
      c.getParsedTokenAccountsByOwner(
        owner,
        { programId: TOKEN_PROGRAM_ID },
        "confirmed",
      ),
    ),
    rpcRetry(() =>
      c.getParsedTokenAccountsByOwner(
        owner,
        { programId: TOKEN_2022_PROGRAM_ID },
        "confirmed",
      ),
    ),
  ]);
  const warnings: string[] = [];
  let solLamports: bigint | null = null;
  if (results[0].status === "fulfilled") {
    if (Number.isSafeInteger(results[0].value))
      solLamports = BigInt(results[0].value);
    else warnings.push("SOL balance exceeds safe RPC integer precision.");
  } else warnings.push("SOL: " + safeRpcError(results[0].reason));
  const balances = new Map<string, TokenBalance>();
  let loaded = 0;
  for (let i = 1; i < 3; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      warnings.push(
        (i === 1 ? "SPL Token" : "Token-2022") +
          ": " +
          safeRpcError(result.reason),
      );
      continue;
    }
    if (typeof result.value === "number") continue;
    loaded++;
    for (const { pubkey, account } of result.value.value) {
      const data = account.data;
      if (!("parsed" in data) || data.parsed.type !== "account") continue;
      const info = data.parsed.info,
        amount = BigInt(info.tokenAmount.amount),
        mint = String(info.mint),
        decimals = Number(info.tokenAmount.decimals);
      const key = account.owner.toBase58() + ":" + mint,
        previous = balances.get(key);
      if (previous) {
        previous.amount += amount;
        previous.accounts.push(pubkey.toBase58());
      } else
        balances.set(key, {
          mint,
          decimals,
          amount,
          accounts: [pubkey.toBase58()],
          program: account.owner.toBase58(),
        });
    }
  }
  return {
    solLamports,
    tokens: loaded ? Array.from(balances.values()) : null,
    warnings,
  };
}
export type HistoryItem = {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  status: string;
  actions: {
    name: string;
    amount?: string;
    actor?: string;
    instruction?: string;
    mint?: string;
    order?: string;
    kind?: "vault" | "escrow";
  }[];
  detailsAvailable: boolean;
};
const labels: Record<string, string> = {
  createOrder: "Создание и оплата escrow",
  submitWork: "Сдача работы",
  allowCancel: "Согласие на отмену",
  release: "Выплата escrow",
  refund: "Возврат escrow",
  initializeLiquidityVault: "Создание Liquidity Vault",
  depositLiquidity: "Депозит в Liquidity Vault",
  withdrawLiquidity: "Вывод из Liquidity Vault",
};
export function transactionActions(
  tx: ParsedTransactionWithMeta | null,
  program: Program,
): HistoryItem["actions"] {
  if (!tx) return [];
  const result: HistoryItem["actions"] = [];
  for (const ix of tx.transaction.message.instructions) {
    if (!ix.programId.equals(program.programId) || !("data" in ix)) continue;
    try {
      const decoded = new BorshInstructionCoder(program.idl).decode(
        ix.data,
        "base58",
      );
      if (!decoded) continue;
      const args = decoded.data as Record<string, { toString(): string }>;
      result.push({
        name: labels[decoded.name] || decoded.name,
        amount: args.amount?.toString(),
        actor: ix.accounts[0]?.toBase58(),
        instruction: decoded.name,
        kind: decoded.name.includes("Liquidity")
          ? "vault"
          : labels[decoded.name]
            ? "escrow"
            : undefined,
        mint: ix.accounts[
          program.idl.instructions
            .find((i) => i.name === decoded.name)
            ?.accounts.findIndex((a) => a.name === "mint") ?? -1
        ]?.toBase58(),
        order:
          ix.accounts[
            program.idl.instructions
              .find((i) => i.name === decoded.name)
              ?.accounts.findIndex((a) => a.name === "order") ?? -1
          ]?.toBase58(),
      });
    } catch {
      /* Unknown/new instructions remain unclassified, never fabricated. */
    }
  }
  return result;
}
export async function fetchRecentHistory(
  c: Connection,
  program: Program,
  addresses: PublicKey[],
  limit = 12,
  signal?: AbortSignal,
): Promise<{ items: HistoryItem[]; warnings: string[] }> {
  const unique = Array.from(
    new Map(addresses.map((a) => [a.toBase58(), a])).values(),
  ).slice(0, 8);
  const signatures = new Map<string, ConfirmedSignatureInfo>(),
    warnings: string[] = [];
  // Bounded sequential address reads avoid flooding shared Devnet RPC.
  for (const address of unique) {
    if (signal?.aborted) throw Error("Запрос отменён.");
    try {
      const rows = await rpcRetry(
        () => c.getSignaturesForAddress(address, { limit }),
        { signal },
      );
      for (const row of rows) signatures.set(row.signature, row);
    } catch (e) {
      warnings.push(safeRpcError(e));
    }
  }
  const selected = [...signatures.values()]
      .sort((a, b) => b.slot - a.slot)
      .slice(0, limit),
    items: HistoryItem[] = [];
  for (const row of selected) {
    if (signal?.aborted) throw Error("Запрос отменён.");
    let tx: ParsedTransactionWithMeta | null = null;
    try {
      tx = await rpcRetry(
        () =>
          c.getParsedTransaction(row.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          }),
        { signal },
      );
    } catch (e) {
      warnings.push("Детали транзакции: " + safeRpcError(e));
    }
    items.push({
      signature: row.signature,
      slot: row.slot,
      blockTime: row.blockTime ?? null,
      err: row.err,
      status: row.confirmationStatus || "unknown",
      actions: transactionActions(tx, program),
      detailsAvailable: tx !== null,
    });
  }
  return { items, warnings: [...new Set(warnings)] };
}
