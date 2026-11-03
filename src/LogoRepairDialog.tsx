import {useRef,useState} from 'react'
import type {PointerEvent} from 'react'
import type {LogoRepairArea} from '../electron/contracts.cjs'
import {Dialog} from './Products'

export function LogoRepairDialog({attemptId,onClose,onRepair}:{attemptId:string;onClose:()=>void;onRepair:(area:LogoRepairArea)=>void}){
  const [area,setArea]=useState<LogoRepairArea>(),[ready,setReady]=useState(false),[failed,setFailed]=useState(false)
  const drag=useRef<{x:number;y:number;pointer:number}|undefined>(undefined)
  const point=(event:PointerEvent<HTMLDivElement>)=>{const box=event.currentTarget.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(event.clientX-box.left)/box.width)),y:Math.max(0,Math.min(1,(event.clientY-box.top)/box.height))}}
  const valid=!!area&&area.width>=.003&&area.height>=.003&&area.width<=.35&&area.height<=.35&&area.width*area.height<=.08
  const update=(event:PointerEvent<HTMLDivElement>)=>{const start=drag.current;if(!start||start.pointer!==event.pointerId)return;const end=point(event);setArea({x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)})}
  return <Dialog title="Mark remaining logo" onClose={onClose} wide>
    <p>Drag a small rectangle around the logo, including its edges. Only this area will be reconstructed; the full image size stays the same.</p>
    <div className="logo-repair-stage"><div className="logo-repair-canvas" aria-label="Select logo area" onPointerDown={event=>{if(!ready||event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);drag.current={...point(event),pointer:event.pointerId};setArea(undefined)}} onPointerMove={update} onPointerUp={event=>{update(event);drag.current=undefined}} onPointerCancel={()=>{drag.current=undefined;setArea(undefined)}}>
      <img src={`frame-media://attempt/${attemptId}`} alt="Select the remaining logo on this image" draggable={false} onLoad={()=>{setReady(true);setFailed(false)}} onError={()=>{setReady(false);setFailed(true)}}/>
      {area&&<span className="logo-repair-selection" style={{left:`${area.x*100}%`,top:`${area.y*100}%`,width:`${area.width*100}%`,height:`${area.height*100}%`}}/>}
    </div></div>
    {failed&&<p role="alert">This saved image could not be opened.</p>}
    {area&&!valid&&<p role="status">Select only the small logo area.</p>}
    <div className="dialog-actions"><button type="button" className="button button-secondary" onClick={()=>setArea(undefined)}>Clear selection</button><button type="button" className="button button-primary" disabled={!ready||!valid} onClick={()=>{if(area&&valid)onRepair(area)}}>Repair selected logo area</button></div>
  </Dialog>
}
