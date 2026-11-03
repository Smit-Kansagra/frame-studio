import sharp from 'sharp'
import { geminiMasks } from './gemini-masks.cjs'

// Visible-logo restoration only. Calibrated mask assets: Allen Kuo / allenk,
// MIT; see third-party/gemini-watermark/. No denoise or image regeneration.
type Profile = { name: string; size: number; margin: number; alpha: Float32Array; resized?:boolean }
export type LogoCleanup = { data: Buffer; width: number; height: number; channels: 4; removed: boolean; confidence: number; region?: { left: number; top: number; size: number }; repairMask?:Buffer }
let masks: Promise<Map<string, Float32Array>> | undefined
async function alphaMasks() {
  return masks ??= (async () => {
    const result = new Map<string, Float32Array>()
    for (const [name, encoded] of Object.entries(geminiMasks)) {
      const { data, info } = await sharp(Buffer.from(encoded, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const alpha = new Float32Array(info.width * info.height)
      for (let i = 0; i < alpha.length; i++) alpha[i] = Math.max(data[i * info.channels], data[i * info.channels + 1], data[i * info.channels + 2]) / 255
      result.set(name, alpha)
    }
    return result
  })()
}
async function profiles(width: number, height: number): Promise<Profile[]> {
  const alpha = await alphaMasks(), long = Math.max(width, height), short = Math.min(width, height)
  const result: Profile[] = [
    { name: 'legacy-small', size: 48, margin: 32, alpha: alpha.get('bg_48_png')! },
    { name: 'legacy-large', size: 96, margin: 64, alpha: alpha.get('bg_96_png')! },
    { name: 'current-large', size: 96, margin: 192, alpha: alpha.get('bg_b_96_png')! },
  ]
  const source = long > 1100 ? [2752, 2816, 2848].sort((a,b) => Math.abs(a - 2 * long) - Math.abs(b - 2 * long))[0] : short >= 566 ? 2752 : short >= 550 ? 2816 : 2848
  const scale = long / source, ideal = Math.round(96 * scale), size = ideal <= 40 ? 36 : ideal
  if (size <= 96) {
    let current = alpha.get('bg_b_36_png')!
    if (size !== 36) {
      const encoded = Buffer.from(geminiMasks.bg_b_96_png, 'base64')
      const {data, info} = await sharp(encoded).resize(size,size).removeAlpha().raw().toBuffer({resolveWithObject:true})
      current = Float32Array.from({length:size*size}, (_,i) => Math.max(data[i*info.channels],data[i*info.channels+1],data[i*info.channels+2])/255)
    }
    result.push({ name: 'current-small', size, margin: Math.round(192 * scale), alpha: current })
  }
  return result.filter(p => width >= p.size + p.margin && height >= p.size + p.margin)
}
function correlation(a: ArrayLike<number>, b: ArrayLike<number>) {
  let sa=0,sb=0,aa=0,bb=0,ab=0
  for(let i=0;i<a.length;i++){sa+=a[i];sb+=b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];ab+=a[i]*b[i]}
  const divisor=Math.sqrt(Math.max(0,aa-sa*sa/a.length)*Math.max(0,bb-sb*sb/a.length))
  return divisor>1e-6?(ab-sa*sb/a.length)/divisor:0
}
function gradients(values: ArrayLike<number>, size: number) {
  const result = new Float32Array((size-2)*(size-2))
  let i=0
  for(let y=1;y<size-1;y++)for(let x=1;x<size-1;x++){
    const at=y*size+x, dx=values[at+1]-values[at-1],dy=values[at+size]-values[at-size]
    result[i++]=Math.hypot(dx,dy)
  }
  return result
}
function regionGray(data: Buffer,width: number,x: number,y: number,size: number) {
  const gray=new Float32Array(size*size)
  for(let yy=0;yy<size;yy++)for(let xx=0;xx<size;xx++){
    const at=((y+yy)*width+x+xx)*4
    gray[yy*size+xx]=.299*data[at]+.587*data[at+1]+.114*data[at+2]
  }
  return gray
}
type Match={p:Profile;x:number;y:number;score:number;spatial:number}
function scaleAlpha(values:Float32Array,from:number,size:number){
  const out=new Float32Array(size*size)
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const sx=Math.max(0,Math.min(from-1,(x+.5)*from/size-.5)),sy=Math.max(0,Math.min(from-1,(y+.5)*from/size-.5)),ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy
    out[y*size+x]=values[iy*from+ix]*(1-fx)*(1-fy)+values[iy*from+Math.min(from-1,ix+1)]*fx*(1-fy)+values[Math.min(from-1,iy+1)*from+ix]*(1-fx)*fy+values[Math.min(from-1,iy+1)*from+Math.min(from-1,ix+1)]*fx*fy
  }
  return out
}
// Older downloads may already have been resized to the theme. Search only the
// bottom-right corner at bounded scales, then require a strong full-size match.
async function scaledCornerMatch(data:Buffer,width:number,height:number,progress?: (percent:number,message:string)=>void):Promise<Match|undefined>{
  if(width<240||height<240)return
  const left=width-Math.min(320,Math.round(width*.3)),top=height-Math.min(320,Math.round(height*.3)),cw=width-left,ch=height-top
  const gray=new Float32Array(cw*ch)
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){const at=((top+y)*width+left+x)*4;gray[y*cw+x]=.299*data[at]+.587*data[at+1]+.114*data[at+2]}
  const maps=await alphaMasks(),shortlist:Array<{name:string;alpha:Float32Array;from:number;x:number;y:number;size:number;score:number}>=[]
  let mapIndex=0
  for(const [name,alpha]of maps){
    progress?.(55+Math.floor(mapIndex++/maps.size*17),'Checking resized logo patterns')
    const from=Math.sqrt(alpha.length),sample=scaleAlpha(alpha,from,7)
    let sa=0,aa=0;for(const a of sample){sa+=a;aa+=a*a}
    const variance=aa-sa*sa/49,points:Array<{x:number;y:number;size:number;score:number}>=[]
    for(let size=24;size<=112;size+=4){
      const offsets=Array.from({length:7},(_,i)=>Math.min(size-1,Math.floor((i+.5)*size/7)))
      for(let y=0;y+size<=ch-12;y+=4)for(let x=0;x+size<=cw-12;x+=4){
        let sb=0,bb=0,ab=0,k=0
        for(const yy of offsets)for(const xx of offsets){const b=gray[(y+yy)*cw+x+xx];sb+=b;bb+=b*b;ab+=sample[k++]*b}
        const divisor=Math.sqrt(variance*Math.max(0,bb-sb*sb/49)),score=divisor>1e-5?(ab-sa*sb/49)/divisor:0
        if(score>.72){points.push({x:left+x,y:top+y,size,score});points.sort((a,b)=>b.score-a.score);if(points.length>16)points.pop()}
      }
    }
    const chosen:typeof points=[]
    for(const point of points){if(chosen.some(p=>Math.abs(p.x+p.size/2-point.x-point.size/2)<8&&Math.abs(p.y+p.size/2-point.y-point.size/2)<8&&Math.abs(p.size-point.size)<12))continue;chosen.push(point);shortlist.push({...point,name,alpha,from});if(chosen.length===2)break}
  }
  let best:Match|undefined,checked=0
  for(const point of shortlist){
    progress?.(73+Math.floor(checked++/Math.max(1,shortlist.length)*4),'Verifying resized logo match')
    for(let size=point.size-3;size<=point.size+3;size++){
      const alpha=scaleAlpha(point.alpha,point.from,size),edgeTemplate=gradients(alpha,size)
      for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){
        const x=point.x+dx,y=point.y+dy;if(x<0||y<0||x+size>width||y+size>height)continue
        const image=regionGray(data,width,x,y,size),spatial=correlation(image,alpha);if(spatial<.7)continue
        const edge=correlation(gradients(image,size),edgeTemplate),score=.55*spatial+.45*edge
        if(edge>=.4&&score>=.62&&(!best||score>best.score))best={p:{name:point.name,size,margin:0,alpha,resized:true},x,y,score,spatial}
      }
    }
  }
  return best
}
function resizedOpacity(data:Buffer,width:number,x:number,y:number,p:Profile){
  const gray=regionGray(data,width,x,y,p.size),matrix=Array.from({length:3},()=>[0,0,0,0]),points:Array<{v:number[];value:number}>=[]
  for(let yy=0;yy<p.size;yy++)for(let xx=0;xx<p.size;xx++){
    const i=yy*p.size+xx;if(p.alpha[i]>.025)continue
    const v=[1,xx/p.size-.5,yy/p.size-.5],value=gray[i];points.push({v,value})
    for(let r=0;r<3;r++){for(let c=0;c<3;c++)matrix[r][c]+=v[r]*v[c];matrix[r][3]+=v[r]*value}
  }
  if(points.length<p.size*p.size*.25)return 1
  for(let i=0;i<3;i++){
    if(Math.abs(matrix[i][i])<1e-8)return 1
    const divisor=matrix[i][i];for(let c=i;c<4;c++)matrix[i][c]/=divisor
    for(let r=0;r<3;r++){if(r===i)continue;const scale=matrix[r][i];for(let c=i;c<4;c++)matrix[r][c]-=scale*matrix[i][c]}
  }
  const plane=(xx:number,yy:number)=>matrix[0][3]+matrix[1][3]*(xx/p.size-.5)+matrix[2][3]*(yy/p.size-.5)
  let error=0;for(const point of points){const predicted=matrix[0][3]+matrix[1][3]*point.v[1]+matrix[2][3]*point.v[2];error+=(predicted-point.value)**2}
  if(Math.sqrt(error/points.length)>5)return 1
  let num=0,den=0
  for(let yy=0;yy<p.size;yy++)for(let xx=0;xx<p.size;xx++){const i=yy*p.size+xx,a=p.alpha[i];if(a<.025)continue;const background=plane(xx,yy),v=a*(255-background);num+=v*(gray[i]-background);den+=v*v}
  return den>1e-5?Math.max(.5,Math.min(1.6,num/den)):1
}
// A white logo over leaves/shadows can have low global luminance correlation.
// In that case inspect the witnessed Flow anchor narrowly, and pass only a
// matched star mask to the separate background-repair method.
export async function busyBackgroundLogo(data:Buffer,width:number,height:number):Promise<{region:{left:number;top:number;size:number};mask:Buffer;confidence:number}|undefined>{
  const short=Math.min(width,height);if(short<512)return
  const base=Math.round(short*.054),distance=short/9,maps=await alphaMasks()
  let best:Match|undefined
  for(const [name,values]of maps)for(let size=Math.max(24,base-4);size<=Math.min(112,base+4);size++){
    const alpha=scaleAlpha(values,Math.sqrt(values.length),size),edges=gradients(alpha,size)
    const startX=Math.round(width-distance-size/2),startY=Math.round(height-distance-size/2)
    for(let dy=-7;dy<=7;dy++)for(let dx=-7;dx<=7;dx++){
      const x=startX+dx,y=startY+dy;if(x<0||y<0||x+size>width||y+size>height)continue
      const gray=regionGray(data,width,x,y,size),spatial=correlation(gray,alpha);if(spatial<.28)continue
      const edge=correlation(gradients(gray,size),edges),score=.55*spatial+.45*edge
      if(edge<.15||score<.34||best&&score<=best.score)continue
      let core=0,coreN=0,background=0,bgN=0
      for(let i=0;i<alpha.length;i++){if(alpha[i]>.2){core+=gray[i];coreN++}if(alpha[i]<.025){background+=gray[i];bgN++}}
      if(!coreN||!bgN||core/coreN-background/bgN<2)continue
      best={p:{name,size,alpha,margin:0},x,y,score,spatial}
    }
  }
  if(best)return {region:{left:best.x,top:best.y,size:best.p.size},mask:Buffer.from(best.p.alpha.map(v=>v>.015?255:0)),confidence:best.score}
  return boundaryLogo(data,width,height,maps)
}

