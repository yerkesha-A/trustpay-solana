// Real local/Devnet UI transactions. Existing project keypairs only; test wallet provider.
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const require = createRequire(`${process.cwd()}/package.json`);
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} = require("@solana/web3.js");
const {
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const network = process.env.TRUSTPAY_DASHBOARD_NETWORK;
if (!["localnet", "devnet"].includes(network))
  throw Error(
    "Choose test:dashboard:local or test:dashboard:devnet explicitly.",
  );
const connection = new Connection(
  network === "devnet"
    ? "https://api.devnet.solana.com"
    : "http://127.0.0.1:8899",
  { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: require("./scripts/devnet-fetch.cjs") },
);
const genesis = await connection.getGenesisHash();
assert(
  network === "devnet"
    ? genesis === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
    : genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);
const key = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      readFileSync(
        network === "devnet"
          ? ".anchor/week09-wallet.json"
          : ".anchor/local-wallet.json",
        "utf8",
      ),
    ),
  ),
);
const fixture = JSON.parse(
  readFileSync(
    network === "devnet"
      ? ".anchor/week10-devnet-fixture.json"
      : ".anchor/week10-local-fixture.json",
    "utf8",
  ),
);
const shareAddress = getAssociatedTokenAddressSync(
  new PublicKey(fixture.sharesMint),
  key.publicKey,
);
const decimals = (await getMint(connection, new PublicKey(fixture.sharesMint)))
  .decimals;
const balance = async () => (await getAccount(connection, shareAddress)).amount;
const format = (amount) => {
  const base = 10n ** BigInt(decimals),
    fraction = (amount % base)
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
  return `${amount / base}${fraction ? "." + fraction : ""}`;
};
const browser = await chromium.launch({ channel: "chrome", headless: true });
const evidence = [],
  errors = [];
