// Isolated comment + selected-generated-image edit workflow. No live Flow credits.
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,lstat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { Workspace } from '../dist-electron/storage/workspace.cjs'
import { FlowScheduler } from '../dist-electron/flow-scheduler.cjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-review-edit-')),folder=path.join(root,'workspace')
let ws=await Workspace.open(folder)
const assets=[]
for(let i=0;i<4;i++){const file=path.join(root,`${i}.png`);await writeFile(file,await sharp({create:{width:40,height:50,channels:3,background:{r:20+i*40,g:70,b:90}}}).png().toBuffer());assets.push(await ws.importImage(file))}
const product=await ws.products.save({name:'Products',description:'',notes:'',assetIds:assets.slice(0,2).map(a=>a.id),primaryAssetId:assets[0].id})
const theme=await ws.themes.save({name:'Theme',description:'',coverAssetId:null,referenceAssetIds:[assets[2].id],masterPrompt:'Keep this exact product.',outputType:'post',aspectRatio:'4:5',defaultDuration:0,compositionPrompt:'One product photograph.',scenes:[]})
const character=await ws.characters.save({name:'Character',category:null,assetIds:[assets[3].id],primaryAssetId:assets[3].id})
const project=await ws.projects.save({name:'Edit my image',productId:product.id,themeId:theme.id,characterId:character.id,outputType:'post',preset:'post-portrait',duration:0})
const saveImage=async sceneId=>{const a=await ws.generations.prepare(project.id,sceneId);await ws.generations.setState(a.id,'submission-uncertain');return ws.generations.importResult(a.id,path.join(root,'0.png'))}
const first=await saveImage('post'),second=await saveImage(assets[1].id),newer=await saveImage('post')
await ws.generations.review(project.id,assets[1].id,second.id,'approved','Keep other product')
const comment='isme ladki ke left hend me ek blue puece add kardo'
await ws.generations.review(project.id,'post',first.id,'needs-changes',comment)
const snapshot=await ws.generations.prepareAutomatic(project.id,'post')
assert.deepEqual(snapshot.revision,{sourceAttemptId:first.id,note:comment})
assert.notEqual(snapshot.revision.sourceAttemptId,newer.id,'Edit the selected version, not the latest image')
assert.equal(await ws.generations.revisionFile(snapshot.id),(await ws.generations.resultFile(first.id)).path)
await ws.generations.review(project.id,'post',newer.id,'needs-changes','Different later comment')
await ws.close();ws=await Workspace.open(folder)
assert.deepEqual(ws.generations.get(snapshot.id).revision,{sourceAttemptId:first.id,note:comment},'Queued edit keeps its exact image/comment snapshot across restart and later review changes')
await ws.generations.setState(snapshot.id,'failed')
await ws.generations.review(project.id,'post',first.id,'needs-changes',comment)
let submits=0,expectedSource=first.id,expectedNote=comment
const driver={
  async createProject(commit){const url='https://flow.google.com/project/edit-image';await commit(url);return url},
  async nameProject(){},
  async prepare(_url,request){
    assert.equal(request.revision.sourceAttemptId,expectedSource)
    assert.equal(request.revision.note,expectedNote)
    assert.ok(request.prompt.includes(expectedNote));assert.ok(request.prompt.includes(expectedSource));assert.match(request.prompt,/LAST attached image/)
    assert.deepEqual(request.references,[assets[0].id,assets[2].id,assets[3].id])
    assert.equal(request.files.length,4,'Product + theme + character + selected generated image')
    assert.equal(request.files.at(-1),(await ws.generations.resultFile(expectedSource)).path)
    assert.match(request.referenceLabels.at(-1),/Image to edit/)
    return []
  },
  async submit(){submits++},async results(){return[{id:`edit-${submits}`,selector:'#edited'}]},async download(){return path.join(root,'1.png')},
}
const runner=new FlowScheduler(async()=>ws,()=>driver,5,1000)
const settle=async()=>{const end=Date.now()+4000;while(runner.busy&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(runner.busy,false)}
try{
  const edit=await runner.start(project.id,'post',1);await settle()
  assert.equal(submits,1);assert.equal(ws.generations.get(edit.attemptId).state,'ready-for-review')
  let review=(await ws.generations.reviews(project.id)).find(r=>r.sceneId==='post')
  assert.equal(review.selectedAttemptId,edit.attemptId);assert.equal(review.status,'pending');assert.equal(review.note,'')
  assert.equal(ws.generations.get(edit.attemptId).revision.note,comment,'Applied comment stays in version history')
  assert.ok(await lstat((await ws.generations.resultFile(first.id)).path),'Original selected image is kept')
  assert.equal((await ws.generations.reviews(project.id)).find(r=>r.sceneId===assets[1].id).selectedAttemptId,second.id)
  assert.equal((await ws.generations.reviews(project.id)).find(r=>r.sceneId===assets[1].id).status,'approved')

  expectedSource=edit.attemptId;expectedNote='Keep the blue purse; make its strap shorter.'
  await ws.generations.review(project.id,'post',expectedSource,'needs-changes',expectedNote)
  const next=await runner.start(project.id,'post',1);await settle()
  assert.equal(submits,2);assert.equal(ws.generations.get(next.attemptId).revision.sourceAttemptId,edit.attemptId,'Further changes edit the revised image')
  await ws.generations.review(project.id,'post',next.attemptId,'approved','Looks good')
  const normal=await ws.generations.prepareAutomatic(project.id,'post');assert.equal(normal.revision,undefined,'Approval notes are not edit instructions');await ws.generations.setState(normal.id,'failed')
  await ws.generations.review(project.id,'post',next.attemptId,'needs-changes','  ')
  const blank=await ws.generations.prepareAutomatic(project.id,'post');assert.equal(blank.revision,undefined);await ws.generations.setState(blank.id,'failed')
  await assert.rejects(()=>ws.generations.review(project.id,'post',second.id,'needs-changes','Wrong product'),/for this scene/)
  console.log('PASS selected image + exact comment reach Flow, original references keep roles, snapshots survive restart/later review edits, new image opens pending review, original/other approvals preserved, iterative edits use revised image, approval/blank notes excluded and wrong-product reference rejected.')
}finally{await runner.close();await ws.close()}
