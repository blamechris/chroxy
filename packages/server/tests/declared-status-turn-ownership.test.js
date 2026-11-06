import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { GeminiSession } from '../src/gemini-session.js'
const footer = (decision='none', task='Continue tests (reviewer)') => `**Status:**\n- ✅ Verified\n- 🔄 none\n- ⛔ none\n- 🔶 DECISION: ${decision}\n\n**Next:** ⚪ IDLE — ${task}`
function h(Session=BaseSession) {
  const dir=mkdtempSync(join(tmpdir(), 'status-probe-'))
  const s=new Session({cwd:dir,skillsDir:dir,repoSkillsDir:null})
  if (Session===BaseSession) s.destroy=()=>{s._destroyPendingBackgroundShells();s.removeAllListeners()}
  const m=new SessionManager({skipPreflight:true,stateFilePath:dir+'/state.json'})
  m._sessions.set('s',{session:s,name:'Review',cwd:dir,provider:'claude-sdk',createdAt:Date.now()})
  m._wireSessionEvents('s',s)
  m.setDeclaredStatus('s',{state:'blocked',summary:'Keep',decision:'Keep'})
  return {s,m, get status(){return m.getSession('s').declaredStatus},close(){m.destroyAll();rmSync(dir,{recursive:true,force:true})}}
}
const text = t=>({type:'assistant',message:{content:[{type:'text',text:t}]}})
const result=(extra={})=>({type:'result',subtype:'success',num_turns:1,total_cost_usd:0,duration_ms:1,usage:{},...extra})


for (const [severity,message] of [
  ['warning','Loop detected, stopping execution'],
  ['error','Maximum session turns exceeded'],
  ['warning','Agent execution blocked: policy denied'],
]) test(`Gemini ${message} then success must not clear decision`,()=>{
  const x=h(GeminiSession),ctx={messageId:'m',didStreamStart:false}
  try {
    for(const ev of [
      {type:'message',role:'assistant',content:footer(),delta:true},
      {type:'error',severity,message},
      {type:'result',status:'success',stats:{}}
    ]) x.s._processJsonlLine(ev,ctx)
    console.log('GEMINI OBSERVED', message, JSON.stringify(x.status))
    assert.equal(x.status.decision,'Keep')
  }finally{x.close()}
})
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
for(const [aSuccess,bSuccess] of [[true,false],[true,true],[false,true]]) test(`SDK old ${aSuccess ? 'success' : 'failure'} result cannot ${bSuccess?'consume':'apply'} successor candidate`,async()=>{
  const x=h(SdkSession),aGate=deferred(),bGate=deferred(),aSeen=deferred(),bSeen=deferred()
  let a,b,afterA
  try {
    x.s._processReady=true;x.s._fetchSupportedModels=()=>{}
    let count=0
    x.s._callQuery=()=>{
      const ordinal=++count
      const iterator=(async function*(){
        yield text(ordinal===1?'A ordinary output':footer(bSuccess?'Successor decision':'none'))
        ;(ordinal===1?aSeen:bSeen).resolve()
        await (ordinal===1?aGate:bGate).promise
        yield result((ordinal===1?aSuccess:bSuccess)?{}:{subtype:'error_during_execution',is_error:true})
      })()
      iterator.interrupt=async()=>{}
      return iterator
    }
    a=x.s.sendMessage('A');await aSeen.promise
    x.s._handleStreamStall(x.s._currentMessageId,false)
    assert.equal(x.status.decision,'Keep')
    b=x.s.sendMessage('B');await bSeen.promise
    aGate.resolve();await a
    afterA=x.status.decision
    console.log('SDK AFTER OLD RESULT',bSuccess,JSON.stringify(x.status))
    bGate.resolve();await b
    console.log('SDK AFTER SUCCESSOR',bSuccess,JSON.stringify(x.status))
    assert.equal(afterA,'Keep','superseded old success must not apply successor candidate')
    assert.equal(x.status.decision,bSuccess?'Successor decision':'Keep','old result must not consume valid successor candidate')
  }finally {aGate.resolve();bGate.resolve();await Promise.allSettled([a,b].filter(Boolean));x.close()}
})


test('Gemini terminal eligibility stays per-query, and harmless warning does not veto normal completion', () => {
  const x = h(GeminiSession)
  try {
    const stopped = { messageId: 'stopped' }
    x.s._processJsonlLine({ type: 'message', role: 'assistant', content: footer(), delta: true }, stopped)
    x.s._processJsonlLine({ type: 'error', severity: 'warning', message: 'Agent execution blocked: policy denied' }, stopped)
    x.s._processJsonlLine({ type: 'result', status: 'success', stats: {} }, stopped)
    assert.equal(x.status.decision, 'Keep')
    const next = { messageId: 'normal' }
    x.s._processJsonlLine({ type: 'message', role: 'assistant', content: footer('New choice'), delta: true }, next)
    x.s._processJsonlLine({ type: 'error', severity: 'warning', message: 'Transient retry recovered' }, next)
    x.s._processJsonlLine({ type: 'result', status: 'success', stats: {} }, next)
    assert.equal(x.status.decision, 'New choice', 'fresh context has no stale terminal flag')
  } finally { x.close() }
})

