import path from 'node:path'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import type {LogoRepairArea} from '../contracts.cjs'

export type RepairRegion={left:number;top:number;width:number;height:number;mask?:Buffer}
export function validateRepairArea(value:unknown): LogoRepairArea {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Select a small rectangle around the remaining logo.')
  const a=value as Record<string,unknown>
  if(Object.keys(a).some(k=>!['x','y','width','height'].includes(k))||!['x','y','width','height'].every(k=>typeof a[k]==='number'&&Number.isFinite(a[k])))throw Error('Invalid logo selection.')
  const area=a as LogoRepairArea
  if(area.x<0||area.y<0||area.width<=0||area.height<=0||area.x+area.width>1.000001||area.y+area.height>1.000001||area.width>.35||area.height>.35||area.width*area.height>.08)throw Error('Select only the small logo area, not the full image.')
  return area
}
export function selectedRepairRegion(area:LogoRepairArea,width:number,height:number):RepairRegion {
  validateRepairArea(area)
  const left=Math.floor(area.x*width),top=Math.floor(area.y*height),w=Math.min(width-left,Math.ceil(area.width*width)),h=Math.min(height-top,Math.ceil(area.height*height))
  if(w<3||h<3)throw Error('The logo selection is too small.')
  return {left,top,width:w,height:h}
}
export async function inpaintLogo(data:Buffer,width:number,height:number,region:RepairRegion):Promise<Buffer>{
  // Disable runtime telemetry before loading ONNX. Images and masks stay local.
  process.env.ORT_DISABLE_TELEMETRY='1'
  const ort=await import('onnxruntime-node')
  const model=await readFile(path.join(__dirname,'../../third-party/migan/migan_pipeline_v2.onnx'))
  if(createHash('sha256').update(model).digest('hex')!=='6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b')throw Error('The local logo repair model did not pass its checksum check. Reinstall Frame Studio.')
  const radius=3,largest=Math.max(region.width,region.height),side=Math.max(largest+radius*2,Math.min(512,Math.max(192,largest*4)))
  const cw=Math.min(width,side),ch=Math.min(height,side),left=Math.max(0,Math.min(width-cw,Math.round(region.left+region.width/2-cw/2))),top=Math.max(0,Math.min(height-ch,Math.round(region.top+region.height/2-ch/2)))
  const plane=cw*ch,image=new Uint8Array(plane*3),mask=new Uint8Array(plane).fill(255)
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){const at=((top+y)*width+left+x)*4,i=y*cw+x;for(let c=0;c<3;c++)image[c*plane+i]=data[at+c]}
  for(let y=0;y<region.height;y++)for(let x=0;x<region.width;x++){
    if(region.mask&&!region.mask[y*region.width+x])continue
    for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++){
      if(dx*dx+dy*dy>radius*radius)continue
      const px=region.left+x+dx-left,py=region.top+y+dy-top
      if(px>=0&&py>=0&&px<cw&&py<ch)mask[py*cw+px]=0
    }
  }
  const session=await ort.InferenceSession.create(model,{executionProviders:['cpu'],intraOpNumThreads:1,interOpNumThreads:1,logSeverityLevel:3})
  try {
    const result=await session.run({image:new ort.Tensor('uint8',image,[1,3,ch,cw]),mask:new ort.Tensor('uint8',mask,[1,1,ch,cw])})
    const output=result.result
    if(output.type!=='uint8'||output.dims.join(',')!==[1,3,ch,cw].join(','))throw Error('The local repair model returned an invalid image.')
    const restored=output.data as Uint8Array,final=Buffer.from(data)
    for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){const i=y*cw+x;if(mask[i]!==0)continue;const at=((top+y)*width+left+x)*4;for(let c=0;c<3;c++)final[at+c]=restored[c*plane+i]}
    return final
  } finally {await session.release()}
}
