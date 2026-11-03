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
  const context=await browser.newContext({viewport:{width:1500,height:1000},reducedMotion:'reduce'});await context.addInitScript(()=>{if(!localStorage.getItem('frame-studio-theme'))localStorage.setItem('frame-studio-theme','light')})
  await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort())
  await context.addInitScript(({theme,product,character,project})=>{
    project.snapshot={theme,product,character}
    const ok=value=>Promise.resolve({ok:true,value})
    window.fixture={theme,project,submitted:0,saved:null}
    window.frameStudio={platform:'windows',phase:11,
      flow:{status:async()=>({state:'connected',message:'Fixture',pageTitle:'Fixture',checkedAt:null}),jobs:()=>ok([]),job:()=>ok(null),project:()=>ok(null),activeRequest:()=>ok(null),generatePosts:()=>{window.fixture.submitted++;return new Promise(resolve=>{window.fixture.finishGenerate=()=>resolve({ok:true,value:{projectId:project.id,attemptId:'fixture',stage:'complete',message:'Fixture request accepted',activity:[]}})})}},
      themes:{get:()=>ok(theme),list:()=>ok([theme]),trash:()=>ok([]),save:draft=>{Object.assign(theme,draft,{revision:theme.revision+1});window.fixture.saved=JSON.parse(JSON.stringify(draft));return ok(theme)}},
      products:{list:()=>ok({items:[product],total:1}),trash:()=>ok([])},characters:{list:()=>ok([character])},projects:{get:()=>ok(project),list:()=>ok([project]),deleted:()=>ok([])},
      generations:{list:()=>ok([]),reviews:()=>ok([]),logoReviews:()=>ok([])},exports:{inspect:()=>ok(null)},images:{chooseManyAndImport:()=>ok({assets:[theme.images[0]],failures:[]})},
    }
  },{theme,product,character,project})
  page=await context.newPage();page.on('pageerror',error=>console.log('Fixture page error:',error.message));await page.goto(`${origin}/#themes/${theme.id}`)
  await page.locator('#cover-use-count').selectOption('2');assert.equal(await page.locator('#cover-use-count').inputValue(),'2');await page.locator('#cover-use-count').selectOption('1');
  await page.getByRole('button',{name:'Reference instructions',exact:true}).click()
  assert.equal(await page.getByRole('button',{name:'Composition',exact:true}).count(),0,'Post theme has no separate Composition tab');
  assert.equal(await page.locator('[id^="reference-negative-"]').count(),0,'Reference editor has no negative-prompt fields');
  assert.equal(await page.locator('[id^="reference-composition-"]').count(),2,'Each image retains its composition prompt');
  await mkdir('.verification',{recursive:true});
  for(const mode of ['light','dark']){
    if(mode==='dark')await page.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
    const colors=await page.locator(`#reference-composition-${assets[2].id}`).evaluate(el=>({text:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor}));
    const luminance=color=>{const channels=color.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{const s=n/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4});return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722};
    const a=luminance(colors.text),b=luminance(colors.background);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`${mode}: readable form contrast`);
    await page.screenshot({path:`.verification/theme-${mode}.png`});
  }
  await page.getByRole('button',{name:'Switch to light mode',exact:true}).click();
  await page.locator(`#reference-composition-${assets[2].id}`).fill('MIRROR_EDIT with a heading and a blue bag.')
  assert.equal(await page.locator(`#reference-composition-${assets[3].id}`).inputValue(),'SEATED_ONLY on a white chair.')
  await page.getByRole('button',{name:'Save changes',exact:true}).click()
  await page.waitForURL('**/#themes')
  const saved=await page.evaluate(()=>window.fixture.saved)
  assert.equal(saved.coverUseCount,1);
  assert.equal(saved.referenceInstructions[0].compositionPrompt,'MIRROR_EDIT with a heading and a blue bag.')
  assert.equal(saved.referenceInstructions[1].compositionPrompt,'SEATED_ONLY on a white chair.')
  assert.equal(saved.compositionPrompt,'SHARED_FALLBACK','Legacy saved fallback is preserved without exposing another editor');
  assert.equal(saved.referenceInstructions[0].negativePrompt,'NO_MIRROR_GLARE','Removing a field does not destroy legacy instructions');
  await page.goto(`${origin}/#studio`);await page.getByRole('heading',{name:'Your projects',exact:true}).waitFor();
  assert.equal(await page.locator('.welcome-panel').count(),0);assert.equal(await page.getByText('Start a project',{exact:true}).count(),0,'Studio opens directly to projects');assert.ok(await page.getByRole('link',{name:'New project',exact:true}).count()>0,'Project creation stays available');
  await page.screenshot({path:'.verification/studio-light.png'});await page.getByRole('button',{name:'Switch to dark mode',exact:true}).click();await page.screenshot({path:'.verification/studio-dark.png'});
  await page.setViewportSize({width:1100,height:850});assert.equal(await page.locator('.page-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth+2),true,'Workspace fits a laptop window');await page.setViewportSize({width:1500,height:1000});
  await page.goto(`${origin}/#studio/${project.id}`)
  await page.getByRole('button',{name:/Clips/}).click()
  await page.getByText('References and prompts',{exact:true}).click()
  const mappings=page.locator('.clip-prompt-details .reference-prompt-preview')
  assert.equal(await mappings.count(),2)
  const first=await mappings.nth(0).innerText(),second=await mappings.nth(1).innerText()
  assert.match(first,/MIRROR_EDIT/);assert.doesNotMatch(first,/SEATED_ONLY|NO_CHAIR_DISTORTION|SHARED_FALLBACK/)
  assert.match(second,/SEATED_ONLY/);assert.doesNotMatch(second,/MIRROR_EDIT|NO_MIRROR_GLARE|SHARED_FALLBACK/)
  assert.equal(await mappings.nth(0).getByRole('img',{name:'Mirror direction',exact:true}).getAttribute('src'),assets[2].thumbnailUrl)
  assert.equal(await mappings.nth(1).getByRole('img',{name:'Seated direction',exact:true}).getAttribute('src'),assets[3].thumbnailUrl)
  assert.equal(await page.evaluate(()=>window.fixture.submitted),0,'Every mapping is reviewable before a generation API is called')
  await mkdir('.verification',{recursive:true});await page.screenshot({path:'.verification/reference-prompt-preview.png'})
  const generate=page.getByRole('button',{name:'Generate 2 product images',exact:true});await generate.click();await page.waitForFunction(()=>window.fixture.submitted===1);assert.equal(await page.getByRole('dialog').count(),0,'Generate has no asking popup');assert.equal(await generate.isDisabled(),true,'An accepted click cannot be repeated while startup is pending');
  await generate.evaluate(button=>{button.dispatchEvent(new MouseEvent('click',{bubbles:true}));button.dispatchEvent(new MouseEvent('click',{bubbles:true}))});assert.equal(await page.evaluate(()=>window.fixture.submitted),1,'Repeated clicks cannot submit another batch');await page.evaluate(()=>window.fixture.finishGenerate());await page.waitForFunction(()=>!document.querySelector('.flow-automation-panel .button-primary')?.disabled);
  await page.goto(origin+'/#themes/new');page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Defaults',exact:true}).click();await page.locator('#theme-output').selectOption('post');await page.getByRole('button',{name:'Add cover',exact:true}).click();await page.getByRole('checkbox',{name:'Use this image as a Flow reference'}).check();await page.locator('#cover-use-count').selectOption('2');assert.equal(await page.locator('#cover-use-count').inputValue(),'2');
  await page.reload();await page.getByRole('button',{name:'Switch to light mode',exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'dark','Appearance persists across app reloads');
  console.log('PASS Studio banner removed with New project preserved; Generate starts once without a popup, repeated clicks blocked during startup; optional exact reference/prompt mapping, light/dark contrast, laptop layout, persisted appearance and simplified theme editor preserved.')
}catch(error){if(page)console.log('UI failure state:',page.url(),(await page.locator('body').innerText()).slice(-5000));throw error}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
