// Isolated result recovery and single-copy output checks. No live Flow/account.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readdir, lstat, link } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'
import { FlowCoordinator } from '../dist-electron/flow-coordinator.cjs'
import { StorageError } from '../dist-electron/storage/errors.cjs'
import { validResultPath } from '../dist-electron/storage/result-paths.cjs'

const root=await mkdtemp(path.join(os.tmpdir(),'frame-auto-results-')),folder=path.join(root,'workspace')
let ws=await Workspace.open(folder)
const source=path.join(root,'product.png'),bytes=await sharp({create:{width:32,height:48,channels:3,background:'#37925f'}}).png().toBuffer()
await writeFile(source,bytes)
const asset=await ws.importImage(source)
const product=await ws.products.save({name:'Product',description:'',notes:'',assetIds:[asset.id],primaryAssetId:asset.id})
const theme=await ws.themes.save({name:'Theme',description:'',coverAssetId:null,referenceAssetIds:[],masterPrompt:'Style this product.',outputType:'post',aspectRatio:'4:5',defaultDuration:0,compositionPrompt:'One product.',scenes:[]})
const project=await ws.projects.save({name:'Project 2 : / Test',productId:product.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-portrait',duration:0})
let submits=0,downloads=0,disconnect=false,delayResults=false
const driver={
  async createProject(commit){const url='https://flow.google.com/project/auto-results';await commit(url);return url},
  async nameProject(){},async prepare(){return []},async submit(){submits++},
  async results(){if(disconnect)throw new StorageError('INVALID_REQUEST','Companion connection ended.');return delayResults?[]:[{id:`result-${submits}`,selector:'#result'}]},
  async download(_url,_result,directory){downloads++;const file=path.join(directory,'original.png');await writeFile(file,bytes);return file},
}
const settle=async runner=>{const end=Date.now()+4000;while(runner.busy&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(runner.busy,false)}
let runner=new FlowCoordinator(async()=>ws,driver,5,100)
try{
  const job=await runner.startPosts(project.id);await settle(runner)
  const first=ws.generations.get(job.attemptId),finalFolder=await ws.generations.folder(project.id)
  assert.match(finalFolder,/Final Projects/);assert.ok(path.basename(finalFolder).startsWith('Project 2 - - Test--'))
  assert.equal(first.state,'ready-for-review');assert.equal((await ws.generations.resultFile(first.id)).path,path.join(finalFolder,`${first.id}.png`))
  assert.deepEqual(await readdir(finalFolder),[`${first.id}.png`])
  await assert.rejects(()=>lstat(ws.paths.resolve(`temp/flow/${first.id}`)),{code:'ENOENT'})
  await ws.generations.review(project.id,'post',first.id,'approved','Keep this')

  // Simulate a temporary disconnect just after submission. Only the main-process
  // automatic collection entry point is used after reconnection, never Resume.
  disconnect=true
  const interrupted=await runner.start(project.id,'post',1);await settle(runner)
  assert.equal(ws.generations.get(interrupted.attemptId).state,'submission-uncertain')
  assert.equal(ws.flow.job(interrupted.attemptId).collectionStopped,false)
  await ws.close();ws=await Workspace.open(folder);disconnect=false
  runner=new FlowCoordinator(async()=>ws,driver,5,100)
  await new Promise(resolve=>setTimeout(resolve,25));await runner.collectPending()
  assert.equal(ws.generations.get(interrupted.attemptId).state,'ready-for-review')
  assert.equal(submits,2);assert.equal(downloads,2,'Reconnection only collects, with no repeated Generate')
  assert.equal((await readdir(finalFolder)).length,2,'One final file per version, without original/normalized duplicates')
  assert.equal((await ws.generations.reviews(project.id))[0].selectedAttemptId,first.id)
  assert.ok(await lstat(source),'User-provided source stays untouched')

  // A safety/association failure is visible and is not retried automatically.
  driver.results=async()=>[{id:'unsafe-1',selector:'#a'},{id:'unsafe-2',selector:'#b'}]
  const unsafe=await runner.start(project.id,'post',1);await settle(runner)
  assert.equal(ws.flow.job(unsafe.attemptId).collectionStopped,true)
  const before=downloads;await runner.collectPending();assert.equal(downloads,before)
  await ws.generations.setState(unsafe.attemptId,'failed')

  // Upgrade fixture: move the stored result back to the old layout. Reopening
  // organizes it without changing attempt/approval IDs or keeping a duplicate.
  const stored=ws.generations.get(first.id),legacy=`projects/attempts/${first.id}.png`
  await link(ws.paths.resolve(stored.resultPath),ws.paths.resolve(legacy))
  await ws.close()
  const db=new DatabaseSync(path.join(folder,'workspace.sqlite'));db.prepare('UPDATE generation_attempts SET result_path=? WHERE id=?').run(legacy,first.id);db.close()
  ws=await Workspace.open(folder)
  assert.equal(ws.generations.get(first.id).resultPath,stored.resultPath)
  await assert.rejects(()=>lstat(ws.paths.resolve(legacy)),{code:'ENOENT'})
  assert.equal((await ws.generations.reviews(project.id))[0].selectedAttemptId,first.id)
  assert.equal(validResultPath(project.id,first.id,`Final Projects/other--${product.id}/${first.id}.png`),false)
  await ws.generations.reviewLogo(first.id,'approved')
  const exported=await ws.exports.start(project.id,{order:[],trims:[],fit:'crop',muteAll:false},path.join(root,'approved.png'),()=>{})
  assert.deepEqual(exported.sourceAttemptIds,[first.id])
  const trash=await ws.projects.trash(project.id,project.revision)
  assert.equal((await ws.projects.deletePermanently(project.id,trash.revision)).cleanupWarnings,0)
  assert.equal((await readdir(finalFolder)).length,0)
  assert.ok(await lstat(source))
  console.log('PASS auto collection after disconnect/restart without Resume or resubmission; one project file per version; temporary originals removed; legacy migration preserves approvals/export; unsafe association stops; permanent deletion removes only owned results.')
}finally{await ws.close()}
