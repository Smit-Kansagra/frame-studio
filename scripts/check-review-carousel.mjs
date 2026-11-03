// Built React app with an in-memory desktop API and isolated Chrome profile.
// No app database, Google page or generation request is touched.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile,mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { chromium } from 'playwright'
const assets=[]
for(let n=0;n<5;n++){const bytes=await sharp({create:{width:40,height:50,channels:3,background:{r:20+n*35,g:80,b:100}}}).png().toBuffer(),url=`data:image/png;base64,${bytes.toString('base64')}`;assets.push({id:randomUUID(),originalName:`Image ${n}.png`,format:'png',width:40,height:50,orientation:1,byteSize:bytes.length,sha256:'0'.repeat(64),thumbnailWidth:40,thumbnailHeight:50,revision:1,createdAt:new Date().toISOString(),originalUrl:url,thumbnailUrl:url,available:true,thumbnailAvailable:true})}
const theme={id:randomUUID(),name:'Two visual directions',description:'',coverAssetId:assets[2].id,referenceAssetIds:[assets[2].id,assets[3].id],referenceInstructions:[{assetId:assets[2].id,name:'Mirror direction',compositionPrompt:'MIRROR_ONLY with a heading and a blue bag.',negativePrompt:'NO_MIRROR_GLARE'},{assetId:assets[3].id,name:'Seated direction',compositionPrompt:'SEATED_ONLY on a white chair.',negativePrompt:'NO_CHAIR_DISTORTION'}],masterPrompt:'Soft daylight. No heading, no bag, no watermark.',negativePrompt:'No logos.',compositionPrompt:'SHARED_FALLBACK',outputType:'post',aspectRatio:'4:5',defaultDuration:0,scenes:[],revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),images:assets.slice(2,4)}
const product={id:randomUUID(),name:'Two products',description:'',notes:'',primaryAssetId:assets[0].id,photos:assets.slice(0,2),revision:1,createdAt:theme.createdAt,updatedAt:theme.updatedAt}
const character={id:randomUUID(),name:'Selected character',category:null,primaryAssetId:assets[4].id,photos:[assets[4]],revision:1,createdAt:theme.createdAt,updatedAt:theme.updatedAt}
const project={id:randomUUID(),name:'Mapping review',productId:product.id,themeId:theme.id,characterId:character.id,outputType:'post',preset:'post-portrait',duration:0,storyboard:{scenes:[],compositionPrompt:theme.compositionPrompt},snapshot:{product,theme,character},revision:1,createdAt:theme.createdAt,updatedAt:theme.updatedAt}
const root=path.resolve('dist')
const server=createServer(async(req,res)=>{try{const relative=new URL(req.url,'http://localhost').pathname;const file=relative==='/'?'index.html':relative.slice(1);if(file.includes('..'))throw Error();const data=await readFile(path.join(root,file));res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'image/svg+xml');res.end(data)}catch{res.writeHead(404);res.end()}})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`
const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});let page
try{
  const context=await browser.newContext({viewport:{width:1500,height:1000}})
  await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort())
  await context.addInitScript(({theme,product,character,project})=>{
    project.snapshot={theme,product,character}
    const ok=value=>Promise.resolve({ok:true,value})
    window.fixture={theme,project,submitted:0,saved:null}
    window.frameStudio={platform:'windows',phase:11,
      flow:{status:async()=>({state:'connected',message:'Fixture',pageTitle:'Fixture',checkedAt:null}),jobs:()=>ok([]),job:()=>ok(null),project:()=>ok(null),activeRequest:()=>ok(null),generatePosts:()=>{window.fixture.submitted++;throw Error('No submission allowed in this UI preview test')}},
      themes:{get:()=>ok(theme),list:()=>ok([theme]),trash:()=>ok([]),save:draft=>{Object.assign(theme,draft,{revision:theme.revision+1});window.fixture.saved=JSON.parse(JSON.stringify(draft));return ok(theme)}},
      products:{list:()=>ok({items:[product],total:1}),trash:()=>ok([])},characters:{list:()=>ok([character])},projects:{get:()=>ok(project),list:()=>ok([project]),deleted:()=>ok([])},
      generations:{list:()=>ok([]),reviews:()=>ok([])},exports:{inspect:()=>ok(null)},images:{chooseManyAndImport:()=>ok({assets:[theme.images[0]],failures:[]})},
    }
  },{theme,product,character,project})

  await context.addInitScript(({project,assets})=>{
    const now=new Date().toISOString(), ok=value=>Promise.resolve({ok:true,value});
    const make=(id,sceneId,createdAt)=>({id,projectId:project.id,sceneId,outputType:'post',prompt:'Fixture prompt',references:[],preset:'post-portrait',sourceDuration:null,state:'ready-for-review',resultPath:'fixture.png',createdAt,updatedAt:createdAt,error:null});
    const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222',old='33333333-3333-4333-8333-333333333333';
    window.fixture.attempts=[make(first,'post',now),make(second,assets[1].id,now),make(old,'post','2026-01-01T00:00:00.000Z')];
    window.fixture.reviews=[];window.fixture.reviewCalls=[];
    window.frameStudio.generations={list:()=>ok(window.fixture.attempts),reviews:()=>ok(window.fixture.reviews),review:(projectId,sceneId,selectedAttemptId,status,note)=>{const r={projectId,sceneId,selectedAttemptId,status,note,updatedAt:new Date().toISOString()};window.fixture.reviewCalls.push(r);window.fixture.reviews=[...window.fixture.reviews.filter(item=>item.sceneId!==sceneId),r];return ok(r)}};
  },{project,assets});
  await context.addInitScript(()=>{
    const f=window.fixture,g=window.frameStudio.generations,now=new Date().toISOString(),ok=value=>Promise.resolve({ok:true,value}),listeners=new Set();
    f.logos=f.attempts.map(a=>({projectId:a.projectId,attemptId:a.id,status:'pending',cleanup:'removed',phase:'complete',percent:100,cleanupVersion:4,checkedAt:now,updatedAt:now}));f.flowCalls=[];f.logoCalls=[];
    g.logoReviews=()=>ok(f.logos);g.onLogoProgress=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};
    f.emitLogo=(id,patch)=>{const row=f.logos.find(l=>l.attemptId===id);Object.assign(row,patch,{updatedAt:new Date().toISOString()});for(const listener of listeners)listener({...row})};
    g.approvePost=async(id,note)=>{const a=f.attempts.find(a=>a.id===id),r=await g.review(a.projectId,a.sceneId,id,'approved',note);f.emitLogo(id,{status:'approved'});return ok({review:r.value,logo:{...f.logos.find(l=>l.attemptId===id)}})};
    g.retryLogo=(id,area)=>new Promise(resolve=>{f.logoCalls.push({id,area});f.emitLogo(id,{status:'processing',phase:'cleaning',percent:42,runId:'repair-'+f.logoCalls.length,checkedAt:null});f.finishLogo=()=>{f.emitLogo(id,{status:'pending',phase:'complete',percent:100,cleanup:'removed',checkedAt:new Date().toISOString()});resolve({ok:true,value:{...f.logos.find(l=>l.attemptId===id)}})}});
    window.frameStudio.flow.generate=(projectId,sceneId)=>{const review=f.reviews.find(r=>r.sceneId===sceneId);f.flowCalls.push({projectId,sceneId,source:review.selectedAttemptId,note:review.note,status:review.status});return ok({projectId,attemptId:'fixture-request',stage:'complete',message:'Fixture edit accepted',activity:[]})};
  });
  page=await context.newPage();page.on('pageerror',error=>{throw error});await page.goto(origin+'/#studio/'+project.id);
  await page.getByRole('button',{name:/Clips/}).click();
  const viewer=page.getByRole('group',{name:'Product image viewer'}),image=viewer.getByRole('img',{name:'Selected imported Flow image'}),note=page.getByRole('textbox',{name:'Review notes'});
  await viewer.waitFor();assert.equal(await page.locator('.generation-attempt-list').count(),0);assert.equal(await page.locator('.generation-prompt').count(),0);assert.equal(await page.getByText('Prompt for next attempt',{exact:true}).count(),0);
  assert.equal(await page.locator('.post-photo-strip img').count(),0,'Product cards contain text only');
  assert.equal(await page.locator('.post-photo-strip .review-scene-card').count(),2);
  assert.match(await page.locator('.post-photo-strip').innerText(),/Product 1/);assert.equal(await page.locator('.post-photo-strip .review-scene-card').nth(0).innerText(),'Product 1');assert.equal(await page.getByRole('navigation',{name:'Project steps'}).getByRole('button',{name:/Logo removed/}).count(),0);
  assert.match(await image.getAttribute('src'),/11111111/);assert.equal(await page.getByRole('button',{name:'Previous product image'}).isDisabled(),true);
  await note.fill('First product draft');await page.getByRole('button',{name:'Next product image'}).click();assert.match(await image.getAttribute('src'),/22222222/);await note.fill('Second product draft');assert.equal(await page.getByRole('button',{name:'Next product image'}).isDisabled(),true);
  await page.getByRole('button',{name:'Previous product image'}).click();assert.equal(await note.inputValue(),'First product draft');assert.equal(await page.evaluate(()=>window.fixture.reviewCalls.length),0,'Navigation must not change approval or write another product review');
  await page.getByRole('button',{name:'Approve',exact:true}).click();await page.waitForFunction(()=>window.fixture.reviewCalls.length===1);assert.deepEqual(await page.evaluate(()=>window.fixture.reviewCalls.map(r=>[r.sceneId,r.selectedAttemptId,r.status,r.note])),[['post','11111111-1111-4111-8111-111111111111','approved','First product draft']]);
  await viewer.focus();await page.keyboard.press('ArrowRight');assert.match(await image.getAttribute('src'),/22222222/);assert.equal(await note.inputValue(),'Second product draft');await page.getByRole('button',{name:'Change image',exact:true}).click();await page.waitForFunction(()=>window.fixture.reviewCalls.length===2);assert.equal((await page.evaluate(()=>window.fixture.reviewCalls.at(-1))).sceneId,assets[1].id);
  await viewer.evaluate(element=>{const point=x=>new Touch({identifier:1,target:element,clientX:x,clientY:100});element.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[point(50)]}));element.dispatchEvent(new TouchEvent('touchend',{bubbles:true,changedTouches:[point(140)]}))});assert.match(await image.getAttribute('src'),/11111111/);
  await page.getByRole('combobox',{name:'Review version',exact:true}).selectOption('33333333-3333-4333-8333-333333333333');assert.match(await image.getAttribute('src'),/33333333/);assert.equal(await page.evaluate(()=>window.fixture.reviewCalls.length),2,'Viewing an older version must not reset the approved version');
  assert.equal(await page.locator('.clip-review-player img[alt="Selected imported Flow image"]').count(),1);
  await page.getByRole('combobox',{name:'Review version',exact:true}).selectOption('11111111-1111-4111-8111-111111111111');
  // Isolated Chrome does not register Electron's frame-media protocol. Use the
  // fixture image solely for a layout screenshot after asserting exact source IDs.
  await image.evaluate((element,url)=>{element.src=url},assets[0].originalUrl);await viewer.screenshot({path:'.verification/review-carousel.png'});
  await page.waitForFunction(()=>window.fixture.flowCalls.length===1);
  assert.deepEqual(await page.evaluate(()=>window.fixture.flowCalls[0]),{projectId:project.id,sceneId:assets[1].id,source:'22222222-2222-4222-8222-222222222222',note:'Second product draft',status:'needs-changes'});
  const cards=page.locator('.product-review-card');assert.equal(await cards.nth(0).innerText(),'Product 1');assert.match(await cards.nth(0).getAttribute('class'),/status-approved/);assert.match(await cards.nth(1).getAttribute('class'),/status-changing/);
  await page.getByRole('button',{name:'Need change in logo',exact:true}).click();await page.waitForFunction(()=>window.fixture.logoCalls.length===1);
  assert.equal(await page.getByRole('img',{name:'Selected imported Flow image'}).count(),0);assert.equal(await page.getByRole('button',{name:'Approve',exact:true}).count(),0);assert.match(await cards.nth(0).getAttribute('class'),/status-changing/);assert.equal(await page.getByRole('progressbar',{name:'Selected product cleanup progress'}).getAttribute('value'),'42');assert.equal(await page.evaluate(()=>window.fixture.flowCalls.length),1,'Logo repair must never submit to Flow');
  await cards.nth(1).click();await page.getByRole('img',{name:'Selected imported Flow image'}).waitFor();assert.equal(await note.inputValue(),'Second product draft','Other product description survives independent repair');await page.evaluate(()=>window.fixture.finishLogo());await cards.nth(0).click();await page.getByRole('button',{name:'Approve',exact:true}).waitFor();assert.match(await cards.nth(0).getAttribute('class'),/status-pending/);await page.getByRole('button',{name:'Approve',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.product-review-card').classList.contains('status-approved'));
  for(const [index,color]of [[0,'rgb(64, 189, 131)'],[1,'rgb(235, 98, 107)']])assert.equal(await cards.nth(index).locator('.product-review-line').evaluate(el=>getComputedStyle(el).backgroundColor),color);
  await page.emulateMedia({reducedMotion:'reduce'});await image.evaluate((element,url)=>{element.src=url},assets[0].originalUrl);await page.locator('.page-scroll').evaluate(el=>el.scrollTop=0);assert.ok((await page.locator('.generation-panel').boundingBox()).width>900,'Review uses the workspace width');await page.screenshot({path:'.verification/clips-integrated-dark.png'});await page.setViewportSize({width:1100,height:850});assert.equal(await page.locator('.page-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth+2),true,'Compact review fits a laptop window');
  // A newly downloaded revision must replace the previously selected image only
  // after its cleanup completes, then return the product to yellow for review.
  await cards.nth(1).click();const revised='44444444-4444-4444-8444-444444444444';
  await page.evaluate(({id,sceneId})=>{const f=window.fixture,now=new Date(Date.now()+1000).toISOString();f.attempts.unshift({...f.attempts.find(a=>a.sceneId===sceneId),id,createdAt:now,updatedAt:now});f.logos.push({projectId:f.project.id,attemptId:id,status:'processing',phase:'cleaning',cleanup:'not-checked',percent:67,cleanupVersion:4,checkedAt:null,updatedAt:now})},{id:revised,sceneId:assets[1].id});
  await page.getByRole('progressbar',{name:'Selected product cleanup progress'}).waitFor();assert.equal(await page.getByRole('img',{name:'Selected imported Flow image'}).count(),0);
  await page.evaluate(id=>window.fixture.emitLogo(id,{status:'pending',phase:'complete',cleanup:'removed',percent:100,checkedAt:new Date().toISOString(),updatedAt:new Date(Date.now()+2000).toISOString()}),revised);
  await page.getByRole('img',{name:'Selected imported Flow image'}).waitFor();assert.match(await image.getAttribute('src'),/44444444/);assert.match(await cards.nth(1).getAttribute('class'),/status-pending/);assert.equal(await cards.nth(1).locator('.product-review-line').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(233, 186, 69)');assert.equal(await note.inputValue(),'','The old version comment is not copied into a new image');
  assert.equal(await page.evaluate(()=>window.fixture.flowCalls.length),1,'Receiving and repairing a revision never submits another image request');
  const callsBefore=await page.evaluate(()=>window.fixture.logoCalls.length);
  await page.evaluate(id=>window.fixture.emitLogo(id,{cleanup:'not-detected',cleanupVersion:4}),revised);
  await page.getByRole('button',{name:'Need change in logo',exact:true}).click();const repairDialog=page.getByRole('dialog',{name:'Mark remaining logo'});await repairDialog.waitFor();assert.equal(await page.evaluate(()=>window.fixture.logoCalls.length),callsBefore,'A known missed match opens selection without another no-op scan');
  const repairImage=repairDialog.getByRole('img',{name:'Select the remaining logo on this image'});assert.match(await repairImage.getAttribute('src'),/44444444/);
  await repairImage.evaluate((img,url)=>{img.style.width='400px';img.style.height='500px';img.src=url},assets[0].originalUrl);await repairImage.evaluate(img=>img.decode());
  const box=await repairDialog.locator('.logo-repair-canvas').boundingBox();await page.mouse.move(box.x+box.width*.8,box.y+box.height*.8);await page.mouse.down();await page.mouse.move(box.x+box.width*.9,box.y+box.height*.9,{steps:3});await page.mouse.up();await repairDialog.getByRole('button',{name:'Repair selected logo area'}).click();
  await page.waitForFunction(n=>window.fixture.logoCalls.length===n,callsBefore+1);const chosen=await page.evaluate(()=>window.fixture.logoCalls.at(-1));assert.equal(chosen.id,revised);assert.ok(Math.abs(chosen.area.x-.8)<.01&&Math.abs(chosen.area.width-.1)<.01);assert.equal(await repairDialog.count(),0);assert.equal(await page.getByRole('img',{name:'Selected imported Flow image'}).count(),0);await page.evaluate(()=>window.fixture.finishLogo());await page.getByRole('button',{name:'Approve',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.fixture.flowCalls.length),1,'Selected-area repair stays local');
  await page.evaluate(()=>{const f=window.fixture;window.frameStudio.generations.retryLogo=async id=>{f.logoCalls.push({id});f.emitLogo(id,{cleanup:'not-detected',cleanupVersion:4,status:'pending',phase:'complete',checkedAt:new Date().toISOString()});return {ok:true,value:{...f.logos.find(l=>l.attemptId===id)}}}});
  await page.getByRole('button',{name:'Need change in logo',exact:true}).click();await repairDialog.waitFor();assert.match(await repairDialog.getByRole('img').getAttribute('src'),/44444444/);await repairDialog.getByRole('button',{name:'Close dialog'}).click();
  const legacyBefore=await page.evaluate(()=>window.fixture.logoCalls.length);await page.evaluate(id=>window.fixture.emitLogo(id,{cleanup:'not-detected',cleanupVersion:3}),revised);await page.waitForFunction(n=>window.fixture.logoCalls.length===n,legacyBefore+1);await page.waitForTimeout(1200);assert.equal(await page.evaluate(()=>window.fixture.logoCalls.length),legacyBefore+1,'Older missed entries are rechecked once with the new engine');assert.equal(await page.getByRole('dialog').count(),0);
  console.log('PASS integrated Clips approval, direct image edit with exact selected source/comment, local logo retry without Flow, hidden unfinished images, red/yellow/green product lines, new revisions appear after cleanup and return to pending review, no separate logo tab; previous/next, keyboard/touch, scoped draft notes and older versions preserved.');
}catch(error){if(page)console.log('UI failure state:',page.url(),(await page.locator('body').innerText()).slice(-5000));throw error}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