// A fabric/background boundary dominates global brightness correlation. Match
// signed contour normals instead, clipping the seam's contrast so it cannot
// dominate. Require agreement around the star, not just one bright edge.
function boundaryLogo(data:Buffer,width:number,height:number,maps:Map<string,Float32Array>){
  const short=Math.min(width,height),base=Math.round(short*.054),distance=short/9
  if(base<24||base>112)return
  const gray=(x:number,y:number)=>{const i=(y*width+x)*4;return .299*data[i]+.587*data[i+1]+.114*data[i+2]}
  let best:{score:number;size:number;x:number;y:number;alpha:Float32Array}|undefined
  for(const values of maps.values())for(let size=Math.max(24,base-4);size<=Math.min(112,base+4);size++){
    const alpha=scaleAlpha(values,Math.sqrt(values.length),size),points:Array<{x:number;y:number;nx:number;ny:number;q:number}>=[]
    for(let y=1;y<size-1;y++)for(let x=1;x<size-1;x++){const i=y*size+x,ax=alpha[i+1]-alpha[i-1],ay=alpha[i+size]-alpha[i-size],length=Math.hypot(ax,ay);if(length>.02)points.push({x,y,nx:ax/length,ny:ay/length,q:(x>=size/2?1:0)+(y>=size/2?2:0)})}
    if(points.length<40)continue
    const anchorX=Math.round(width-distance-size/2),anchorY=Math.round(height-distance-size/2)
    for(let dy=-7;dy<=7;dy++)for(let dx=-7;dx<=7;dx++){
      const left=anchorX+dx,top=anchorY+dy;if(left<1||top<1||left+size>=width||top+size>=height)continue
      let sum=0,positive=0,negative=0;const quadrants=[0,0,0,0],counts=[0,0,0,0]
      for(const p of points){const x=left+p.x,y=top+p.y,v=(gray(x+1,y)-gray(x-1,y))*p.nx+(gray(x,y+1)-gray(x,y-1))*p.ny,clipped=Math.max(-8,Math.min(8,v));sum+=clipped;quadrants[p.q]+=clipped;counts[p.q]++;if(v>1)positive++;if(v< -1)negative++}
      const score=sum/points.length
      if(score<2||positive/points.length<.60||negative/points.length>.30||quadrants.filter((v,q)=>counts[q]>0&&v/counts[q]>1.2).length<3||best&&score<=best.score)continue
      best={score,size,x:left,y:top,alpha}
    }
  }
  return best?{region:{left:best.x,top:best.y,size:best.size},mask:Buffer.from(best.alpha.map(v=>v>.015?255:0)),confidence:Math.min(1,best.score/8)}:undefined
}

