import {parentPort,workerData} from 'node:worker_threads'
import sharp from 'sharp'
import {busyBackgroundLogo,cleanGeminiLogo} from './gemini-logo.cjs'
import {inpaintLogo,selectedRepairRegion} from './logo-inpaint.cjs'
import type {LogoRepairArea} from '../contracts.cjs'

const data=workerData as {source:string;target:string;width?:number;height?:number;retry?:boolean;area?:LogoRepairArea}
sharp.concurrency(1)
void (async()=>{
  const cleaned=await cleanGeminiLogo(data.source,(percent,message)=>parentPort?.postMessage({type:'progress',percent,message}))
  let method='reverse-alpha'
  if(data.area){
    const original=await sharp(data.source).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer()
    parentPort?.postMessage({type:'progress',percent:89,message:'Repairing the selected logo area locally'})
    cleaned.data=await inpaintLogo(original,cleaned.width,cleaned.height,selectedRepairRegion(data.area,cleaned.width,cleaned.height));cleaned.removed=true;method='local-inpainting'
  }else if(!cleaned.removed){
    const candidate=cleaned.region&&cleaned.repairMask?{region:cleaned.region,mask:cleaned.repairMask,confidence:cleaned.confidence}:await busyBackgroundLogo(cleaned.data,cleaned.width,cleaned.height)
    if(candidate){
      parentPort?.postMessage({type:'progress',percent:89,message:'Repairing the detected logo background locally'})
      cleaned.data=await inpaintLogo(cleaned.data,cleaned.width,cleaned.height,{left:candidate.region.left,top:candidate.region.top,width:candidate.region.size,height:candidate.region.size,mask:candidate.mask});cleaned.removed=true;cleaned.confidence=candidate.confidence;method='local-inpainting'
    }
  }
  if(!data.retry||cleaned.removed){
    parentPort?.postMessage({type:'progress',percent:90,message:'Encoding cleaned PNG'})
    let image=sharp(cleaned.data,{raw:{width:cleaned.width,height:cleaned.height,channels:4}})
    if(data.width&&data.height)image=image.resize(data.width,data.height,{fit:'cover',position:'centre'})
    await image.png({compressionLevel:3}).toFile(data.target)
  }
  parentPort?.postMessage({type:'progress',percent:95,message:'PNG processing complete; saving result'})
  return {removed:cleaned.removed,confidence:cleaned.confidence,method}
})().then(result=>parentPort?.postMessage({type:'done',result})).catch((error:Error)=>parentPort?.postMessage({type:'error',message:error.message})).finally(()=>parentPort?.close())
