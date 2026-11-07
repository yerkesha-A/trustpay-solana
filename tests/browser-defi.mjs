import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
mkdirSync(".anchor/browser", { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "DeFi · Raydium ↗", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Ликвидность Raydium." })
    .waitFor();
  assert(
    await page
      .getByText("Escrow остаётся в escrow.", { exact: true })
      .isVisible(),
  );
  await page
    .getByLabel("Адрес CPMM-пула Devnet")
    .fill("11111111111111111111111111111111");
  await page
    .getByRole("button", { name: "Загрузить пул", exact: true })
    .click();
  await page.getByRole("alert").waitFor();
  assert(
    (await page.getByRole("alert").innerText()).includes("не является пулом"),
  );
  await page
    .getByLabel("Адрес CPMM-пула Devnet")
    .fill("6RLToRXHVoFunGgc3B53BvYcKBsbf9BA7CuD9Xz1pU8N");
  await page
    .getByRole("button", { name: "Загрузить пул", exact: true })
    .click();
  await page.locator(".defi-assets > div").nth(2).waitFor();
  assert.equal(await page.locator(".defi-assets > div").count(), 3);
  await page.screenshot({
    path: ".anchor/browser/week09-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: ".anchor/browser/week09-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: DeFi lazy loading, real Devnet RPC validation, bad pool rejected, existing real pool loaded, desktop/mobile, no page errors.",
  );
} finally {
  await browser.close();
}
