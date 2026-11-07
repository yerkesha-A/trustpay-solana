// Opt-in QA: real Devnet transactions, test wallet provider, no Phantom extension.
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
if (process.env.TRUSTPAY_DEFI_BROWSER !== "1")
  throw Error("Opt in with npm run test:defi:browser:transactions");
const require = createRequire(`${process.cwd()}/package.json`);
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} = require("@solana/web3.js");
const {
  getAccount,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const connection = new Connection("https://api.devnet.solana.com", {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
});
assert.equal(
  await connection.getGenesisHash(),
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
);
const key = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(".anchor/week09-wallet.json", "utf8")),
  ),
);
const fixture = JSON.parse(readFileSync(".anchor/week09-fixture.json", "utf8"));
const lpAddress = getAssociatedTokenAddressSync(
  new PublicKey(fixture.lpMint),
  key.publicKey,
);
const balance = async () => (await getAccount(connection, lpAddress)).amount;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const errors = [];
const evidence = [];
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
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
  await page.locator(".wallet-adapter-button-trigger").first().click();
  await page.getByRole("button", { name: /Phantom/ }).click();
  await page
    .getByRole("button", { name: "DeFi · Raydium ↗", exact: true })
    .click();
  await page.getByLabel("Адрес CPMM-пула Devnet").fill(fixture.pool);
  await page
    .getByRole("button", { name: "Загрузить пул", exact: true })
    .click();
  await page.locator(".defi-assets > div").nth(2).waitFor();
  const assertRefreshedLp = async (expected) => {
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".liquidity-form button")].every(
        (button) => !button.disabled,
      ),
    );
    const raw = expected.toString().padStart(10, "0");
    const whole = raw.slice(0, -9),
      fraction = raw.slice(-9).replace(/0+$/, "");
    const formatted = whole + (fraction ? "." + fraction : "");
    assert(
      (
        await page.locator(".defi-assets > div").nth(2).locator("p").innerText()
      ).includes(formatted),
    );
  };
  const initialLp = await balance();
  await page.getByLabel("Количество токена A", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Рассчитать", exact: true }).click();
  await page.locator(".defi-quote").waitFor();
  await page.screenshot({
    path: ".anchor/browser/week09-deposit-quote.png",
    fullPage: true,
  });
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Подтвердить депозит", exact: true })
    .click();
  await page
    .getByText("Транзакция подтверждена в Devnet.", { exact: true })
    .waitFor({ timeout: 90000 });
  const depositLp = await balance();
  assert(depositLp > initialLp);
  await assertRefreshedLp(depositLp);
  evidence.push({
    operation: "browser-deposit",
    url: await page.locator(".defi .tx").getAttribute("href"),
    lpBefore: initialLp.toString(),
    lpAfter: depositLp.toString(),
  });
  await page.screenshot({
    path: ".anchor/browser/week09-deposit-confirmed.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Вывести ликвидность", exact: true })
    .click();
  await page
    .getByLabel("Количество LP для вывода", { exact: true })
    .fill("0.0005");
  await page.getByRole("button", { name: "Рассчитать", exact: true }).click();
  await page.locator(".defi-quote").waitFor();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Подтвердить вывод", exact: true })
    .click();
  await page
    .getByText("Транзакция подтверждена в Devnet.", { exact: true })
    .waitFor({ timeout: 90000 });
  const withdrawalLp = await balance();
  assert.equal(depositLp - withdrawalLp, 500000n);
  await assertRefreshedLp(withdrawalLp);
  evidence.push({
    operation: "browser-withdraw",
    url: await page.locator(".defi .tx").getAttribute("href"),
    lpBefore: depositLp.toString(),
    lpAfter: withdrawalLp.toString(),
  });
  await page.screenshot({
    path: ".anchor/browser/week09-withdraw-confirmed.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  writeFileSync(
    ".anchor/week09-browser-evidence.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    "PASS: real Devnet browser deposit and withdrawal; LP mint/burn verified; test wallet provider, no Phantom extension.",
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close();
}
