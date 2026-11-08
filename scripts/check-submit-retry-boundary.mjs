import assert from 'node:assert/strict'
import os from 'node:os'
import {FlowCompanion} from '../dist-electron/flow-companion.cjs'
import {FlowNotSubmittedError,StorageError} from '../dist-electron/storage/errors.cjs'
let clicks=0,phase='arm-error'
const bridge=new FlowCompanion(os.tmpdir(),async()=>{clicks++;if(phase==='native-error')throw new StorageError('INVALID_REQUEST','Native result unknown')})
bridge.request=async action=>{
 if(action==='armSubmit'){if(phase==='arm-error')throw new StorageError('INVALID_REQUEST','Generate control not ready');if(phase==='invalid-ticket')return {};return {nonce:'11111111-1111-4111-8111-111111111111',title:'Fixture Flow'}}
 if(phase==='ack-error')throw new StorageError('INVALID_REQUEST','Acknowledgement lost')
 return {accepted:true,evidence:'prompt-cleared'}
}
const url='https://flow.google.com/project/fixture'
for(phase of ['arm-error','invalid-ticket']){await assert.rejects(()=>bridge.submit(url),e=>e instanceof FlowNotSubmittedError);assert.equal(clicks,0,'A retryable preparation error must mean no native activation happened')}
for(phase of ['native-error','ack-error'])await assert.rejects(()=>bridge.submit(url),e=>e instanceof StorageError&&!(e instanceof FlowNotSubmittedError),'Once native activation starts, uncertainty must never be treated as not submitted')
assert.equal(clicks,2);phase='success';await bridge.submit(url);assert.equal(clicks,3)
console.log('PASS submit-control failures before native activation are safely retryable; native/acknowledgement failures retain submission uncertainty; confirmed submission unchanged.')
