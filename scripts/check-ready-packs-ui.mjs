import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { _electron as electron } from 'playwright'
const profile=await mkdtemp(path.join(os.tmpdir(),'frame-studio-check-'))
await mkdir(path.join(profile,'product-discovery'),{recursive:true});await writeFile(path.join(profile,'product-discovery/library.json'),JSON.stringify({settings:{youtubeKey:'',geminiKey:'',ai:'hybrid',model:'FIXTURE-local-model',channels:'',pages:[]},products:[],nextRunAt:null}));
const env={...process.env,FRAME_STUDIO_TEST_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.FRAME_STUDIO_DEV_URL
const unpacked=process.argv[2]
const desktop=await electron.launch({...unpacked?{executablePath:unpacked,args:['--frame-studio-package-check']}:{args:['.']},env})
try{
 const page=await desktop.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.getByRole('link',{name:'Product Find',exact:true}).click();await page.getByRole('heading',{name:'Ready Post Packs',exact:true}).waitFor()
 const legacy=await page.evaluate(()=>window.frameStudio.discovery.status());assert.equal(legacy.settings.ai,'antigravity');assert.equal(legacy.settings.model,'');assert.equal(JSON.parse(await readFile(path.join(profile,'product-discovery/library.json.before-account-ai.bak'),'utf8')).settings.model,'FIXTURE-local-model');
 const initial=await page.evaluate(()=>window.frameStudio.readyPacks.status());assert.equal(initial.plan.length,56);assert.equal(initial.packs.length,0);assert.equal(initial.providers.find(p=>p.id==='flipkart').status.startsWith('Blocked'),true)
 const rows=Array.from({length:6},(_,i)=>({url:`https://meesho.com/fixture-${i}/p/fixture${i}`,title:`FIXTURE ${['Floral','Printed','Striped','Plain','Lace','Woven'][i]} short kurti`,price:499,currency:'INR',observedAt:new Date().toISOString(),variant:'blue',color:'blue',match:'exact'}))
 await page.evaluate(async rows=>{const state=await window.frameStudio.readyPacks.status();await window.frameStudio.readyPacks.action({type:'settings',value:{...state.settings,ai:{provider:'none',model:'',effort:'medium'}}});await window.frameStudio.readyPacks.action({type:'import-text',value:JSON.stringify(rows)});await window.frameStudio.readyPacks.action({type:'generate'})},rows)
 await page.waitForFunction(async()=>{const s=await window.frameStudio.readyPacks.status();return s.job.state!=='running'&&s.packs.length===3})
 const result=await page.evaluate(()=>window.frameStudio.readyPacks.status());assert.equal(result.packs[0].productIds.length,5);assert.equal(result.packs[1].productIds.length,0);assert.ok(result.packs[1].reasons.some(r=>r.startsWith('Incomplete')))
 await page.getByRole('heading',{name:/short kurtis/}).waitFor();assert.equal(await page.getByRole('button',{name:'Replace',exact:true}).count(),5)
 await page.getByRole('button',{name:'Copy all original links',exact:true}).click();const copied=await desktop.evaluate(({clipboard})=>clipboard.readText());assert.equal(copied.split('\n').length,5)
 await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/ready-packs-fixture-ui.png',fullPage:true});assert.deepEqual(errors,[])
 console.log('PASS isolated desktop: IPC, planner, blocked setup, feed import, generated queue, incomplete packs, product cards, clipboard, no renderer errors. Screenshot: artifacts/ready-packs-fixture-ui.png')
}finally{await desktop.close()}
