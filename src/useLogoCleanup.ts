import {useCallback,useEffect,useRef,useState} from 'react'
import type {GenerationAttempt,LogoRepairArea,LogoReview} from '../electron/contracts.cjs'

export function useLogoCleanup(projectId:string,enabled:boolean,attempts:GenerationAttempt[],selectedVersionId:string){
  const api=window.frameStudio?.generations
  const [logos,setLogos]=useState<LogoReview[]>([]),[starting,setStarting]=useState(new Set<string>()),[error,setError]=useState(''),[loaded,setLoaded]=useState(false)
  const running=useRef(new Set<string>()),automatic=useRef(new Set<string>()),mounted=useRef(true)
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
  const merge=useCallback((values:LogoReview[])=>setLogos(previous=>{
    const next=new Map(previous.map(v=>[v.attemptId,v]))
    for(const value of values){const old=next.get(value.attemptId);if(old&&(old.updatedAt>value.updatedAt||old.runId===value.runId&&old.status==='processing'&&value.status==='processing'&&(old.percent??0)>(value.percent??0)))continue;next.set(value.attemptId,value)}
    return [...next.values()]
  }),[])
  const refresh=useCallback(async()=>{
    if(!enabled||!api)return
    try{const result=await api.logoReviews(projectId);if(!result.ok)throw Error(result.error.message);if(mounted.current){merge(result.value);setLoaded(true)}}catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'Could not check local cleanup.')}
  },[projectId,enabled,api,merge])
  useEffect(()=>{if(!enabled)return;void refresh();const timer=window.setInterval(()=>void refresh(),1000);return()=>window.clearInterval(timer)},[enabled,refresh])
  useEffect(()=>{if(!enabled)return;return api?.onLogoProgress?.(value=>{if(value.projectId===projectId)merge([value])})},[api,enabled,projectId,merge])
  const needsCleanup=(attempt:GenerationAttempt)=>{
    const logo=logos.find(l=>l.attemptId===attempt.id)
    return attempt.state==='ready-for-review'&&logo?.status!=='processing'&&logo?.phase!=='failed'&&(!logo||logo.cleanup==='not-checked'||logo.cleanup==='not-detected'&&logo.cleanupVersion!==4)
  }
  const retry=async(id:string,area?:LogoRepairArea)=>{
    if(!api||running.current.has(id))return
    running.current.add(id);setStarting(previous=>new Set(previous).add(id));setError('')
    try{const result=await api.retryLogo(id,area);if(!result.ok)throw Error(result.error.message);if(mounted.current)merge([result.value]);return result.value}
    catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'Logo repair could not finish.');throw cause}
    finally{running.current.delete(id);if(mounted.current){setStarting(previous=>{const next=new Set(previous);next.delete(id);return next});void refresh()}}
  }
  const autoIds=enabled&&loaded?attempts.filter(a=>(a.id===selectedVersionId||attempts.find(v=>v.sceneId===a.sceneId&&v.state==='ready-for-review')?.id===a.id)&&needsCleanup(a)).map(a=>a.id).join(','):''
  useEffect(()=>{for(const id of autoIds.split(',').filter(Boolean)){if(automatic.current.has(id))continue;automatic.current.add(id);void retry(id).catch(()=>{})}},[autoIds])
  const processing=(id:string)=>starting.has(id)||logos.find(l=>l.attemptId===id)?.status==='processing'
  const ready=(attempt?:GenerationAttempt)=>{
    if(!loaded||!attempt||attempt.state!=='ready-for-review'||processing(attempt.id)||needsCleanup(attempt))return false
    const logo=logos.find(l=>l.attemptId===attempt.id)
    return !!logo&&logo.phase!=='failed'&&!!logo.checkedAt
  }
  return {logos,processing,ready,retry,error,merge}
}
