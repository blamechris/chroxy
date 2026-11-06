import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SessionManager} from '../src/session-manager.js'
import {SdkSession} from '../src/sdk-session.js'
const barrier=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release}}
const footer='**Status:**\n- ✅ Verified\n- 🔄 none\n- ⛔ none\n- 🔶 DECISION: none\n\n**Next:** ⚪ IDLE — Completed check'
const init=id=>({type:'system',subtype:'init',session_id:id,model:'claude-x',tools:[]})
const result=(subtype='success')=>({type:'result',subtype,is_error:subtype!=='success',duration_ms:1,num_turns:1,total_cost_usd:0,usage:{}})
function query(events,stopTask=async()=>{}){return{[Symbol.asyncIterator]:events,stopTask,interrupt:async()=>{},close(){}}}

test('late superseded SDK accounting success cannot apply or consume successor candidate before successor failure',{timeout:5000},async()=>{
 const dir=mkdtempSync(join(tmpdir(), 'declared-overlap-'));const stateFilePath=dir+'/state.json'
 const s=new SdkSession({cwd:dir,skillsDir:dir,repoSkillsDir:null});s._processReady=true;s._fetchSupportedModels=()=>{}
 const m=new SessionManager({skipPreflight:true,stateFilePath});m._sessions.set('s',{session:s,name:'Review',cwd:dir,provider:'claude-sdk',createdAt:Date.now()});m._wireSessionEvents('s',s);m.setDeclaredStatus('s',{state:'blocked',summary:'Keep',decision:'Keep'})
 const stopping=barrier(),releaseStop=barrier(),bCandidate=barrier(),releaseB=barrier();let a,b
 try{
   s._callQuery=()=>query(async function*(){yield init('A');yield{type:'system',subtype:'task_started',task_id:'A-task',tool_use_id:'A-tool',task_type:'local_agent',is_backgrounded:true,description:'A background'};yield result()},async()=>{stopping.release();await releaseStop.promise})
   a=s.sendMessage('A');await stopping.promise
   // Production recovery grants a retry while the old bounded task-stop awaits.
   s._handleHardTimeout(s._currentMessageId,false)
   s._callQuery=()=>query(async function*(){yield init('B');yield{type:'assistant',message:{content:[{type:'text',text:footer}]}};bCandidate.release();await releaseB.promise;yield result('error_during_execution')})
   b=s.sendMessage('B');await bCandidate.promise
   assert.equal(m.getSession('s').declaredStatus.decision,'Keep','positive control: incomplete B has not changed declaration')
   assert.equal(m.getSession('s')._pendingDeclaredStatus.decision,'none','B candidate waiting for B success')
   assert.equal(JSON.parse(readFileSync(stateFilePath)).sessions[0].turnInFlight,true,'B was correctly persisted in flight')
   releaseStop.release();await a
   const beforeBEnd={busy:s._isBusy,decision:m.getSession('s').declaredStatus.decision??null,pending:m.getSession('s')._pendingDeclaredStatus??null,saved:JSON.parse(readFileSync(stateFilePath)).sessions[0]}
   console.log('AFTER_OLD_SUCCESS',JSON.stringify({busy:beforeBEnd.busy,decision:beforeBEnd.decision,pending:beforeBEnd.pending,turnInFlight:beforeBEnd.saved.turnInFlight,declaredStatus:beforeBEnd.saved.declaredStatus,decisionActivity:beforeBEnd.saved.decisionActivity}))
   releaseB.release();await b
   console.log('AFTER_B_FAILURE',JSON.stringify({decision:m.getSession('s').declaredStatus.decision??null,busy:s._isBusy}))
   assert.equal(beforeBEnd.decision,'Keep','old A accounting result must not commit B declaration')
   assert.equal(beforeBEnd.pending.decision,'none','old result must not consume B candidate')
   assert.equal(beforeBEnd.saved.turnInFlight,true,'B remains persisted in flight after old accounting')
   assert.equal(beforeBEnd.saved.declaredStatus.decision,'Keep','old result cannot persist a premature clear')
   assert.equal(m.getSession('s').declaredStatus.decision,'Keep','failed B must preserve prior decision')
 }finally{releaseStop.release();releaseB.release();await Promise.allSettled([a,b]);m.destroyAll();rmSync(dir,{recursive:true,force:true})}
})
