import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,readdir,lstat} from 'node:fs/promises'
import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import {Workspace} from '../dist-electron/storage/workspace.cjs'
import {geminiMasks} from '../dist-electron/media/gemini-masks.cjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-logo-export-')),folder=path.join(root,'workspace')
let ws=await Workspace.open(folder)
const width=1080,raw=Buffer.alloc(width*width*3)
for(let y=0;y<width;y++)for(let x=0;x<width;x++){const i=(y*width+x)*3;raw[i]=60+Math.round(x/width*30);raw[i+1]=100;raw[i+2]=140}
const {data,info}=await sharp(Buffer.from(geminiMasks.bg_48_png,'base64')).raw().toBuffer({resolveWithObject:true})
for(let y=0;y<48;y++)for(let x=0;x<48;x++){const a=Math.max(...data.subarray((y*48+x)*info.channels,(y*48+x)*info.channels+3))/255,at=((width-80+y)*width+width-80+x)*3;for(let c=0;c<3;c++)raw[at+c]=Math.round(raw[at+c]*(1-a)+255*a)}
const source=path.join(root,'original.png');await sharp(raw,{raw:{width,height:width,channels:3}}).png().toFile(source)
try{
 const a=await ws.importImage(source),b=await ws.importImage(source),product=await ws.products.save({name:'Two products',description:'',notes:'',assetIds:[a.id,b.id],primaryAssetId:a.id}),theme=await ws.themes.save({name:'Theme',description:'',coverAssetId:null,referenceAssetIds:[],masterPrompt:'Style product',outputType:'post',aspectRatio:'1:1',defaultDuration:0,compositionPrompt:'One photo',scenes:[]})
 // Image import deduplicates equal files, so create a distinct second product asset.
 let second=b
 if(a.id===b.id){const other=path.join(root,'other.png');await sharp({create:{width:1080,height:1080,channels:3,background:'#467889'}}).png().toFile(other);second=await ws.importImage(other);await ws.products.save({...product,expectedRevision:product.revision,assetIds:[a.id,second.id]})}
 const project=await ws.projects.save({name:'Batch images',productId:product.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-square',duration:0})
 const make=async(sceneId)=>{const item=await ws.generations.prepare(project.id,sceneId);await ws.generations.setState(item.id,'submission-uncertain');const result=await ws.generations.importResult(item.id,source);await ws.generations.review(project.id,sceneId,item.id,'approved','');return result}
 const first=await make('post'),next=await make(second.id),managed=await ws.generations.resultFile(first.id),finalFolder=path.dirname(managed.path)
 assert.equal((await ws.generations.logoReviews(project.id))[0].status,'pending')
 await assert.rejects(()=>ws.exports.startPostBatch(project.id,root,()=>{}),/Approve/)
 await assert.rejects(()=>ws.exports.start(project.id,{order:[],trims:[],fit:'crop',muteAll:false},path.join(root,'Image 1.png'),()=>{}),/Clips/)
 const cleaned=await ws.generations.retryLogo(first.id)
 assert.equal(cleaned.cleanup,'removed');assert.equal(cleaned.status,'pending');assert.equal((await ws.generations.resultFile(first.id)).path,managed.path)
 assert.equal((await readdir(finalFolder)).length,2,'Retry edits the same final file without another copy')
 const bytes=await readFile(managed.path);assert.notDeepEqual(bytes,await readFile(source));assert.equal((await sharp(bytes).metadata()).width,1080)
 assert.equal((await ws.generations.reviews(project.id)).find(r=>r.sceneId==='post').status,'approved','Logo review is separate from creative approval')
 await ws.generations.reviewLogo(first.id,'approved');await ws.generations.reviewLogo(next.id,'approved')
 await ws.close();ws=await Workspace.open(folder)
 assert.equal((await ws.generations.logoReviews(project.id)).filter(r=>r.status==='approved').length,2,'Approvals survive restart')
 const batch=await ws.exports.startPostBatch(project.id,root,()=>{})
 assert.deepEqual(await readdir(batch.folder),['Image 1.png','Image 2.png']);assert.equal(batch.files.length,2)
 for(const [index,file] of batch.files.entries()){assert.equal(path.basename(file.path),`Image ${index+1}.png`);assert.equal(file.sourceAttemptIds[0],[first.id,next.id][index]);assert.deepEqual(await readFile(file.path),await readFile((await ws.generations.resultFile([first.id,next.id][index])).path))}
 const repeated=await ws.exports.startPostBatch(project.id,root,()=>{});assert.notEqual(repeated.folder,batch.folder);assert.deepEqual(await readdir(repeated.folder),['Image 1.png','Image 2.png'])
 const before=await readdir(root)
 await assert.rejects(()=>ws.exports.startPostBatch(project.id,root,()=>{void ws.exports.cancel(project.id)}),/cancelled|stopped/i)
 assert.deepEqual(await readdir(root),before,'Cancelled batch removes only its new partial folder/files')
 let changed=false
 await assert.rejects(()=>ws.exports.startPostBatch(project.id,root,p=>{if(p.percent===50&&!changed){changed=true;void ws.generations.reviewLogo(first.id,'needs-changes')}}),/approval changed/)
 assert.deepEqual(await readdir(root),before,'Changed approvals roll back the whole batch')
 const secondOnly=await ws.exports.startPostBatch(project.id,root,()=>{});assert.equal(secondOnly.files.length,1);assert.equal(secondOnly.files[0].sourceAttemptIds[0],next.id);assert.equal(path.basename(secondOnly.files[0].path),'Image 1.png')
 const again=await ws.generations.retryLogo(first.id);assert.equal(again.status,'pending');assert.equal(again.cleanup,'not-detected');assert.deepEqual(await readFile(managed.path),bytes,'Already-clean PNG is not rewritten on retry')
 assert.equal((await readdir(finalFolder)).length,2)
 await ws.close();const db=new DatabaseSync(path.join(folder,'workspace.sqlite'));db.exec('DROP TABLE logo_reviews; DELETE FROM schema_migrations WHERE version>=17; PRAGMA user_version=16');db.close();ws=await Workspace.open(folder)
 assert.equal((await ws.status()).schemaVersion,18);assert.equal((await ws.generations.logoReviews(project.id)).length,2);assert.deepEqual(await readFile(managed.path),bytes,'Upgrade preserves saved files')
 await ws.generations.reviewLogo(first.id,'approved');const trash=await ws.projects.trash(project.id,project.revision);assert.equal((await ws.projects.deletePermanently(project.id,trash.revision)).cleanupWarnings,0)
 await assert.rejects(()=>lstat(managed.path),{code:'ENOENT'});assert.ok(await lstat(batch.files[0].path),'User exports are preserved when local project is deleted')
 console.log('PASS logo retry in the same file, separate durable approval, repeat cleanup idempotence, bulk export gates/numbering/product order/exact PNG bytes, unique repeat folders, cancellation and changed-approval rollback, schema16 migration and permanent deletion.')
}finally{await ws.close()}
