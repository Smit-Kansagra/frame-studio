// Real CPU inference on isolated copies. Never opens Flow or the live workspace.
import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,stat} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import {LogoQueue} from '../dist-electron/media/logo-queue.cjs'
import {busyBackgroundLogo} from '../dist-electron/media/gemini-logo.cjs'
import {inpaintLogo,validateRepairArea,selectedRepairRegion} from '../dist-electron/media/logo-inpaint.cjs'
import {Workspace} from '../dist-electron/storage/workspace.cjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-inpaint-'))
for(const area of [null,{x:0,y:0,width:1,height:1},{x:NaN,y:0,width:.1,height:.1},{x:.95,y:.9,width:.1,height:.1},{x:0,y:0,width:.1,height:.1,extra:1}])assert.throws(()=>validateRepairArea(area))
const width=640,height=800,original=Buffer.alloc(width*height*4)
for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=(y*width+x)*4;original[at]=60+Math.round(30*x/width);original[at+1]=100+Math.round(30*y/height);original[at+2]=140;original[at+3]=255}
assert.equal(await busyBackgroundLogo(original,width,height),undefined,'Unmarked gradient must not trigger corner repair')
const area={x:.15,y:.2,width:.06,height:.05},region=selectedRepairRegion(area,width,height),marked=Buffer.from(original)
for(let y=region.top;y<region.top+region.height;y++)for(let x=region.left;x<region.left+region.width;x++){const at=(y*width+x)*4;marked[at]=marked[at+1]=marked[at+2]=255}
const start=Date.now(),fixed=await inpaintLogo(marked,width,height,region)
let changed=0
for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=(y*width+x)*4,inside=x>=region.left-3&&x<region.left+region.width+3&&y>=region.top-3&&y<region.top+region.height+3;for(let c=0;c<4;c++){if(!inside||c===3)assert.equal(fixed[at+c],marked[at+c]);else if(fixed[at+c]!==marked[at+c])changed++}}
assert.ok(changed>region.width*region.height,'Repair must replace the marked pixels')
const source=path.join(root,'source.png');await sharp(marked,{raw:{width,height,channels:4}}).png().toFile(source)
const ws=await Workspace.open(path.join(root,'workspace'))
try{
 const asset=await ws.importImage(source),product=await ws.products.save({name:'Repair',description:'',notes:'',assetIds:[asset.id],primaryAssetId:asset.id}),theme=await ws.themes.save({name:'Repair theme',description:'',coverAssetId:null,referenceAssetIds:[],masterPrompt:'Product',outputType:'post',aspectRatio:'4:5',defaultDuration:0,compositionPrompt:'One image',scenes:[]}),project=await ws.projects.save({name:'Manual repair',productId:product.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-portrait',duration:0})
 const attempt=await ws.generations.prepare(project.id,'post');await ws.generations.setState(attempt.id,'submission-uncertain');await ws.generations.importResult(attempt.id,source);await ws.generations.review(project.id,'post',attempt.id,'approved','');await ws.generations.reviewLogo(attempt.id,'approved')
 const file=(await ws.generations.resultFile(attempt.id)).path,before=await readFile(file)
 await assert.rejects(()=>ws.generations.retryLogo(attempt.id,{x:0,y:0,width:1,height:1}),/small logo/)
 assert.equal((await ws.generations.logoReviews(project.id))[0].status,'approved','Invalid selection cannot change approval')
 assert.deepEqual(await readFile(file),before)
 const result=await ws.generations.retryLogo(attempt.id,area)
 assert.equal(result.cleanup,'removed');assert.equal(result.cleanupVersion,4);assert.equal(result.status,'pending');assert.equal(result.percent,100)
 assert.equal((await ws.generations.resultFile(attempt.id)).path,file);assert.equal((await readdir(path.dirname(file))).length,1)
 assert.deepEqual(await readFile(source),before,'External source is unchanged')
 assert.notDeepEqual(await readFile(file),before)
 assert.equal((await ws.generations.reviews(project.id))[0].status,'approved','Creative approval stays independent')
 const meta=await sharp(file).metadata();assert.equal(meta.width,width);assert.equal(meta.height,height)
}finally{await ws.close()}

// Optional fresh read-only sample copies supplied by the investigator.
const copies=process.argv[2]
if(copies){
 const pool=new LogoQueue(3)
 await Promise.all(Array.from({length:5},async(_,i)=>{
  const source=path.join(copies,`input-${i}.png`),target=path.join(root,`sample-${i}.png`),before=await readFile(source),raw=await sharp(before).ensureAlpha().raw().toBuffer({resolveWithObject:true}),candidate=await busyBackgroundLogo(raw.data,raw.info.width,raw.info.height)
  assert.ok(candidate,`Sample ${i} must locate the busy-background logo`)
  const begin=Date.now(),r=await pool.run(`sample-${i}`,{source,target,retry:true});assert.equal(r.removed,true)
  const output=await sharp(target).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(output.info.width,raw.info.width);assert.equal(output.info.height,raw.info.height)
  const {left,top,size}=candidate.region
  for(let y=0;y<raw.info.height;y++)for(let x=0;x<raw.info.width;x++){if(x>=left-3&&x<left+size+3&&y>=top-3&&y<top+size+3)continue;const at=(y*raw.info.width+x)*4;for(let c=0;c<4;c++)assert.equal(output.data[at+c],raw.data[at+c],`Sample ${i}: outside pixels unchanged`)}
  assert.equal(await busyBackgroundLogo(output.data,output.info.width,output.info.height),undefined,`Sample ${i}: no repeat logo detection`)
  const repeat=path.join(root,`repeat-${i}.png`);assert.equal((await pool.run(`repeat-${i}`,{source:target,target:repeat,retry:true})).removed,false)
  await assert.rejects(()=>stat(repeat),{code:'ENOENT'});assert.deepEqual(await readFile(source),before)
  console.log(`Sample ${i+1}: repaired, unchanged outside logo, clean retry skipped (${Date.now()-begin}ms including queue)`)
 }))
}
console.log(`PASS local CPU model (${Date.now()-start}ms total), bounded selection validation, exact pixels outside repair, unchanged dimensions, same managed file, approval reset, original preserved. Outputs: ${root}`)
