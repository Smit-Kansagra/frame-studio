// Isolated lossless visible-logo restoration, before resize. No user files change.
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,readdir,lstat} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import {geminiMasks} from '../dist-electron/media/gemini-masks.cjs'
import {cleanGeminiLogo} from '../dist-electron/media/gemini-logo.cjs'
import {Workspace} from '../dist-electron/storage/workspace.cjs'
import {FlowCoordinator} from '../dist-electron/flow-coordinator.cjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-logo-'))
const fixture=async({width=1024,height=1024,mask='bg_48_png',size=48,margin=32,jpeg=false,marked=true}={})=>{
 const raw=Buffer.alloc(width*height*4)
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;raw[i]=60+Math.round(x/width*55);raw[i+1]=90+Math.round(y/height*35);raw[i+2]=135+Math.round(x/width*20);raw[i+3]=255}
 const original=Buffer.from(raw)
 if(marked){const {data,info}=await sharp(Buffer.from(geminiMasks[mask],'base64')).resize(size,size).removeAlpha().raw().toBuffer({resolveWithObject:true});for(let y=0;y<size;y++)for(let x=0;x<size;x++){const at=((height-size-margin+y)*width+width-size-margin+x)*4,j=(y*size+x)*info.channels,a=Math.max(data[j],data[j+1],data[j+2])/255;for(let c=0;c<3;c++)raw[at+c]=Math.round(raw[at+c]*(1-a)+255*a)}}
 let image=sharp(raw,{raw:{width,height,channels:4}})
 return {bytes:await(jpeg?image.jpeg({quality:95}):image.png()).toBuffer(),original,raw,width,height,size,margin}
}
for(const options of [{},{jpeg:true},{width:1536,height:1536,mask:'bg_96_png',size:96,margin:64},{width:1024,height:1024,mask:'bg_b_36_png',size:36,margin:71},{width:1536,height:1536,mask:'bg_b_96_png',size:96,margin:192},{width:1376,height:768,mask:'bg_b_96_png',size:48,margin:96}]){
 const f=await fixture(options),r=await cleanGeminiLogo(f.bytes)
 assert.equal(r.removed,true,JSON.stringify(options));assert.equal(r.width,f.width);assert.equal(r.height,f.height)
 const decoded=await sharp(f.bytes).ensureAlpha().raw().toBuffer()
 let outside=0,error=0,inside=0
 for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++){const at=(y*f.width+x)*4;const isInside=x>=r.region.left&&x<r.region.left+r.region.size&&y>=r.region.top&&y<r.region.top+r.region.size;for(let c=0;c<4;c++){if(!isInside&&r.data[at+c]!==decoded[at+c])outside++;if(isInside&&c<3){error+=Math.abs(r.data[at+c]-f.original[at+c]);inside++}}}
 assert.equal(outside,0,'Only the detected logo pixels can change; no global blur or resize')
 assert.ok(error/inside<(options.jpeg?4:2),`Restoration error ${error/inside}`)
 const cleaned=await sharp(r.data,{raw:{width:r.width,height:r.height,channels:4}}).png().toBuffer()
 assert.equal((await cleanGeminiLogo(cleaned)).removed,false,'Already-clean images are not processed twice')
}
for(const width of [64,1024,1536]){const f=await fixture({width,height:width,marked:false}),r=await cleanGeminiLogo(f.bytes);assert.equal(r.removed,false);assert.deepEqual(r.data,f.raw)}
// Already-generated real image copy remains unchanged when no known logo is found.
try{await lstat('.verification/logo-real-input.png');const r=await cleanGeminiLogo('.verification/logo-real-input.png');if(!r.removed)assert.deepEqual(r.data,await sharp('.verification/logo-real-input.png').rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer())}catch(e){if(e.code!=='ENOENT')throw e}
const scaledFixture=await fixture({width:768,height:1024,mask:'bg_b_36_png',size:42,margin:64}),scaledInput=await sharp(scaledFixture.bytes).resize(1080,1440).png().toBuffer(),scaledResult=await cleanGeminiLogo(scaledInput)
assert.equal(scaledResult.removed,true,'A known logo rescaled by an older theme-normalization pass is detected')
const scaledClean=await sharp(scaledResult.data,{raw:{width:1080,height:1440,channels:4}}).png().toBuffer()
assert.equal((await cleanGeminiLogo(scaledClean)).removed,false,'Scaled-logo cleanup is idempotent')

const f=await fixture(),source=path.join(root,'flow-original.png');await writeFile(source,f.bytes)
const ws=await Workspace.open(path.join(root,'workspace'))
let runner
try{
 const asset=await ws.importImage(source),p=await ws.products.save({name:'Product',description:'',notes:'',assetIds:[asset.id],primaryAssetId:asset.id}),theme=await ws.themes.save({name:'Theme',description:'',coverAssetId:null,referenceAssetIds:[],masterPrompt:'Style product',outputType:'post',aspectRatio:'1:1',defaultDuration:0,compositionPrompt:'One image',scenes:[]}),project=await ws.projects.save({name:'Single copy',productId:p.id,themeId:theme.id,characterId:null,outputType:'post',preset:'post-square',duration:0})
 let submits=0,prepared
 runner=new FlowCoordinator(async()=>ws,{async createProject(commit){const u='https://flow.google.com/project/logo';await commit(u);return u},async nameProject(){},async prepare(_url,r){prepared=r;return[]},async submit(){submits++},async results(){return[{id:`result-${submits}`,selector:'#result'}]},async download(_url,_result,directory){const file=path.join(directory,'original.png');await writeFile(file,f.bytes);return file}},5,1000)
 const settle=async()=>{const end=Date.now()+5000;while(runner.busy&&Date.now()<end)await new Promise(r=>setTimeout(r,5));assert.equal(runner.busy,false)}
 const first=await runner.startPosts(project.id);await settle();assert.equal(ws.generations.get(first.attemptId).state,'ready-for-review')
 const final=await ws.generations.resultFile(first.attemptId),folder=await ws.generations.folder(project.id)
 assert.deepEqual(await readdir(folder),[`${first.attemptId}.png`]);assert.equal((await sharp(final.path).metadata()).width,1080)
 const corner=await sharp(final.path).extract({left:1000,top:1000,width:20,height:20}).removeAlpha().raw().toBuffer();assert.ok(Math.max(...corner)<230,'The white logo is removed before theme resizing')
 await assert.rejects(()=>lstat(ws.paths.resolve(`temp/flow/${first.attemptId}`)),{code:'ENOENT'})
 await ws.generations.review(project.id,'post',first.attemptId,'needs-changes','Make the background blue')
 const edited=await runner.start(project.id,'post',1);await settle()
 assert.equal(prepared.files.at(-1),final.path,'Need changes uses the same cleaned final image, without an edit-reference copy')
 assert.equal(ws.generations.get(edited.attemptId).state,'ready-for-review');assert.equal((await readdir(folder)).length,2,'Exactly one file per generated version; no raw/cleaned duplicate')
 assert.equal((await ws.generations.reviews(project.id))[0].selectedAttemptId,edited.attemptId)
 await assert.rejects(()=>lstat(ws.paths.resolve(`temp/flow/${edited.attemptId}`)),{code:'ENOENT'})
 assert.deepEqual(await readFile(source),f.bytes,'An external/manual input is never deleted or edited')
 console.log('PASS visible-logo restoration on legacy/current sizes and JPEG, unchanged outside pixels/dimensions, clean-image skip and idempotence; automatic generation/edit share one project folder and one cleaned file per version; staging removed; original manual files preserved.')
}finally{await runner?.close();await ws.close()}
