// Smoke test the shipped native runtime, ASAR model reads and real worker.
// ELECTRON_RUN_AS_NODE avoids starting the app or opening a workspace.
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import {busyBackgroundLogo} from '../dist-electron/media/gemini-logo.cjs'
const version=JSON.parse(await readFile('package.json','utf8')).version,unpacked=path.resolve('release',version,'win-unpacked'),temp=await mkdtemp(path.join(os.tmpdir(),'frame-packaged-logo-'))
const source=path.join(temp,'source.png'),target=path.join(temp,'repaired.png'),script=path.join(temp,'smoke.cjs')
let width=640,height=800,data=Buffer.alloc(width*height*4),bounds={left:93,top:157,right:131,bottom:203}
if(process.argv[2]){
 const bytes=await readFile(process.argv[2]),raw=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});width=raw.info.width;height=raw.info.height;data=raw.data
 const found=await busyBackgroundLogo(data,width,height);assert.ok(found,'The supplied regression copy contains the boundary logo');const r=found.region;bounds={left:r.left-3,top:r.top-3,right:r.left+r.size+3,bottom:r.top+r.size+3};await writeFile(source,bytes)
}else{
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;data[i]=80;data[i+1]=120;data[i+2]=150;data[i+3]=255;if(x>=96&&x<128&&y>=160&&y<200)data[i]=data[i+1]=data[i+2]=255}
 await sharp(data,{raw:{width,height,channels:4}}).png().toFile(source)
}
await writeFile(script,`const path=require('node:path');const assert=require('node:assert/strict');const archive=process.argv[2];const{LogoQueue}=require(path.join(archive,'dist-electron/media/logo-queue.cjs'));(async()=>{const queue=new LogoQueue(1);const r=await queue.run('packaged-test',{source:process.argv[3],target:process.argv[4],retry:true,area:process.argv[5]==='auto'?undefined:{x:.15,y:.2,width:.05,height:.05}});assert.equal(r.removed,true);await queue.drain();console.log('PACKAGED_NATIVE_REPAIR_OK')})().catch(e=>{console.error(e);process.exitCode=1});`)
const child=spawn(path.join(unpacked,'Frame Studio.exe'),[script,path.join(unpacked,'resources/app.asar'),source,target,process.argv[2]?'auto':'manual'],{windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',ORT_DISABLE_TELEMETRY:'1'},stdio:['ignore','pipe','pipe']})
let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
const timer=setTimeout(()=>child.kill(),60000)
try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});assert.equal(code,0,output);assert.match(output,/PACKAGED_NATIVE_REPAIR_OK/);assert.doesNotMatch(output,/telemetry device|upload telemetry/i)
 const restored=await sharp(target).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(restored.info.width,width);assert.equal(restored.info.height,height);let changed=0
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,inside=x>=bounds.left&&x<bounds.right&&y>=bounds.top&&y<bounds.bottom;for(let c=0;c<4;c++){if(!inside||c===3)assert.equal(restored.data[i+c],data[i+c]);else if(restored.data[i+c]!==data[i+c])changed++}}assert.ok(changed>1000)
 if(process.argv[2])assert.equal(await busyBackgroundLogo(restored.data,width,height),undefined,'No residual boundary star in the shipped runtime output')
 console.log('PASS shipped Electron worker, native ONNX CPU runtime, ASAR model/checksum, actual repair, exact dimensions/outside pixels and disabled telemetry; no app profile opened.')
}finally{clearTimeout(timer)}
