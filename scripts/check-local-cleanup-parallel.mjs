import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readdir,lstat} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import {LogoQueue,cleanupCapacity} from '../dist-electron/media/logo-queue.cjs'
import {Workspace} from '../dist-electron/storage/workspace.cjs'
import {FlowScheduler} from '../dist-electron/flow-scheduler.cjs'
import {WorkspaceManager} from '../dist-electron/workspace-manager.cjs'
assert.equal(cleanupCapacity(12,16*1024**3,5*1024**3).limit,11)
assert.equal(cleanupCapacity(2,4*1024**3,512*1024**2).limit,1)
const root=await mkdtemp(path.join(os.tmpdir(),'frame-local-parallel-')),sources=[]
for(let i=0;i<3;i++){const file=path.join(root,`source-${i}.png`);await sharp({create:{width:256,height:256,channels:3,background:{r:30+i*40,g:80,b:110}}}).png().toFile(file);sources.push(file)}
// Deterministic startup barrier proves two actual workers can run before the
// first finishes. Each then executes the real PNG cleanup worker.
const fixture=path.join(root,'barrier.cjs')
await writeFile(fixture,`const{parentPort,workerData}=require('node:worker_threads');const counter=new Int32Array(workerData.shared);const n=Atomics.add(counter,0,1)+1;parentPort.postMessage({type:'progress',percent:1,message:'Worker started'});if(n<2)Atomics.wait(counter,0,n,5000);else Atomics.notify(counter,0);require(workerData.actual);`)
const pool=new LogoQueue(2,fixture),shared=new SharedArrayBuffer(4),active=new Set(),events=[]
let maximum=0
const tasks=sources.map((source,i)=>pool.run(`image-${i}`,{source,target:path.join(root,`clean-${i}.png`),shared,actual:path.resolve('dist-electron/media/logo-worker.cjs')},(percent)=>{events.push([i,percent]);if(percent===1){active.add(i);maximum=Math.max(maximum,active.size)}if(percent===95)active.delete(i)}))
await assert.rejects(()=>pool.run('image-0',{source:sources[0],target:path.join(root,'duplicate.png')}),/already being processed/)
await Promise.all(tasks);assert.equal(maximum,2);assert.ok(events.map((e,i)=>e[1]===1?i:-1).filter(i=>i>=0)[1]<events.findIndex(e=>e[1]===95))
const constrained=new LogoQueue(6,undefined,128*1024**2);let memoryActive=0,memoryMax=0
await Promise.all(sources.map((source,i)=>constrained.run(`limited-${i}`,{source,target:path.join(root,`limited-${i}.png`)},percent=>{if(percent===5){memoryActive++;memoryMax=Math.max(memoryMax,memoryActive)}if(percent===95)memoryActive--})))
assert.equal(memoryMax,1,'Image memory estimates reduce parallelism when the memory budget is constrained')
assert.ok(!events.some(e=>e[1]===100),'Workers cannot claim 100% before the project file is committed')
for(let i=0;i<3;i++){const p=await sharp(path.join(root,`clean-${i}.png`)).removeAlpha().raw().toBuffer();assert.equal(p[0],30+i*40,'Parallel images retain their own pixels')}
const normal=new LogoQueue(2),bad=path.join(root,'bad.png');await writeFile(bad,'invalid image')
const settled=await Promise.allSettled([normal.run('bad',{source:bad,target:path.join(root,'bad-out.png')}),normal.run('good',{source:sources[0],target:path.join(root,'good.png')})]);assert.equal(settled[0].status,'rejected');assert.equal(settled[1].status,'fulfilled');await normal.drain()

