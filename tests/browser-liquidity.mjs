// Chrome QA uses real Devnet reads. The sole injected response is an explicit HTTP 429 fault.
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const require = createRequire(`${process.cwd()}/package.json`);
require("ts-node").register({ project: "tsconfig.json" });
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const {
  loadAmmMarket,
  loadClmmMarket,
  ammQuote,
  clmmRange,
  MARKET_POOLS,
} = require("./shared/market");
const { formatUnits } = require("./shared/defi");
const Decimal = require("decimal.js");
const pacedFetch = require("./scripts/devnet-fetch.cjs");
const c = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
  fetch: pacedFetch,
});
const key = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(".anchor/week09-wallet.json", "utf8")),
  ),
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
mkdirSync(".anchor/browser", { recursive: true });
let page;
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  // Read-only Phantom-compatible test provider; no wallet secrets enter the browser.
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
      signTransaction: async () => {
        throw Error("Read-only QA: no signatures permitted");
      },
      signAllTransactions: async () => {
        throw Error("Read-only QA");
      },
    };
    window.phantom = { solana: wallet };
  }, Array.from(key.publicKey.toBytes()));
  await context.route("https://api.devnet.solana.com/**", async (route) => {
    const req = route.request(),
      res = await pacedFetch(req.url(), {
        method: req.method(),
        headers: { "content-type": "application/json" },
        body: req.postData(),
      });
    await route.fulfill({
      status: res.status,
      contentType: "application/json",
      body: await res.text(),
    });
  });
  page = await context.newPage();
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "DeFi / Liquidity ↗", exact: true })
    .click();
  assert(
    (await page.locator(".liquidity-page").innerText()).includes(
      "Балансы появятся после чтения сети",
    ),
  );
  assert.equal(await page.getByTestId("market-price").count(), 0);
  await page.locator(".header-actions .wallet-adapter-button-trigger").click();
  await page.getByRole("button", { name: /Phantom/ }).click();
  await page.getByRole("button", { name: "Обновить пул", exact: true }).click();
  await page.getByTestId("market-price").waitFor();
  const amm = await loadAmmMarket(c, new PublicKey(MARKET_POOLS[0].address));
  assert.equal(
    await page.getByTestId("market-reserve-a").innerText(),
    formatUnits(amm.pool.reserveA, amm.pool.decimalsA),
  );
  assert.notEqual(
    await page.getByTestId("market-balance-a").innerText(),
    "Подключите кошелёк",
  );
  await page
    .getByRole("button", { name: "Рассчитать AMM", exact: true })
    .click();
  await page.getByTestId("amm-quote").waitFor();
  const expectedAmm = ammQuote(amm, 1000000n, 50);
  assert(
    (await page.getByTestId("amm-quote").innerText()).includes(
      formatUnits(expectedAmm.output, amm.pool.decimalsB),
    ),
  );
  await page.screenshot({
    path: ".anchor/browser/week11-amm.png",
    fullPage: true,
  });
  console.log("PASS AMM real reserves and quote");
  await page
    .getByRole("button", { name: /CLMM · публичный Devnet-пул/ })
    .click();
  await page.getByRole("button", { name: "Обновить пул", exact: true }).click();
  await page.getByTestId("market-price").waitFor();
  await page
    .getByRole("button", { name: "Рассчитать диапазон", exact: true })
    .click();
  await page.getByTestId("clmm-quote").waitFor();
  const clmm = await loadClmmMarket(c, new PublicKey(MARKET_POOLS[1].address));
  const expectedClmm = clmmRange(
    clmm,
    new Decimal(clmm.price).mul("0.9").toString(),
    new Decimal(clmm.price).mul("1.1").toString(),
    10n ** BigInt(clmm.decimalsA),
    10n ** BigInt(clmm.decimalsB),
  );
  const text = await page.getByTestId("clmm-quote").innerText();
  assert(text.includes(expectedClmm.liquidity));
  assert(text.includes(formatUnits(expectedClmm.amountA, clmm.decimalsA)));
  assert(
    await page
      .getByRole("button", { name: "Открытие позиции недоступно" })
      .isDisabled(),
  );
  await page.screenshot({
    path: ".anchor/browser/week11-clmm.png",
    fullPage: true,
  });
  await page.getByLabel("Верхняя цена", { exact: true }).fill("0");
  assert.equal(await page.getByTestId("clmm-quote").count(), 0);
  await page
    .getByRole("button", { name: "Рассчитать диапазон", exact: true })
    .click();
  assert(
    (await page.getByRole("alert").innerText()).includes("Нужен диапазон"),
  );
  await page
    .getByLabel("Верхняя цена", { exact: true })
    .fill(new Decimal(clmm.price).mul("1.1").toString());
  await page
    .getByRole("button", { name: "Рассчитать диапазон", exact: true })
    .click();
  await page.getByTestId("clmm-quote").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: ".anchor/browser/week11-mobile.png",
    fullPage: true,
  });
  console.log(
    "PASS CLMM real data, aligned range, budget, disabled position and mobile",
  );
  await page
    .getByLabel("Адрес пула", { exact: true })
    .fill(MARKET_POOLS[0].address);
  await page.getByRole("button", { name: "Обновить пул", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "не является" }).waitFor();
  assert.equal(await page.getByTestId("clmm-quote").count(), 0);
  const pattern = "https://api.devnet.solana.com/**";
  await page.route(pattern, (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      body: '{"error":{"code":429,"message":"QA injected rate limit"}}',
    }),
  );
  await page.getByRole("button", { name: "Обновить пул", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "RPC ограничил" }).waitFor();
  await page.unroute(pattern);
  await page.locator(".header-actions .wallet-adapter-button-trigger").click();
  await page.getByRole("menuitem", { name: "Disconnect", exact: true }).click();
  assert.equal(await page.getByTestId("market-price").count(), 0);
  assert.deepEqual(errors, []);
  writeFileSync(
    "docs/week11-browser-evidence.json",
    JSON.stringify(
      {
        network: "devnet",
        verifiedAt: new Date().toISOString(),
        transactionsSent: 0,
        testWalletProvider: true,
        manualPhantom: false,
        checks: [
          "real CPMM reserves and quote",
          "real CLMM sqrt price and tick-aligned allocation",
          "invalid range rejected and stale quotes cleared",
          "wrong protocol rejected",
          "position button disabled and limitation shown",
          "real wallet balances",
          "390px mobile without overflow",
          "429 transport fault handled",
          "wallet disconnect clears state",
        ],
        pools: MARKET_POOLS.map((p) => p.address),
      },
      null,
      2,
    ) + "\n",
  );
  console.log("PASS: Week11 browser QA completed");
} catch (e) {
  if (page) {
    await page.screenshot({
      path: ".anchor/browser/week11-failure.png",
      fullPage: true,
    });
    console.error(await page.locator("body").innerText());
  }
  throw e;
} finally {
  await browser.close();
}
