import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import {Workspace} from '../dist-electron/storage/workspace.cjs'
import {postPhotos} from '../dist-electron/storage/post-plan.mjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-bulk-approval-')),ws=await Workspace.open(path.join(root,'workspace'))
try{
 const assets=[]
 for(let n=0;n<6;n++){const file=path.join(root,`${n}.png`);await sharp({create:{width:40,height:50,channels:3,background:{r:40+n*25,g:90,b:140}}}).png().toFile(file);assets.push(await ws.importImage(file))}
 const product=await ws.products.save({name:'Six products',description:'',notes:'',assetIds:assets.map(a=>a.id),primaryAssetId:assets[0].id})
 const theme=await ws.themes.save({name:'Theme',description:'',coverAssetId:null,referenceAssetIds:[],masterPrompt:'Preserve product.',outputType:'post',aspectRatio:'4:5',defaultDuration:0,compositionPrompt:'',scenes:[]})
 const make=name=>ws.projects.save({name,productId:product.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-portrait',duration:0})
 const project=await make('Approve this project'),other=await make('Other project'),photos=postPhotos(project),attempts=[]
 const image=async(projectId,sceneId)=>{const a=await ws.generations.prepareAutomatic(projectId,sceneId);await ws.generations.setState(a.id,'submission-uncertain');await ws.generations.importResult(a.id,path.join(root,'0.png'));return a}
 for(const photo of photos.slice(0,5))attempts.push(await image(project.id,photo.id))
 const foreign=await image(other.id,'post')
 ws.generations.recordLogoCleanup(foreign.id,true)
 for(const n of [0,1,2,4])ws.generations.recordLogoCleanup(attempts[n].id,true)
 ws.generations.beginLogoCleanup(attempts[1].id)
 ws.generations.beginLogoCleanup(attempts[2].id)
 ws.generations.failLogoCleanup(attempts[2].id,'Repair failed')
 attempts.push(await ws.generations.prepareAutomatic(project.id,photos[5].id))
 await assert.rejects(()=>ws.generations.approveAll(project.id,[{attemptId:attempts[0].id,note:''},{attemptId:foreign.id,note:''}]),/this project/)
 assert.equal((await ws.generations.reviews(project.id)).length,0,'Foreign input rejects before any approval')
 await assert.rejects(()=>ws.generations.approveAll(project.id,[{attemptId:attempts[0].id,note:''},{attemptId:attempts[0].id,note:''}]),/different product/)
 const result=await ws.generations.approveAll(project.id,attempts.map((a,index)=>({attemptId:a.id,note:`Product ${index+1} note`})))
 assert.equal(result.approved,2);assert.equal(result.skipped,4)
 assert.deepEqual(result.reviews.map(r=>[r.sceneId,r.note]),[[photos[0].id,'Product 1 note'],[photos[4].id,'Product 5 note']])
 assert.ok(result.logos.every(l=>l.status==='approved'))
 assert.equal((await ws.generations.reviews(other.id)).length,0,'Other project remains unapproved')
 await ws.generations.setState(attempts[5].id,'failed')
 await delay(5)
 const newer=await image(project.id,photos[4].id);ws.generations.recordLogoCleanup(newer.id,true)
 const stale=await ws.generations.approveAll(project.id,[{attemptId:attempts[4].id,note:'stale'}])
 assert.equal(stale.approved,0);assert.equal(stale.skipped,1,'A new image cannot cause approval of a stale review snapshot')
 const current=await ws.generations.approveAll(project.id,[{attemptId:newer.id,note:'Latest image'}]);assert.equal(current.approved,1)
 const active=await ws.generations.prepareAutomatic(project.id,photos[0].id)
 const busy=await ws.generations.approveAll(project.id,[{attemptId:attempts[0].id,note:'While editing'}]);assert.equal(busy.skipped,1)
 await ws.generations.setState(active.id,'failed')
 const failed=await ws.generations.approveAll(project.id,[{attemptId:attempts[0].id,note:'After failed edit'}]);assert.equal(failed.skipped,1)
 console.log('PASS project-scoped bulk approval, exact image versions and notes, creative/logo approval together, unfinished/failed cleanup and active/stale revisions skipped, foreign input rejected before writes.')
}finally{await ws.close()}
