import {chromium} from 'playwright';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {PublicKey}=require('@solana/web3.js');
const pacedFetch=require('../scripts/devnet-fetch.cjs');
const owner=new PublicKey('2mxYEEpyuuo1msxRXGB4wWNqeCeaPSrcywcw2Qq7tEab');
const browser=await chromium.launch({channel:'chrome',headless:true});
mkdirSync('docs/screenshots',{recursive:true});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(bytes=>{
  window.__week13Requests=[];
  const wallet={isPhantom:true,isConnected:false,publicKey:{toBytes:()=>Uint8Array.from(bytes)},on(){},off(){},async connect(){wallet.isConnected=true;return{publicKey:wallet.publicKey};},async disconnect(){wallet.isConnected=false;},async signTransaction(tx){window.__week13Requests.push({programs:tx.instructions.map(ix=>ix.programId.toBase58()),payer:tx.feePayer.toBase58(),signatures:tx.signatures.map(s=>({key:s.publicKey.toBase58(),present:!!s.signature}))});throw Error('Manual approval required (QA provider)');},async signAllTransactions(){throw Error('QA provider');}};
  window.phantom={solana:wallet};
 },Array.from(owner.toBytes()));
 await context.route('https://api.devnet.solana.com/**',async route=>{
  const req=route.request();try{const response=await pacedFetch(req.url(),{method:req.method(),headers:{'content-type':'application/json'},body:req.postData()});await route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});}catch{await route.abort();}
 });
 const page=await context.newPage();page.setDefaultTimeout(90000);
 const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto('http://127.0.0.1:5173/',{waitUntil:'networkidle'});
 await page.locator('.nav').filter({hasText:'Stablecoin Payments'}).click();
 await page.getByRole('heading',{name:'Stablecoin Payments',exact:true}).waitFor();
 assert((await page.locator('.week13-page').innerText()).includes('не USDC'));
 await page.locator('.header-actions .wallet-adapter-button-trigger').click();
 await page.getByRole('button',{name:/Phantom/}).click();
 await page.getByLabel('Название работы (on-chain)',{exact:true}).fill('Browser QA payment');
 await page.getByLabel('Адрес исполнителя',{exact:true}).fill('8uctBg6jVu2Y1bTKojWjn1K3dSkBGXGVRCxXPyF9DnMM');
 await page.getByRole('button',{name:'Обновить платежи',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('.week13-form button')?.disabled);
 await page.screenshot({path:'docs/screenshots/week13-payments.png',fullPage:true});
 await page.getByRole('button',{name:'Создать и внести средства',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Manual approval required'}).waitFor();
 await page.locator('.nav').filter({hasText:'CLMM Positions'}).click();
 await page.getByRole('heading',{name:'CLMM Positions',exact:true}).waitFor();
 await page.getByRole('button',{name:'Загрузить позиции',exact:true}).click();
 await page.getByLabel('Бюджет A',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Рассчитать позицию',exact:true}).click();
 await page.getByRole('button',{name:'Подписать CLMM-транзакцию',exact:true}).waitFor();
 await page.screenshot({path:'docs/screenshots/week13-clmm-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:'docs/screenshots/week13-clmm-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Подписать CLMM-транзакцию',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Manual approval required'}).waitFor();
 const requests=await page.evaluate(()=>window.__week13Requests);
 assert.equal(requests.length,2);
 assert(requests[0].programs.includes('ojfaRp5p9b8ZyK5VH5VQQQYxTWy8hi3QTorcTHtN19A'));
 assert(requests[1].programs.includes('DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH'));
 assert(!requests[1].programs.includes('ojfaRp5p9b8ZyK5VH5VQQQYxTWy8hi3QTorcTHtN19A'));
 assert(requests[1].signatures.some(s=>s.key!==owner.toBase58()&&s.present));
 assert(requests[1].signatures.some(s=>s.key===owner.toBase58()&&!s.present));
 assert.deepEqual(errors,[]);
 writeFileSync('docs/week13-browser-evidence.json',JSON.stringify({checkedAt:new Date().toISOString(),rpc:'real Devnet responses forwarded through Node',wallet:'synthetic rejection provider, not a manual Phantom approval',requests,desktopAndMobile:true,pageErrors:errors,transactionsSent:0},null,2)+'\n');
 console.log('PASS: real Devnet data, both forms, 2 signing requests rejected by QA provider, NFT partial signature preserved, desktop/mobile, no page errors. Manual Phantom NOT verified.');
}finally{await browser.close();}