test('late old SDK assistant output and error cannot replace or discard a successor candidate', async () => {
  const x = h(SdkSession), releaseA = deferred(), releaseB = deferred(), aSeen = deferred(), bSeen = deferred()
  let a, b
  try {
    x.s._processReady = true
    x.s._fetchSupportedModels = () => {}
    let ordinal = 0
    x.s._callQuery = () => {
      const index = ++ordinal
      const iterator = (async function* () {
        yield text(index === 1 ? 'A starts' : footer('Successor choice'))
        ;(index === 1 ? aSeen : bSeen).resolve()
        await (index === 1 ? releaseA : releaseB).promise
        if (index === 1) {
          yield text(footer())
          throw new Error('Old query failed after successor output')
        }
        yield result()
      })()
      iterator.interrupt = async () => {}
      return iterator
    }
    a = x.s.sendMessage('A')
    await aSeen.promise
    x.s._handleStreamStall(x.s._currentMessageId, false)
    b = x.s.sendMessage('B')
    await bSeen.promise
    releaseA.resolve()
    await a
    assert.equal(x.status.decision, 'Keep')
    assert.equal(x.m.getSession('s')._pendingDeclaredStatus.decision, 'Successor choice')
    assert.equal(x.s._isBusy, true)
    releaseB.resolve()
    await b
    assert.equal(x.status.decision, 'Successor choice')
  } finally { releaseA.resolve(); releaseB.resolve(); await Promise.allSettled([a, b].filter(Boolean)); x.close() }
})

test('an old SDK result before successor output cannot commit the old candidate after the successor starts', async () => {
  const x = h(SdkSession), releaseA = deferred(), releaseBText = deferred(), releaseBResult = deferred(), aSeen = deferred(), bStarted = deferred(), bSeen = deferred()
  let a, b
  try {
    x.s._processReady = true
    x.s._fetchSupportedModels = () => {}
    let ordinal = 0
    x.s._callQuery = () => {
      const index = ++ordinal
      const iterator = (async function* () {
        if (index === 1) {
          yield text(footer())
          aSeen.resolve()
          await releaseA.promise
        } else {
          bStarted.resolve()
          await releaseBText.promise
          yield text(footer('Successor choice'))
          bSeen.resolve()
          await releaseBResult.promise
        }
        yield result()
      })()
      iterator.interrupt = async () => {}
      return iterator
    }
    a = x.s.sendMessage('A'); await aSeen.promise
    x.s._handleStreamStall(x.s._currentMessageId, false)
    b = x.s.sendMessage('B'); await bStarted.promise
    releaseA.resolve(); await a
    assert.equal(x.status.decision, 'Keep')
    assert.equal(x.m.getSession('s')._pendingDeclaredStatus, undefined)
    releaseBText.resolve(); await bSeen.promise
    assert.equal(x.status.decision, 'Keep')
    releaseBResult.resolve(); await b
    assert.equal(x.status.decision, 'Successor choice')
  } finally { releaseA.resolve(); releaseBText.resolve(); releaseBResult.resolve(); await Promise.allSettled([a, b].filter(Boolean)); x.close() }
})

test('SDK rechecks ownership after awaiting a context snapshot, preserving the successor busy state and accounting', async () => {
  const x = h(SdkSession), snapshotStarted = deferred(), releaseSnapshot = deferred(), bSeen = deferred(), releaseB = deferred()
  let a, b
  try {
    x.s._processReady = true
    x.s._fetchSupportedModels = () => {}
    let queries = 0, snapshots = 0
    x.s._getContextUsageSnapshot = async () => {
      if (++snapshots === 1) { snapshotStarted.resolve(); await releaseSnapshot.promise }
      return null
    }
    x.s._callQuery = () => {
      const index = ++queries
      const iterator = (async function* () {
        yield text(index === 1 ? 'A completes' : footer('Successor choice'))
        if (index === 2) { bSeen.resolve(); await releaseB.promise }
        yield result({ total_cost_usd: index / 100 })
      })()
      iterator.interrupt = async () => {}
      return iterator
    }
    a = x.s.sendMessage('A'); await snapshotStarted.promise
    x.s._handleHardTimeout(x.s._currentMessageId, false)
    b = x.s.sendMessage('B'); await bSeen.promise
    releaseSnapshot.resolve(); await a
    assert.equal(x.s._isBusy, true, 'an old finish must not clear the successor after an await')
    assert.equal(x.status.decision, 'Keep')
    assert.equal(x.m.getSession('s')._pendingDeclaredStatus.decision, 'Successor choice')
    releaseB.resolve(); await b
    assert.equal(x.status.decision, 'Successor choice')
    assert.equal(x.m.getSession('s').cumulativeUsage.turnsBilled, 2, 'old accounting result remains recorded')
    assert.equal(x.m.getSession('s').cumulativeUsage.costUsd, 0.03)
  } finally { releaseSnapshot.resolve(); releaseB.resolve(); await Promise.allSettled([a, b].filter(Boolean)); x.close() }
})