export async function cleanGeminiLogo(source: string | Buffer, progress?: (percent: number, message: string)=>void): Promise<LogoCleanup> {
  progress?.(5,'Reading image')
  const { data, info } = await sharp(source, {limitInputPixels: 40_000_000}).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true})
  progress?.(15,'Image decoded')
  const result: LogoCleanup={data,width:info.width,height:info.height,channels:4,removed:false,confidence:0}
  // Search only known anchored logo locations, within a few pixels for rounding.
  // A weak/unknown match leaves the full image untouched.
  let best: Match | undefined
  const candidates=await profiles(info.width,info.height)
  let checked=0,lastPercent=15
  for(const p of candidates) {
    const templateGradient=gradients(p.alpha,p.size)
    for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){
      const percent=15+Math.floor(++checked/(candidates.length*49)*40)
      if(percent!==lastPercent){lastPercent=percent;progress?.(percent,'Checking logo patterns')}
      const x=info.width-p.size-p.margin+dx,y=info.height-p.size-p.margin+dy
      if(x<0||y<0||x+p.size>info.width||y+p.size>info.height)continue
      const gray=regionGray(data,info.width,x,y,p.size),spatial=correlation(gray,p.alpha)
      if(spatial<.4)continue
      const edge=correlation(gradients(gray,p.size),templateGradient)
      const score=.55*spatial+.45*edge
      if(spatial>=.5 && edge>=.35 && score>=.55 && (!best||score>best.score))best={p,x,y,score,spatial}
    }
  }
  if(!best)best=await scaledCornerMatch(data,info.width,info.height,progress)
  if(!best){progress?.(88,'No confident logo match; image preserved');return result}
  progress?.(80,'Restoring detected logo pixels')
  const {p,x,y}=best, candidate=Buffer.from(data)
  const strength=p.resized?resizedOpacity(data,info.width,x,y,p):1
  let clipped=0,changed=0
  for(let yy=0;yy<p.size;yy++)for(let xx=0;xx<p.size;xx++){
    const alpha=p.alpha[yy*p.size+xx]*strength
    if(alpha<.002||alpha>=.99)continue
    const at=((y+yy)*info.width+x+xx)*4
    for(let channel=0;channel<3;channel++){
      const value=(data[at+channel]-255*alpha)/(1-alpha)
      if(value< -12||value>267)clipped++
      candidate[at+channel]=Math.max(0,Math.min(255,Math.round(value)));changed++
    }
  }
  // Reject a mismatched profile or compression artefacts that would over-darken
  // the corner. A successful inversion should reduce the logo's correlation.
  const after=correlation(regionGray(candidate,info.width,x,y,p.size),p.alpha)
  progress?.(88,'Logo restoration checked')
  const repairMask=Buffer.from(p.alpha.map(alpha=>alpha>.025?255:0))
  const matched={confidence:best.score,region:{left:x,top:y,size:p.size},repairMask}
  if(!changed||clipped/changed>.025||Math.abs(after)>Math.max(.2,best.spatial-.25))return {...result,...matched}
  return {...result,data:candidate,removed:true,...matched}
}
