import assert from 'node:assert/strict'
import {mkdtemp,readFile} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import {DatabaseSync} from 'node:sqlite'
import {Workspace} from '../dist-electron/storage/workspace.cjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-clip-approval-')),folder=path.join(root,'workspace'),source=path.join(root,'input.png')
await sharp({create:{width:640,height:800,channels:3,background:'#667788'}}).png().toFile(source)
const ws=await Workspace.open(folder)
try{
 const asset=await ws.importImage(source),product=await ws.products.save({name:'Product',description:'',notes:'',assetIds:[asset.id],primaryAssetId:asset.id}),theme=await ws.themes.save({name:'Theme',description:'',coverAssetId:null,referenceAssetIds:[],masterPrompt:'Product photo',outputType:'post',aspectRatio:'4:5',defaultDuration:0,compositionPrompt:'',scenes:[]}),project=await ws.projects.save({name:'Combined approval',productId:product.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-portrait',duration:0})
 const a=await ws.generations.prepare(project.id,'post');await ws.generations.setState(a.id,'submission-uncertain');await ws.generations.importResult(a.id,source)
 await assert.rejects(()=>ws.generations.approvePost(a.id,''),/cleanup/)
 await ws.generations.retryLogo(a.id);const approved=await ws.generations.approvePost(a.id,'Keep this image')
 assert.equal(approved.review.status,'approved');assert.equal(approved.logo.status,'approved');assert.equal(approved.review.selectedAttemptId,a.id);assert.equal((await ws.exports.inspect(project.id)).canExport,true)
 await ws.generations.review(project.id,'post',a.id,'needs-changes','A new background')
 const db=new DatabaseSync(path.join(folder,'workspace.sqlite'));db.exec("CREATE TRIGGER fail_logo_approval BEFORE UPDATE ON logo_reviews BEGIN SELECT RAISE(ABORT,'forced approval failure'); END;")
 await assert.rejects(()=>ws.generations.approvePost(a.id,'must roll back'),/forced approval/)
 assert.equal((await ws.generations.reviews(project.id))[0].status,'needs-changes');assert.equal((await ws.generations.reviews(project.id))[0].note,'A new background')
 db.exec('DROP TRIGGER fail_logo_approval');db.close()
 ws.generations.beginLogoCleanup(a.id);await assert.rejects(()=>ws.generations.approvePost(a.id,''),/cleanup/);ws.generations.failLogoCleanup(a.id,'Retry local repair')
 const before=await readFile((await ws.generations.resultFile(a.id)).path);await ws.generations.retryLogo(a.id);assert.deepEqual(await readFile((await ws.generations.resultFile(a.id)).path),before);await ws.generations.approvePost(a.id,'')
 const next=await ws.generations.prepareAutomatic(project.id,'post');await assert.rejects(()=>ws.generations.approvePost(a.id,''),/current request/);await ws.generations.setState(next.id,'failed')
 assert.equal((await ws.generations.approvePost(a.id,'')).logo.status,'approved')
 assert.equal((await ws.exports.inspect(project.id)).canExport,true)
 console.log('PASS single Clips approval commits creative and logo approval together; raw/processing images and active edits cannot be approved; failed writes roll back; local repair preserves file ownership; export works without a separate logo tab.')
}finally{await ws.close()}
