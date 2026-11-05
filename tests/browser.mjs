// QA only: test wallet provider, real signatures and local-validator transactions.
import { chromium } from "playwright";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
mkdirSync(".anchor/browser", { recursive: true });
const require = createRequire(`${process.cwd()}/package.json`);
const { Connection, Keypair, Transaction } = require("@solana/web3.js");
const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const client = Keypair.generate(),
  worker = Keypair.generate();
async function confirm(sig) {
  for (let i = 0; i < 60; i++) {
    const s = (await connection.getSignatureStatuses([sig])).value[0];
    if (s?.err) throw Error(JSON.stringify(s.err));
    if (["confirmed", "finalized"].includes(s?.confirmationStatus)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("confirmation timeout");
}
for (const key of [client, worker])
  await confirm(await connection.requestAirdrop(key.publicKey, 2e9));
const mint = await createMint(connection, client, client.publicKey, null, 6);
const source = await getOrCreateAssociatedTokenAccount(
  connection,
  client,
  mint,
  client.publicKey,
);
await mintTo(connection, client, mint, source.address, client, 1_000_000_000n);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const pageErrors = [];
async function walletPage(key) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.exposeFunction("localTestSign", (raw) => {
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
        const sig = await window.localTestSign(
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
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
  await page.locator(".wallet-adapter-button-trigger").first().click();
  await page.getByRole("button", { name: /Phantom/ }).click();
  await page
    .getByRole("button", { name: "Создать заказ", exact: true })
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    () => !document.querySelector(".intro button").disabled,
  );
  return page;
}
try {
  const customer = await walletPage(client),
    freelancer = await walletPage(worker);
  async function createOrder(title, amount) {
    await customer
      .getByRole("button", { name: "Создать заказ", exact: true })
      .click();
    await customer.getByLabel("Название", { exact: true }).fill(title);
    await customer
      .getByLabel("Кошелёк исполнителя")
      .fill(worker.publicKey.toBase58());
    await customer
      .getByLabel("Mint тестового SPL-токена")
      .fill(mint.toBase58());
    await customer.getByLabel("Сумма", { exact: true }).fill(amount);
    await customer
      .getByRole("button", { name: "Создать и внести токены" })
      .click();
    await customer
      .getByRole("dialog")
      .waitFor({ state: "hidden", timeout: 30000 });
    await customer
      .getByText("Транзакция подтверждена", { exact: true })
      .waitFor();
  }
  await createOrder("Local QA — website delivery", "100");
  await customer.screenshot({
    path: ".anchor/browser/funded.png",
    fullPage: true,
  });
  await freelancer
    .getByRole("button", { name: "Я исполнитель", exact: true })
    .click();
  await freelancer
    .getByRole("button", { name: "Обновить", exact: true })
    .click();
  await freelancer
    .getByRole("button")
    .filter({ hasText: "Local QA — website delivery" })
    .click();
  await freelancer
    .getByRole("button", { name: "Работа выполнена", exact: true })
    .click();
  await freelancer
    .getByRole("dialog")
    .waitFor({ state: "hidden", timeout: 30000 });
  await customer.getByRole("button", { name: "Обновить", exact: true }).click();
  await customer
    .getByRole("button")
    .filter({ hasText: "Local QA — website delivery" })
    .click();
  await customer
    .getByRole("button", { name: "Принять работу и выплатить", exact: true })
    .click();
  await customer
    .getByRole("dialog")
    .waitFor({ state: "hidden", timeout: 30000 });
  const destination = getAssociatedTokenAddressSync(mint, worker.publicKey);
  assert.equal(
    (await getAccount(connection, destination)).amount,
    100_000_000n,
  );
  await customer
    .getByRole("button")
    .filter({ hasText: "Local QA — website delivery" })
    .click();
  await customer.locator(".history li").first().waitFor();
  assert((await customer.locator(".history li").count()) >= 3);
  await customer.screenshot({
    path: ".anchor/browser/paid-history.png",
    fullPage: true,
  });
  await customer.getByRole("button", { name: "Закрыть", exact: true }).click();
  await createOrder("Local QA — agreed cancellation", "25");
  await freelancer
    .getByRole("button", { name: "Обновить", exact: true })
    .click();
  await freelancer
    .getByRole("button")
    .filter({ hasText: "Local QA — agreed cancellation" })
    .click();
  await freelancer
    .getByRole("button", { name: "Согласовать отмену", exact: true })
    .click();
  await freelancer
    .getByRole("dialog")
    .waitFor({ state: "hidden", timeout: 30000 });
  await customer.getByRole("button", { name: "Обновить", exact: true }).click();
  await customer
    .getByRole("button")
    .filter({ hasText: "Local QA — agreed cancellation" })
    .click();
  await customer
    .getByRole("button", { name: "Вернуть средства", exact: true })
    .click();
  await customer
    .getByRole("dialog")
    .waitFor({ state: "hidden", timeout: 30000 });
  assert.equal(
    (await getAccount(connection, source.address)).amount,
    900_000_000n,
  );
  await customer.screenshot({
    path: ".anchor/browser/refunded.png",
    fullPage: true,
  });
  assert.deepEqual(pageErrors, []);
  console.log(
    "PASS: browser real local-chain create/fund → submit → release, ATA creation, exact payout; agreed cancel → refund; exact balances; real transaction history; no page errors. Test wallet provider used, not the Phantom extension.",
  );
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      console.log("PAGE:", await page.locator("body").innerText());
    }
  throw error;
} finally {
  await browser.close();
}