mkdirSync(".anchor/browser", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  await context.exposeFunction("devnetTestSign", (raw) => {
    const tx = Transaction.from(Buffer.from(raw));
    tx.partialSign(key);
    return Array.from(tx.signature);
  });
  await context.addInitScript((bytes) => {
    const listeners = {};
    const wallet = {
      isPhantom: true,
      isConnected: false,
      publicKey: { toBytes: () => Uint8Array.from(bytes) },
      connect: async () => {
        wallet.isConnected = true;
        return { publicKey: wallet.publicKey };
      },
      disconnect: async () => {
        wallet.isConnected = false;
      },
      on: (event, fn) => {
        (listeners[event] ??= []).push(fn);
      },
      off: (event, fn) => {
        listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
      },
      signTransaction: async (tx) => {
        const sig = await window.devnetTestSign(
          Array.from(
            tx.serialize({
              requireAllSignatures: false,
              verifySignatures: false,
            }),
          ),
        );
        tx.addSignature(tx.feePayer, Uint8Array.from(sig));
        return tx;
      },
      signAllTransactions: async (txs) =>
        Promise.all(txs.map((tx) => wallet.signTransaction(tx))),
    };
    window.phantom = { solana: wallet };
  }, Array.from(key.publicKey.toBytes()));
  if (network === "devnet") {
    const pacedFetch = require("./scripts/devnet-fetch.cjs");
    await context.route("https://api.devnet.solana.com/**", async route => {
      const request = route.request();
      const response = await pacedFetch(request.url(), {
        method: request.method(), headers: {"content-type":"application/json"},
        body: request.postData(),
      });
      await route.fulfill({status: response.status, contentType: "application/json", body: await response.text()});
    });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  page.on("pageerror", (error) => errors.push(String(error)));
  console.log("Dashboard: browser opened");
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "RPC Dashboard ↗", exact: true })
    .click();
  await page
    .getByRole("heading", {
      name: "Подключите кошелёк для чтения blockchain-данных",
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByTestId("sol-balance").count(), 0);
  await page.locator(".wallet-adapter-button-trigger").first().click();
  await page.getByRole("button", { name: /Phantom/ }).click();
  assert((await page.locator(".header-actions .wallet-adapter-button-trigger").innerText()).includes(key.publicKey.toBase58().slice(0,4)));
  await page.getByLabel("Сеть", { exact: true }).selectOption(network);
  await page.waitForFunction(
    () =>
      document.querySelector(".rpc-toolbar button") &&
      !document.querySelector(".rpc-toolbar button").disabled,
  );
  await page.getByLabel("Underlying mint", { exact: true }).fill(fixture.mint);
  await page
    .getByRole("button", { name: "Загрузить Vault", exact: true })
    .click();
  const before = await balance();
  const expectShares = async (amount) => {
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('[data-testid="share-balance"]')
          ?.textContent.trim() === expected,
      format(amount),
    );
    await page.waitForFunction(
      () => !document.querySelector(".rpc-toolbar button").disabled,
    );
  };
  console.log("Dashboard: loading actual shares", before.toString());
  await expectShares(before);
  assert.notEqual(await page.getByTestId("sol-balance").innerText(), "—");
  await page
    .getByLabel("Сумма добровольного депозита", { exact: true })
    .fill("2.5");
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Внести в Vault", exact: true })
    .click();
  await page
    .getByText("Транзакция подтверждена. Данные обновляются из RPC.", {
      exact: true,
    })
    .waitFor();
  console.log("Dashboard: deposit confirmed");
  const deposited = await balance();
  assert.equal(deposited - before, 2500000n);
  await expectShares(deposited);
  evidence.push({
    operation: "dashboard-deposit",
    url: await page.locator(".rpc-dashboard .tx").getAttribute("href"),
    sharesBefore: before.toString(),
    sharesAfter: deposited.toString(),
  });
  await page.screenshot({
    path: `.anchor/browser/week10-${network}-deposit.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Безопасный вывод", exact: true })
    .click();
  await page.getByLabel("Сумма вывода shares 1:1", { exact: true }).fill("1");
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Сжечь shares и вывести", exact: true })
    .click();
  await page
    .getByText("Транзакция подтверждена. Данные обновляются из RPC.", {
      exact: true,
    })
    .waitFor();
  console.log("Dashboard: withdrawal confirmed");
  const withdrawn = await balance();
  assert.equal(deposited - withdrawn, 1000000n);
  await expectShares(withdrawn);
  evidence.push({
    operation: "dashboard-withdraw",
    url: await page.locator(".rpc-dashboard .tx").getAttribute("href"),
    sharesBefore: deposited.toString(),
    sharesAfter: withdrawn.toString(),
  });
  await page
    .getByRole("button", { name: "Депозиты / выводы Vault", exact: true })
    .click();
  assert(
    (await page.locator(".rpc-dashboard").innerText()).includes(
      "Депозит в Liquidity Vault",
    ),
  );
  assert(
    (await page.locator(".rpc-dashboard").innerText()).includes(
      "Вывод из Liquidity Vault",
    ),
  );
  await page.screenshot({
    path: `.anchor/browser/week10-${network}-dashboard.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: `.anchor/browser/week10-${network}-mobile.png`,
    fullPage: true,
  });
  // Fault injection is transport-only. Never substitute balances or successful transactions.
  const routePattern =
    network === "devnet"
      ? "https://api.devnet.solana.com/**"
      : "http://127.0.0.1:8899/**";
  await page.route(routePattern, async (route) => {
    const body = route.request().postDataJSON();
    if (body?.method === "getBalance")
      await route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: 429, message: "QA injected rate limit" },
        }),
      });
    else await route.continue();
  });
  await page.getByRole("button", { name: "Обновить RPC", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="sol-balance"]')
        ?.textContent.trim() === "—",
  );
  assert(
    (await page.locator(".rpc-warnings").first().innerText()).includes(
      "RPC ограничил частоту запросов",
    ),
  );
  await page.unroute(routePattern);
  await page.locator(".header-actions .wallet-adapter-button-trigger").click();
  await page.getByRole("menuitem",{name:"Disconnect",exact:true}).click();
  await page.getByRole("heading",{name:"Подключите кошелёк для чтения blockchain-данных",exact:true}).waitFor();
  assert.equal(await page.getByTestId("sol-balance").count(),0);
  assert.deepEqual(errors, []);
  writeFileSync(
    `.anchor/week10-browser-${network}-evidence.json`,
    JSON.stringify(
      {
        network,
        genesis,
        transactions: evidence,
        checks: [
          "real balances",
          "real CPI deposit/withdraw",
          "share burn",
          "auto refresh",
          "decoded history",
          "empty state",
          "mobile",
          "429 transport fault", "wallet connection label and disconnect",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: ${network} Dashboard real CPI transactions, accurate refreshed balances, history, mobile, empty state and bounded 429 handling. Test wallet provider; existing project keypair.`,
  );
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  console.error("Dashboard QA failure", error);
  for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.screenshot({path: `.anchor/browser/week10-${network}-failure.png`, fullPage: true}).catch(() => {});
    console.error((await page.locator(".rpc-dashboard").innerText().catch(() => "")).slice(0, 5000));
  }
  throw error;
} finally {
  await browser.close();
}
