// Durable image-change queue under an active multi-product upload.
import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import {Workspace} from '../dist-electron/storage/workspace.cjs'
import {FlowScheduler} from '../dist-electron/flow-scheduler.cjs'
import {StorageError} from '../dist-electron/storage/errors.cjs'
import {postPhotos} from '../dist-electron/storage/post-plan.mjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-edit-queue-')),folder=path.join(root,'workspace')
let ws=await Workspace.open(folder),scheduler,pump
const assets=[]
for(let n=0;n<4;n++){const file=path.join(root,`${n}.png`);await sharp({create:{width:40,height:50,channels:3,background:{r:25+n*40,g:80,b:100}}}).png().toFile(file);assets.push(await ws.importImage(file))}
const product=await ws.products.save({name:'Products',description:'',notes:'',assetIds:assets.map(a=>a.id),primaryAssetId:assets[0].id})
const theme=await ws.themes.save({name:'Theme',description:'',coverAssetId:null,referenceAssetIds:[],masterPrompt:'Preserve product.',outputType:'post',aspectRatio:'4:5',defaultDuration:0,compositionPrompt:'',scenes:[]})
const make=name=>ws.projects.save({name,productId:product.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-portrait',duration:0})
const project=await make('Queue changes'),photos=postPhotos(project)
const saveImage=async sceneId=>{const a=await ws.generations.prepareAutomatic(project.id,sceneId);await ws.generations.setState(a.id,'submission-uncertain');await ws.generations.importResult(a.id,path.join(root,'0.png'));ws.generations.recordLogoCleanup(a.id,true);return a}
const first=await saveImage(photos[0].id),second=await saveImage(photos[1].id)
let entered=false,unblock,policyProject=''
const gate=new Promise(resolve=>{unblock=resolve}),prepared=new Map(),remote=new Map(),sent=[]
const factory=id=>({
 createProject:async commit=>{const url=`https://flow.google.com/project/${id}`;await commit(url);return url},nameProject:async()=>{},
 prepare:async(url,request)=>{
  assert.equal(url,`https://flow.google.com/project/${id}`)
  prepared.set(id,request)
  if(id===project.id&&!entered){entered=true;await gate}
  const attempt=(await ws.generations.list(id)).find(a=>a.state==='queued'&&!ws.flow.job(a.id)?.editQueued)
  if(attempt?.revision){assert.ok(request.prompt.includes(attempt.revision.note));assert.equal(request.files.at(-1),(await ws.generations.resultFile(attempt.revision.sourceAttemptId)).path)}
  return [...remote.keys()]
 },
 submit:async()=>{const request=prepared.get(id),media=randomUUID();sent.push({projectId:id,prompt:request.prompt});remote.set(media,{projectId:id,prompt:request.prompt,readyAt:Date.now()+5})},
 results:async(_url,prompt,_kind,baseline)=>{
  if(id===policyProject&&prompt.includes('Product photo 1 of 4:'))throw new StorageError('INVALID_REQUEST','Flow generation failed: This generation might violate our policies. Other products can continue; this request is not automatically resubmitted.')
  return [...remote].filter(([media,r])=>r.projectId===id&&r.prompt===prompt&&!baseline.includes(media)&&r.readyAt<=Date.now()).map(([media])=>({id:media,selector:'#'+media}))
 },download:async()=>path.join(root,'0.png'),close:async()=>{},
})
const until=async(predicate,label)=>{const end=Date.now()+10000;while(!await predicate()&&Date.now()<end)await delay(3);assert.ok(await predicate(),label)}
const settle=()=>until(()=>!scheduler.busy,'All queued requests complete')
try{
 scheduler=new FlowScheduler(async()=>ws,factory,5,3000);pump=setInterval(()=>void scheduler.collectPending().catch(()=>{}),10)
 await scheduler.startPosts(project.id);await until(()=>entered,'Other product upload is active')
 const queue=async(source,sceneId,note)=>{await ws.generations.review(project.id,sceneId,source.id,'needs-changes',note);return Promise.race([scheduler.start(project.id,sceneId,1),delay(500).then(()=>{throw Error('Queuing waited for the active upload')})])}
 const a=await queue(first,photos[0].id,'Add blue bag'),b=await queue(second,photos[1].id,'Warm lighting')
 assert.equal(a.editQueued,true);assert.equal(b.editQueued,true);assert.equal(sent.length,0)
 await assert.rejects(()=>scheduler.start(project.id,photos[0].id,1),/active|uncertain/)
 await ws.generations.review(project.id,photos[0].id,first.id,'needs-changes','Different later draft')
 assert.deepEqual(ws.generations.get(a.attemptId).revision,{sourceAttemptId:first.id,note:'Add blue bag'})
 assert.deepEqual(ws.generations.get(b.attemptId).revision,{sourceAttemptId:second.id,note:'Warm lighting'})
 unblock();await settle()
 assert.equal(sent.length,4,'Two original products and two queued changes submit once each')
 assert.equal(ws.generations.get(a.attemptId).state,'ready-for-review');assert.equal(ws.generations.get(b.attemptId).state,'ready-for-review')
 // Queue entries survive a restart before activation. Their source/note stay fixed.
 await ws.generations.review(project.id,photos[1].id,b.attemptId,'needs-changes','Restart-safe change')
 const frozen=await ws.generations.prepareDeferredRevision(project.id,photos[1].id)
 assert.equal(ws.flow.job(frozen.id).editQueued,true,'Snapshot and durable queue intent commit together')
 ws.flow.saveJob({attemptId:frozen.id,projectId:project.id,stage:'preparing',editQueued:true,message:'Queued',projectUrl:'',baseline:[],resultIds:[],imported:{},outputs:1,updatedAt:''})
 clearInterval(pump);await scheduler.close();await ws.close();ws=await Workspace.open(folder)
 assert.equal(ws.generations.get(frozen.id).state,'queued');assert.equal(ws.flow.job(frozen.id).editQueued,true)
 scheduler=new FlowScheduler(async()=>ws,factory,5,3000);await scheduler.collectPending();await settle()
 assert.equal(ws.generations.get(frozen.id).state,'ready-for-review');assert.equal(sent.filter(s=>s.prompt.includes('Restart-safe change')).length,1)
 const policy=await make('Failed generation isolation');policyProject=policy.id
 await scheduler.startPosts(policy.id);await settle()
 assert.equal((await ws.generations.list(policy.id)).filter(a=>a.state==='ready-for-review').length,3)
 const failed=ws.flow.jobs(policy.id).find(j=>j.generationFailed);assert.ok(failed);assert.equal(ws.generations.get(failed.attemptId).state,'failed')
 assert.equal(sent.filter(s=>s.projectId===policy.id).length,4,'A confirmed provider failure does not stop siblings or resubmit itself')
 console.log('PASS immediate multi-image edit enqueue during upload, frozen source/note snapshots, FIFO execution without duplicates, queued restart recovery and confirmed provider failure isolation.')
}finally{clearInterval(pump);unblock();await scheduler?.close();await ws.close()}