let ws=await Workspace.open(path.join(root,'workspace')),scheduler,pump
try{
 const assets=[];for(const source of sources)assets.push(await ws.importImage(source))
 const product=await ws.products.save({name:'Three products',description:'',notes:'',assetIds:assets.map(a=>a.id),primaryAssetId:assets[0].id}),theme=await ws.themes.save({name:'Theme',description:'',coverAssetId:null,referenceAssetIds:[],masterPrompt:'Style product',outputType:'post',aspectRatio:'1:1',defaultDuration:0,compositionPrompt:'One image',scenes:[]}),project=await ws.projects.save({name:'Parallel cleanup',productId:product.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-square',duration:0})
 const original=ws.exports.normalizeFlowResult.bind(ws.exports),remote=new Map(),downloads=[],progress=[]
 let count=0,release,prepared,submits=0
 const barrier=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Second result was blocked behind the first local cleanup')),5000);release=()=>{clearTimeout(timeout);resolve()}})
 ws.exports.normalizeFlowResult=async(...args)=>{count++;if(count===2)release();if(count<=2)await barrier;return original(...args)}
 ws.generations.onLogoProgress(value=>{progress.push(value);if(value.percent===100)assert.equal(ws.generations.get(value.attemptId).state,'ready-for-review','Review opens only after the final file commits')})
 const driver={async createProject(commit){const url='https://flow.google.com/project/parallel-local';await commit(url);return url},async nameProject(){},async prepare(_url,r){prepared=r;return [...remote.keys()]},async submit(){submits++;remote.set(`result-${submits}`,prepared)},async results(_url,prompt,_type,baseline){return [...remote].filter(([id,r])=>r.prompt===prompt&&!baseline.includes(id)).map(([id])=>({id,selector:'#result'}))},async download(_url,result,directory){downloads.push(result.id);const r=remote.get(result.id),index=r.sceneId==='post'?0:assets.findIndex(a=>a.id===r.sceneId);const file=path.join(directory,'original.png');await writeFile(file,await sharp(sources[index]).png().toBuffer());return file}}
 scheduler=new FlowScheduler(async()=>ws,()=>driver,10,10000);pump=setInterval(()=>void scheduler.collectPending(),10)
 await scheduler.startPosts(project.id);const end=Date.now()+15000;while(scheduler.busy&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(scheduler.busy,false);await scheduler.collectPending()
 assert.equal(count,3);assert.equal(downloads.length,3);assert.equal(submits,3)
 const attempts=await ws.generations.list(project.id);assert.equal(attempts.filter(a=>a.state==='ready-for-review').length,3)
 for(const a of attempts){const rows=progress.filter(p=>p.attemptId===a.id);assert.ok(rows.some(p=>p.status==='processing'&&p.percent===0));assert.equal(rows.at(-1).percent,100);assert.equal(rows.at(-1).status,'pending');assert.ok(rows.filter(p=>p.status==='processing').every(p=>p.percent<100));await assert.rejects(()=>lstat(ws.paths.resolve(`temp/flow/${a.id}`)),{code:'ENOENT'})}
 assert.equal((await readdir(await ws.generations.folder(project.id))).length,3)
 const id=attempts[0].id;ws.generations.beginLogoCleanup(id);ws.generations.logoProgress(id,42,'Checking logo patterns');await ws.generations.review(project.id,attempts[0].sceneId,id,'needs-changes','Change the background');await assert.rejects(()=>ws.generations.prepareAutomatic(project.id,attempts[0].sceneId),/cleanup/);await scheduler.close();clearInterval(pump);await ws.close();ws=await Workspace.open(path.join(root,'workspace'))
 const interrupted=(await ws.generations.logoReviews(project.id)).find(p=>p.attemptId===id);assert.equal(interrupted.phase,'failed');assert.equal(interrupted.percent,42);await assert.rejects(()=>ws.generations.reviewLogo(id,'approved'),/finish/);const retried=await ws.generations.retryLogo(id);assert.equal(retried.percent,100);assert.equal(retried.status,'pending')
 const manager=new WorkspaceManager(path.join(root,'shutdown-workspace'));await manager.status();let unblock,closed=false
 const hold=new Promise(resolve=>{unblock=resolve})
 const operation=manager.generationOperation(async()=>{await hold;return(await manager.automationWorkspace()).status()})
 const closing=manager.close().then(()=>{closed=true});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(closed,false,'App shutdown must wait for local cleanup/import operations before closing SQLite');unblock();assert.equal((await operation).ok,true);await closing
 console.log('PASS two real worker threads with a bounded third queue, per-image pixels, duplicate-job rejection and worker-error recovery; next Flow result downloads before prior local cleanup finishes; real progress reaches 100 only after commit; single files, restart interruption, local retry and safe shutdown preserved.')
}finally{clearInterval(pump);await scheduler?.close();await ws.close()}
