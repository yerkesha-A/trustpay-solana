import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
mkdirSync('docs/screenshots', { recursive:true });
const browser = await chromium.launch({ channel:'chrome', headless:true });
try {
  const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });
  const errors=[]; page.on('pageerror', e => errors.push(String(e)));
  await page.goto('http://127.0.0.1:5173/', { waitUntil:'networkidle' });
  await page.getByRole('button', {name:'DeFi · Raydium ↗', exact:true}).click();
  await page.getByRole('heading', { name:'Raydium Swap · Devnet', exact:true }).waitFor();
  const panel = page.getByRole('region', {name:'Raydium Swap'});
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path:'docs/screenshots/week12-desktop.png', fullPage:true });
  await page.setViewportSize({ width:390, height:844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path:'docs/screenshots/week12-mobile.png', fullPage:true });
  assert.deepEqual(errors, []);
  console.log('PASS swap panel visible; 390px layout without horizontal overflow; no page errors. No swap executed.');
} finally { await browser.close(); }
