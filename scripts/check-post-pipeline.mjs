// Isolated scheduling/storage check: no Chrome/account, uploads or Flow credits.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'
import { FlowCoordinator } from '../dist-electron/flow-coordinator.cjs'
import { StorageError } from '../dist-electron/storage/errors.cjs'
import { postPhotos } from '../dist-electron/storage/post-plan.mjs'

const root=await mkdtemp(path.join(os.tmpdir(),'frame-post-pipeline-')),folder=path.join(root,'workspace')
let ws=await Workspace.open(folder)
const assets=[]
for(let n=0;n<7;n++){
  const file=path.join(root,`photo-${n}.png`)
  await writeFile(file,await sharp({create:{width:40,height:50,channels:3,background:{r:20+n*25,g:70,b:90}}}).png().toBuffer())
  assets.push(await ws.importImage(file))
}
const product=await ws.products.save({name:'Five products',description:'',notes:'',assetIds:assets.slice(0,5).map(x=>x.id),primaryAssetId:assets[0].id})
const theme=await ws.themes.save({name:'Two directions',description:'',coverAssetId:null,referenceAssetIds:assets.slice(5).map(x=>x.id),masterPrompt:'Use the selected product and visual direction.',outputType:'post',aspectRatio:'1:1',defaultDuration:0,compositionPrompt:'One styled product photograph.',scenes:[]})
const makeProject=name=>ws.projects.save({name,productId:product.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-square',duration:0})
const first=await makeProject('Pipeline'),slots=postPhotos(first)
const events=[],remote=new Map(),byPrompt=new Map(),perUrl=new Map()
let current,created=0,submitted=0,stall=false,failSecond=false,submitForProject=0,firstUrl='',maxPending=0,browserBusy=false
const op=async(name,fn)=>{
  assert.equal(browserBusy,false,'Composer/results/download UI actions must never overlap')
  browserBusy=true;events.push(name)
  try{return await fn()}finally{browserBusy=false}
}
const driver={
  createProject:commit=>op('create',async()=>{const url=`https://flow.google.com/project/pipeline-${++created}`;await commit(url);if(!firstUrl)firstUrl=url;return url}),
  nameProject:()=>op('name',async()=>{}),
  prepare:(url,request)=>op('prepare',async()=>{current={url,...request};assert.equal(request.outputs,1);assert.equal(request.files.length,2);return [...remote.keys()]}),
  submit:url=>op('submit',async()=>{
    submitted++;submitForProject++;const id=`remote-${submitted}`
    remote.set(id,{...current,id});byPrompt.set(current.prompt,id);perUrl.set(url,(perUrl.get(url)||0)+1)
    const pending=(await ws.generations.list(remote.get(id).projectId||first.id)).filter(a=>a.state==='submission-uncertain').length
    maxPending=Math.max(maxPending,pending)
    if(submitted===1){
      const batch=ws.flow.latest(first.id).postBatch.id
      await assert.rejects(()=>ws.generations.prepareBatch(first.id,slots[3].id,batch),/active or uncertain/,'An unacknowledged submission cannot authorize the next request')
      await assert.rejects(()=>ws.generations.prepareBatch(first.id,slots[3].id,randomUUID()),/active or uncertain/)
    }
    if(failSecond&&submitForProject===2)throw new StorageError('INVALID_REQUEST','Fixture acknowledgement lost')
  }),
  results:(url,prompt,_type,baseline)=>op('results',async()=>{
    if(stall||(url===firstUrl&&perUrl.get(url)<3))return []
    const id=byPrompt.get(prompt)
    return id&&!baseline.includes(id)?[{id,selector:`#${id}`}]:[]
  }),
  download:()=>op('download',async()=>{
    if(created===1)assert.ok(submitted>=3,'Three requests must be accepted before collecting the first result')
    return path.join(root,'photo-0.png')
  }),
}
const settle=async runner=>{
  const end=Date.now()+10000
  while(runner.busy&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(runner.busy,false)
}
let runner=new FlowCoordinator(async()=>ws,driver,5,500)
try{
  // This is the old single-product entry point used in the user's failed case.
  // It must now start every missing product rather than silently stop at one.
  await runner.start(first.id,'post',1);await settle(runner)
  assert.equal(submitted,5);assert.equal(created,1)
  assert.equal(events.slice(0,events.indexOf('results')).filter(x=>x==='submit').length,3)
  assert.equal(maxPending,3,'Three durable submitted attempts coexist')
  assert.equal((await ws.generations.list(first.id)).filter(x=>x.state==='ready-for-review').length,5)
  assert.equal((await ws.generations.reviews(first.id)).length,0,'No approval is needed anywhere in the batch')
  const old=(await ws.generations.list(first.id)).find(x=>x.sceneId===slots[2].id)
  await ws.generations.review(first.id,slots[2].id,old.id,'approved','Keep this')
  await runner.start(first.id,slots[2].id,1);await settle(runner)
  assert.equal(submitted,6,'Only the selected existing result is regenerated')
  assert.equal((await ws.generations.reviews(first.id))[0].selectedAttemptId,old.id)

  // A project already containing one unapproved image still generates all four
  // missing products; the saved result is neither regenerated nor approval-gated.
  const partial=await makeProject('One result already saved')
  const saved=await ws.generations.prepare(partial.id,'post')
  await ws.generations.setState(saved.id,'submission-uncertain');await ws.generations.importResult(saved.id,path.join(root,'photo-0.png'))
  const before=submitted;await runner.startPosts(partial.id);await settle(runner)
  assert.equal(submitted-before,4)
  assert.equal((await ws.generations.list(partial.id)).filter(x=>x.state==='ready-for-review').length,5)
  assert.equal((await ws.generations.reviews(partial.id)).length,0)

  // Accepted requests survive restart. Resume all only collects; missing items
  // need a fresh Generate action and never resubmit already accepted requests.
  const restart=await makeProject('Restart with three pending requests')
  stall=true;const beforeStall=submitted
  await runner.startPosts(restart.id);await settle(runner)
  assert.equal(submitted-beforeStall,3)
  assert.equal((await ws.generations.list(restart.id)).filter(x=>x.state==='submission-uncertain').length,3)
  await assert.rejects(()=>ws.generations.prepare(first.id,'post'),/active or uncertain/)
  await ws.close();ws=await Workspace.open(folder)
  runner=new FlowCoordinator(async()=>ws,driver,5,1000);stall=false
  await runner.resumePosts(restart.id);await settle(runner)
  assert.equal(submitted-beforeStall,3,'Resume all never submits any request')
  assert.equal((await ws.generations.list(restart.id)).filter(x=>x.state==='ready-for-review').length,3)
  await runner.startPosts(restart.id);await settle(runner)
  assert.equal(submitted-beforeStall,5)

  const uncertain=await makeProject('Second acknowledgement lost')
  failSecond=true;submitForProject=0;const beforeFailure=submitted
  await runner.startPosts(uncertain.id);await settle(runner)
  assert.equal(submitted-beforeFailure,2,'Uncertain submission prevents the third request')
  assert.equal((await ws.generations.list(uncertain.id)).filter(x=>x.state==='ready-for-review').length,1,'Earlier accepted result is still collected')
  failSecond=false;await runner.resumePosts(uncertain.id);await settle(runner)
  assert.equal(submitted-beforeFailure,2,'Acknowledgement recovery does not resubmit')
  await runner.startPosts(uncertain.id);await settle(runner)
  assert.equal(submitted-beforeFailure,5)

  const race=await makeProject('Concurrent manual prepare guard')
  const raced=await Promise.allSettled([ws.generations.prepare(race.id,'post'),ws.generations.prepare(race.id,slots[1].id)])
  assert.equal(raced.filter(x=>x.status==='fulfilled').length,1,'Transactional guard retains one manual request across different products')
  for(const result of raced)if(result.status==='fulfilled')await ws.generations.setState(result.value.id,'failed')

  // Real v10 -> v11 migration fixture, preserving existing results/approvals.
  const count=(await ws.generations.list(first.id)).length
  await ws.close()
  const db=new DatabaseSync(path.join(folder,'workspace.sqlite'))
  db.exec("DROP TABLE logo_reviews; ALTER TABLE generation_attempts DROP COLUMN theme_reference_json; ALTER TABLE generation_attempts DROP COLUMN revision_json; ALTER TABLE generation_attempts DROP COLUMN automation_scope; DROP INDEX generation_scene_active; DROP INDEX generation_active; CREATE UNIQUE INDEX generation_single_active ON generation_attempts((1)) WHERE state IN ('queued','paused','submission-uncertain'); DELETE FROM schema_migrations WHERE version>=11; PRAGMA user_version=10;")
  db.close();ws=await Workspace.open(folder)
  assert.equal((await ws.status()).schemaVersion,18)
  assert.equal((await ws.generations.list(first.id)).length,count)
  assert.equal((await ws.generations.reviews(first.id))[0].selectedAttemptId,old.id)
  console.log('PASS default Generate covers all products; max 3 acknowledged requests overlap before collection; UI commands serialized; no approval wait; saved results skipped; restart/resume all without resubmission; uncertainty stops new requests; v10 migration preserves results and approvals.')
}finally{await ws.close()}
