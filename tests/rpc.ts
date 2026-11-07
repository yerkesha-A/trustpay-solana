import { expect } from "chai";
import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { BN, utils } from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import {
  rpcRetry,
  safeRpcError,
  validateTestEndpoint,
  fetchWalletSnapshot,
  fetchRecentHistory,
  readProgram,
  transactionActions,
} from "../shared/rpc";

describe("Week10 RPC unit checks (mocked transport, not blockchain evidence)", () => {
  it("retries bounded rate limits and stops after success", async () => {
    let calls = 0;
    const value = await rpcRetry(
      async () => {
        calls++;
        if (calls < 3) throw Error("429 Too Many Requests");
        return 42;
      },
      { delayMs: 0 },
    );
    expect(value).eq(42);
    expect(calls).eq(3);
  });
  it("does not retry permanent errors or aborted requests", async () => {
    let calls = 0;
    try {
      await rpcRetry(
        async () => {
          calls++;
          throw Error("Invalid public key");
        },
        { delayMs: 0 },
      );
    } catch (e) {
      expect(String(e)).include("Invalid public key");
    }
    expect(calls).eq(1);
    const controller = new AbortController();
    controller.abort();
    try {
      await rpcRetry(
        async () => {
          calls++;
          return 0;
        },
        { signal: controller.signal },
      );
    } catch (e) {
      expect(String(e)).include("отменён");
    }
    expect(calls).eq(1);
  });
  it("redacts API query keys and rejects Mainnet endpoints", () => {
    expect(
      safeRpcError(
        Error("https://devnet.helius-rpc.com/?api-key=example-secret&x=1"),
      ),
    ).not.include("example-secret");
    expect(() =>
      validateTestEndpoint("https://api.mainnet-beta.solana.com", "devnet"),
    ).to.throw();
    expect(() =>
      validateTestEndpoint("https://api.devnet.solana.com", "localnet"),
    ).to.throw();
    expect(
      validateTestEndpoint(
        "https://devnet.helius-rpc.com/?api-key=example",
        "devnet",
      ),
    ).include("devnet");
  });
  it("aggregates raw SPL integers across accounts without Number precision loss", async () => {
    const mint = PublicKey.default.toBase58(),
      owner = TOKEN_PROGRAM_ID;
    const account = (pubkey: PublicKey, amount: string) => ({
      pubkey,
      account: {
        owner,
        data: {
          parsed: {
            type: "account",
            info: { mint, tokenAmount: { amount, decimals: 6 } },
          },
        },
      },
    });
    const c = {
      getBalance: async () => 0,
      getParsedTokenAccountsByOwner: async (
        _o: PublicKey,
        filter: { programId: PublicKey },
      ) => ({
        value: filter.programId.equals(TOKEN_PROGRAM_ID)
          ? [
              account(TOKEN_PROGRAM_ID, "9007199254740993"),
              account(TOKEN_2022_PROGRAM_ID, "7"),
            ]
          : [],
      }),
    } as unknown as Connection;
    const result = await fetchWalletSnapshot(c, owner);
    expect(result.solLamports).eq(0n);
    expect(result.tokens![0].amount).eq(9007199254741000n);
    expect(result.tokens![0].accounts.length).eq(2);
  });
  it("returns unavailable balances and warnings instead of fake zeros on RPC failure", async () => {
    const c = {
      getBalance: async () => {
        throw Error("unavailable");
      },
      getParsedTokenAccountsByOwner: async () => {
        throw Error("unavailable");
      },
    } as unknown as Connection;
    const result = await fetchWalletSnapshot(c, PublicKey.default);
    expect(result.solLamports).eq(null);
    expect(result.tokens).eq(null);
    expect(result.warnings.length).eq(3);
  });
  it("decodes real Anchor Vault instruction bytes and their owner/mint positions", async () => {
    const p = readProgram(
        new Connection("http://127.0.0.1:8899"),
        JSON.parse(readFileSync("app/src/idl.json", "utf8")),
      ),
      key = PublicKey.default;
    const ix = await p.methods
      .depositLiquidity(new BN(1234567))
      .accountsStrict({
        owner: key,
        liquidityVault: key,
        mint: key,
        sharesMint: key,
        reserve: key,
        userTokens: key,
        userShares: key,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const tx = {
      transaction: {
        message: {
          instructions: [
            {
              programId: p.programId,
              accounts: ix.keys.map((k) => k.pubkey),
              data: utils.bytes.bs58.encode(ix.data),
            },
          ],
        },
      },
    } as unknown as ParsedTransactionWithMeta;
    const actions = transactionActions(tx, p);
    expect(actions[0].instruction).eq("depositLiquidity");
    expect(actions[0].kind).eq("vault");
    expect(actions[0].amount).eq("1234567");
    expect(actions[0].actor).eq(key.toBase58());
    expect(actions[0].mint).eq(key.toBase58());
  });
  it("deduplicates genuine signature records and marks missing transaction details", async () => {
    const row = {
      signature: "unit-signature-not-on-chain",
      slot: 123,
      blockTime: null,
      err: null,
      confirmationStatus: "finalized",
    };
    const c = {
      getSignaturesForAddress: async () => [row],
      getParsedTransaction: async () => null,
    } as unknown as Connection;
    const p = readProgram(
      new Connection("http://127.0.0.1:8899"),
      JSON.parse(readFileSync("app/src/idl.json", "utf8")),
    );
    const result = await fetchRecentHistory(c, p, [
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
    ]);
    expect(result.items.length).eq(1);
    expect(result.items[0].detailsAvailable).eq(false);
    expect(result.items[0].actions).deep.eq([]);
  });
});
