import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
let browser;
const artifacts=await mkdtemp(path.join(process.env.TMPDIR,'seedhost-brand-'));
before(async()=>{browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});});
after(async()=>{await browser?.close();console.log('BRAND_ARTIFACTS='+artifacts);});
async function splash(t, reduced=false){
 const page=await browser.newPage({viewport:{width:1000,height:700},reducedMotion:reduced?'reduce':'no-preference'});t.after(()=>page.close());
 const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.addInitScript(()=>{window.seedhost={call:async m=>m==='accountStatus'?{configured:false,signedIn:false}:new Promise(()=>{})};});
 await page.goto('file://'+fileURLToPath(new URL('../apps/desktop/index.html',import.meta.url)));
 return page;
}
async function frame(page,ms){return page.evaluate(ms=>{
 document.getAnimations().forEach(a=>{a.pause();a.currentTime=ms;});
 const style=s=>getComputedStyle(document.querySelector('.splash-logo '+s));
 return {seed:Number(style('.logo-seed').opacity),left:Number(style('.logo-leaf-left').opacity),right:Number(style('.logo-leaf-right').opacity),stem:style('.logo-stem').stroke,dash:parseFloat(style('.logo-stem').strokeDashoffset),animations:document.getAnimations().map(a=>a.animationName)};
},ms);}
test('the new sprout mark builds smoothly, paints its stem under CSP, and matches app icon geometry',async t=>{
 const page=await splash(t);const start=await frame(page,0);assert.equal(start.seed,0);assert.equal(start.left,0);
 assert.ok(start.animations.includes('seed-land'));assert.ok(start.animations.includes('unfurl'));
 await frame(page,450);await page.screenshot({path:path.join(artifacts,'seed-450ms.png')});
 await frame(page,1000);await page.screenshot({path:path.join(artifacts,'stem-1000ms.png')});
 const final=await frame(page,2400);assert.equal(final.seed,1);assert.equal(final.left,1);assert.equal(final.right,1);assert.equal(final.dash,0);assert.match(final.stem,/logo-stem-paint/);
 await page.screenshot({path:path.join(artifacts,'sprout-2400ms.png')});
 const svg=await page.locator('.splash-logo').innerHTML(),rasterizer=await readFile(new URL('../tools/generate-icon.mjs',import.meta.url),'utf8');
 for(const leaf of ['M30.6 35.5C23.4 35.8 16.6 30.4 16.2 21.6C24.4 21.2 30.8 26.8 30.6 35.5Z','M33.4 30.5C33.2 21.4 40.2 14.4 49.5 14.6C49.6 23.8 42.6 30.6 33.4 30.5Z']){assert.ok(svg.includes(leaf));assert.ok(rasterizer.includes(leaf));}
});
test('reduced motion displays the complete mark without a looping animation',async t=>{
 const page=await splash(t,true);await page.waitForTimeout(100);const final=await frame(page,2400);
 assert.equal(final.seed,1);assert.equal(final.left,1);assert.equal(final.right,1);assert.equal(final.dash,0);
 assert.ok(await page.evaluate(()=>document.getAnimations().every(a=>a.effect.getTiming().duration===0)));
 await page.screenshot({path:path.join(artifacts,'reduced-motion.png')});
});
