// Integration of the production scheduler/storage, with a fake Flow driver.
// No real Chrome, user workspace, uploads or credits are used.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'
import { FlowScheduler } from '../dist-electron/flow-scheduler.cjs'
import { postPhotos } from '../dist-electron/storage/post-plan.mjs'
import { StorageError } from '../dist-electron/storage/errors.cjs'
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const root=await mkdtemp(path.join(os.tmpdir(),'frame-multi-project-')),folder=path.join(root,'workspace')
let ws=await Workspace.open(folder)
const projects=[],colors=['#d33a44','#33ab54','#3266db'],sources=new Map()
for(let i=0;i<3;i++) {
  const assets=[]
  for(let n=0;n<3;n++){const file=path.join(root,`${i}-${n}.png`);await writeFile(file,await sharp({create:{width:40,height:48,channels:3,background:colors[i]}}).png().toBuffer());assets.push(await ws.importImage(file))}
  const product=await ws.products.save({name:`Product-${i}`,description:'',notes:'',assetIds:assets.slice(0,2).map(x=>x.id),primaryAssetId:assets[0].id})
  const theme=await ws.themes.save({name:`Theme-${i}`,description:'',coverAssetId:null,referenceAssetIds:[assets[2].id],masterPrompt:`Project ${i} direction`,outputType:'post',aspectRatio:'1:1',defaultDuration:0,compositionPrompt:`Project ${i} product`,scenes:[]})
  const project=await ws.projects.save({name:'Same name',productId:product.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-square',duration:0})
  projects.push(project);sources.set(project.id,path.join(root,`${i}-0.png`))
}
const submitted=[],remote=new Map(),prepared=new Map(),events=[]
const inBrowser=new Set()
let maxSubmitted=0,stall=false,uncertainProject='',deleteDuringPrepare=''
const op=async(projectId,action,fn)=>{
  assert.equal(inBrowser.has(projectId),false,'Commands within one project must never overlap')
  inBrowser.add(projectId);events.push({projectId,action})
  try{await pause(1);return await fn()}finally{inBrowser.delete(projectId)}
}
const factory=projectId=>{
  const url=`https://flow.google.com/project/${projectId}`
  const check=actual=>assert.equal(actual,url,'A project may never touch another project URL')
  return {
    createProject:commit=>op(projectId,'create',async()=>{await commit(url);return url}),
    nameProject:(actual,name)=>op(projectId,'name',async()=>{check(actual);assert.equal(name,'Same name')}),
    prepare:(actual,request)=>op(projectId,'prepare',async()=>{
      check(actual)
      const project=projects.find(x=>x.id===projectId),slot=postPhotos(project).find(x=>x.id===request.sceneId)
      if(project.outputType==='post')assert.deepEqual(request.references,[slot.product.id,slot.reference.id])
      else {assert.equal(request.sceneId,project.storyboard.scenes[0].id);assert.equal(request.outputType,'reel');assert.equal(request.sourceDuration,8)}
      assert.ok(request.files.every(file=>project.snapshot.product.photos.concat(project.snapshot.theme.images).some(asset=>file.includes(asset.id))))
      prepared.set(projectId,request)
      if(deleteDuringPrepare===projectId){const p=await ws.projects.get(projectId);await ws.projects.trash(projectId,p.revision);await scheduler.stopDeletedProject(projectId);prepared.delete(projectId)}
      return [...remote.keys()]
    }),
    submit:actual=>op(projectId,'submit',async()=>{
      check(actual);assert.ok(prepared.has(projectId),'Submit must use the request prepared in its own project tab')
      const request=prepared.get(projectId),id=`result-${randomUUID()}`
      remote.set(id,{projectId,url,prompt:request.prompt,readyAt:Date.now()+30});submitted.push({projectId,id})
      maxSubmitted=Math.max(maxSubmitted,ws.generations.submittedCount())
      if(uncertainProject===projectId)throw new StorageError('INVALID_REQUEST','Fixture lost acknowledgement')
    }),
    results:(actual,prompt,_kind,baseline)=>op(projectId,'results',async()=>{
      check(actual)
      if(stall||_kind==='reel')return []
      return [...remote].filter(([id,r])=>r.projectId===projectId&&r.prompt===prompt&&r.readyAt<=Date.now()&&!baseline.includes(id)).map(([id])=>({id,selector:`#${id}`}))
    }),
    download:(actual,result)=>op(projectId,'download',async()=>{check(actual);assert.equal(remote.get(result.id).projectId,projectId);return sources.get(projectId)}),
    close:async()=>{},
  }
}
let scheduler=new FlowScheduler(async()=>ws,factory,5,100)
const settle=async()=>{const end=Date.now()+8000;while(scheduler.busy&&Date.now()<end)await pause(5);assert.equal(scheduler.busy,false,'All queues finished or paused without deadlocking shared capacity')}
try{
  await Promise.all(projects.map(p=>scheduler.startPosts(p.id)))
  await assert.rejects(()=>scheduler.startPosts(projects[0].id),/active/)
  await settle()
  assert.equal(submitted.length,6);assert.ok(maxSubmitted>=3)
  const firstDownload=events.findIndex(e=>e.action==='download')
  assert.equal(new Set(events.slice(0,firstDownload).filter(e=>e.action==='submit').map(e=>e.projectId)).size,3,'All three projects can generate before the first result is imported')
  const resultFolders=[]
  for(const [index,p] of projects.entries()){
    const attempts=await ws.generations.list(p.id);assert.equal(attempts.filter(a=>a.state==='ready-for-review').length,2)
    const resultFolder=await ws.generations.folder(p.id);resultFolders.push(resultFolder);assert.equal((await readdir(resultFolder)).length,2)
    for(const attempt of attempts){const data=await sharp(await ws.attemptFile(attempt.id)).raw().toBuffer();assert.deepEqual([...data.subarray(0,3)],[...await sharp(sources.get(p.id)).raw().toBuffer()].slice(0,3),`Project ${index} must display its own pixels`)}
  }
  assert.equal(new Set(resultFolders).size,3,'Same project names do not merge output folders')
  const firstJob=ws.flow.latest(projects[0].id),secondJob=ws.flow.latest(projects[1].id)
  assert.throws(()=>ws.flow.saveJob({...secondJob,resultIds:firstJob.resultIds}),/ambiguous/)
  assert.throws(()=>ws.flow.saveJob({...firstJob,projectId:projects[1].id}),/ownership/)
  assert.throws(()=>ws.flow.saveProject({...ws.flow.project(projects[1].id),url:ws.flow.project(projects[0].id).url}),/another software project/)

  // Ambiguous submit in A must not block accepted B work or trigger another A click.
  uncertainProject=projects[0].id
  await Promise.all(projects.slice(0,2).map(p=>scheduler.start(p.id,'post',1)));await settle()
  const before=submitted.length
  uncertainProject='';await scheduler.collectPending()
  assert.equal(submitted.length,before)
  assert.equal(ws.flow.latest(projects[0].id).stage,'complete')
  assert.equal(ws.flow.latest(projects[1].id).stage,'complete')

  // Closing/reopening the app collects only already submitted requests.
  stall=true;await Promise.all(projects.slice(0,2).map(p=>scheduler.start(p.id,'post',1)));await settle()
  const beforeRestart=submitted.length
  await scheduler.close();await ws.close();ws=await Workspace.open(folder);stall=false
  scheduler=new FlowScheduler(async()=>ws,factory,5,100)
  await pause(25);await scheduler.collectPending()
  assert.equal(submitted.length,beforeRestart)
  assert.equal(ws.flow.latest(projects[0].id).stage,'complete');assert.equal(ws.flow.latest(projects[1].id).stage,'complete')

  // Reel and Post queues use the same isolation/capacity rules. A pending clip
  // must neither import a Post image nor block another project's completed Post.
  const sceneId=randomUUID()
  const reelTheme=await ws.themes.save({name:'Reel theme',description:'',coverAssetId:null,referenceAssetIds:[],masterPrompt:'Reel product',outputType:'reel',aspectRatio:'9:16',defaultDuration:8,compositionPrompt:'',scenes:[{id:sceneId,name:'Scene',prompt:'Show this product',duration:8,relationship:'new-shot',transition:'cut'}]})
  const reel=await ws.projects.save({name:'Same name',productId:projects[2].productId,themeId:reelTheme.id,characterId:null,outputType:'reel',preset:'reel-vertical',duration:8})
  projects.push(reel)
  await Promise.all([scheduler.start(reel.id,sceneId,1),scheduler.start(projects[2].id,'post',1)]);await settle()
  assert.equal(ws.flow.latest(reel.id).submissionAcknowledged,true)
  assert.equal(ws.generations.get(ws.flow.latest(reel.id).attemptId).state,'submission-uncertain')
  assert.equal(ws.flow.latest(projects[2].id).stage,'complete')
  assert.equal((await ws.generations.list(reel.id)).some(a=>a.state==='ready-for-review'),false,'A Post result cannot enter a Reel project')
  await ws.generations.setState(ws.flow.latest(reel.id).attemptId,'failed')

  // Deleting A during prepare cannot click Generate for it or disconnect B.
  deleteDuringPrepare=projects[0].id
  const countA=submitted.filter(x=>x.projectId===projects[0].id).length,countB=submitted.filter(x=>x.projectId===projects[1].id).length
  await Promise.all(projects.slice(0,2).map(p=>scheduler.start(p.id,'post',1)));await settle()
  assert.equal(submitted.filter(x=>x.projectId===projects[0].id).length,countA)
  assert.equal(submitted.filter(x=>x.projectId===projects[1].id).length,countB+1)
  assert.equal(ws.flow.latest(projects[1].id).stage,'complete')
  assert.ok((await readFile(await ws.attemptFile(secondJob.attemptId))).length)
  console.log('PASS 3 same-name projects: separate photos/prompts/results/folders, overlapping remote work, concurrent project browser lanes and serialized native submit, no global project cap, duplicate start/URL/result ownership rejection, uncertainty isolation, restart collection without resubmit, Post/Reel separation, delete A leaves B running.')
}finally{await scheduler.close();await ws.close()}
