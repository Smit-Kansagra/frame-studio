// Regression: transparent star crossing a fabric/background seam. Copies only.
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import {busyBackgroundLogo} from '../dist-electron/media/gemini-logo.cjs'
import {geminiMasks} from '../dist-electron/media/gemini-masks.cjs'
import {LogoQueue} from '../dist-electron/media/logo-queue.cjs'
const root=await mkdtemp(path.join(os.tmpdir(),'frame-logo-boundary-')),width=1080,height=1440,size=58,left=931,top=1294,pool=new LogoQueue(2)
let random=1234;const noise=()=>{random=(1664525*random+1013904223)>>>0;return random/2**32}
const raw=Buffer.alloc(width*height*4)
for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,cloth=x<965+Math.sin(y/40)*2,n=(noise()-.5)*15;raw[i]=Math.round((cloth?25:225)+n);raw[i+1]=Math.round((cloth?46:224)+n);raw[i+2]=Math.round((cloth?65:222)+n);raw[i+3]=255}
assert.equal(await busyBackgroundLogo(raw,width,height),undefined,'Fabric/white seam without a star is preserved')
const {data:mask,info}=await sharp(Buffer.from(geminiMasks.bg_48_png,'base64')).resize(size,size).removeAlpha().raw().toBuffer({resolveWithObject:true}),marked=Buffer.from(raw)
for(let y=0;y<size;y++)for(let x=0;x<size;x++){const j=(y*size+x)*info.channels,a=Math.max(mask[j],mask[j+1],mask[j+2])/255,i=((top+y)*width+left+x)*4;for(let c=0;c<3;c++)marked[i+c]=Math.round(marked[i+c]*(1-a)+255*a)}
const match=await busyBackgroundLogo(marked,width,height);assert.ok(match,'Star on a fabric/background boundary must be found');assert.ok(Math.abs(match.region.left-left)<=4&&Math.abs(match.region.top-top)<=4)
const source=path.join(root,'marked.png'),target=path.join(root,'repaired.png');await sharp(marked,{raw:{width,height,channels:4}}).png().toFile(source)
async function repair(file,out,shouldRemove,key){
 const bytes=await readFile(file),{data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true}),candidate=await busyBackgroundLogo(data,info.width,info.height)
 assert.equal(!!candidate,shouldRemove,key+' detection');const result=await pool.run(key,{source:file,target:out,retry:true});assert.equal(result.removed,shouldRemove)
 if(!shouldRemove){await assert.rejects(()=>stat(out),{code:'ENOENT'});return}
 const output=await sharp(out).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(output.info.width,info.width);assert.equal(output.info.height,info.height)
 const r=candidate.region
 for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){const i=(y*info.width+x)*4,inside=x>=r.left-3&&x<r.left+r.size+3&&y>=r.top-3&&y<r.top+r.size+3;for(let c=0;c<4;c++)if(!inside||c===3)assert.equal(output.data[i+c],data[i+c],key+' preserves outside pixels/alpha')}
 assert.equal(await busyBackgroundLogo(output.data,info.width,info.height),undefined,key+' no remaining star');assert.deepEqual(await readFile(file),bytes,key+' source copy unchanged')
 const repeat=path.join(root,key+'-repeat.png');assert.equal((await pool.run(key+'-again',{source:out,target:repeat,retry:true})).removed,false);await assert.rejects(()=>stat(repeat),{code:'ENOENT'})
}
await repair(source,target,true,'synthetic-seam')
// Existing clean photos are useful negative cases, not rewritten as a precaution.
if(process.argv[2]){const expected=new Set((process.argv[3]??'').split(',').map(Number));await Promise.all(Array.from({length:5},(_,i)=>repair(path.join(process.argv[2],`input-${i}.png`),path.join(root,`actual-${i}.png`),expected.has(i),'actual-'+i)))}
console.log('PASS boundary-star detection, real local inpainting, no-logo seam/clean-photo skip, no residual detection, repeat skip, unchanged dimensions/outside pixels and unchanged input copies. Outputs: '+root)
