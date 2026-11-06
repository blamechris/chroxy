import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { CliSession } from '../src/cli-session.js'
import { CodexSession } from '../src/codex-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { GeminiSession } from '../src/gemini-session.js'
import { extractDeclaredStatus } from '../src/declared-status.js'
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
async function sdk(events) {
  const x=h(SdkSession)
  x.s._processReady=true;x.s._fetchSupportedModels=()=>{}
  x.s._callQuery=()=> (async function*(){yield* events})()
  await x.s.sendMessage('review status')
  return x
}
const text = t=>({type:'assistant',message:{content:[{type:'text',text:t}]}})
const result=(extra={})=>({type:'result',subtype:'success',num_turns:1,total_cost_usd:0,duration_ms:1,usage:{},...extra})
const streamed=t=>[
  {type:'stream_event',event:{type:'message_start',message:{id:'m'}}},
  {type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text'}}},
  {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:t}}},
  text(t),
  {type:'stream_event',event:{type:'message_stop'}},
]
test('literal task identifiers are retained',()=>{
  assert.equal(extractDeclaredStatus(footer('none','Inspect __tests__/foo__bar.js (reviewer)')).next,'Inspect __tests__/foo__bar.js (reviewer)')
})
test('a legitimate final status following work on a template is accepted',()=>{
  assert.equal(extractDeclaredStatus('Updated the deployment template.\n\n'+footer('Pick region'))?.decision,'Pick region')
})
test('a narrative historic declaration is ignored',()=>{
  assert.equal(extractDeclaredStatus('The previous response ended with the following footer:\n\n'+footer('none')),null)
})
test('SDK nonstream success control clears',async()=>{
  const x=await sdk([text(footer()),result()]);try{assert.equal(x.status.decision,undefined)}finally{x.close()}
})
test('SDK nonstream error result preserves decision',async()=>{
  const x=await sdk([text(footer()),result({subtype:'error_during_execution',is_error:true,stop_reason:'end_turn'})]);try{assert.equal(x.status.decision,'Keep')}finally{x.close()}
})
test('SDK two assistant response fragments cannot synthesize footer',async()=>{
  const f=footer(),split=f.indexOf('**Next:**')
  const x=await sdk([...streamed(f.slice(0,split)),...streamed(f.slice(split)),result()]);try{assert.equal(x.status.decision,'Keep')}finally{x.close()}
})
test('SDK earlier unmatched fence cannot hide later valid response',async()=>{
  const x=await sdk([...streamed('An intermediate draft:\n```md\n'),...streamed(footer('New decision')),result()]);try{assert.equal(x.status.decision,'New decision')}finally{x.close()}
})
for(const stream of [false,true]) test(`CLI ${stream?'streamed':'fallback'} error result preserves decision`,()=>{
  const x=h(CliSession)
  try{
    x.s._currentMessageId='m';x.s._currentCtx={hasStreamStarted:stream}
    if(stream){x.s.emit('stream_start',{messageId:'m'});x.s.emit('stream_delta',{messageId:'m',delta:footer()})}
    x.s._handleEvent(result({subtype:'error_during_execution',is_error:true,stop_reason:'end_turn',result:footer()}))
    assert.equal(x.status.decision,'Keep')
  }finally{x.close()}
})
test('Codex app-server later complete item without deltas invalidates intermediate declaration',()=>{
  const x=h(CodexAppServerSession)
  try{
    x.s._activeTurn={messageId:'m',turnId:'t',didStreamStart:false}
    x.s._onNotification({method:'item/completed',params:{item:{type:'agentMessage',id:'i1',text:footer()}}})
    x.s._onNotification({method:'item/completed',params:{item:{type:'agentMessage',id:'i2',text:'Final answer without a declaration'}}})
    x.s._onNotification({method:'turn/completed',params:{turn:{id:'t',status:'completed',durationMs:1}}})
    assert.equal(x.status.decision,'Keep')
  }finally{x.close()}
})
test('Codex exec two complete items cannot synthesize footer',()=>{
  const x=h(CodexSession),ctx={messageId:'m',didStreamStart:false},f=footer(),split=f.indexOf('**Next:**')
  try{
    x.s._processJsonlLine({type:'item.completed',item:{id:'i1',type:'agent_message',text:f.slice(0,split)}},ctx)
    x.s._processJsonlLine({type:'item.completed',item:{id:'i2',type:'agent_message',text:f.slice(split)}},ctx)
    x.s._processJsonlLine({type:'turn.completed',usage:{}},ctx)
    assert.equal(x.status.decision,'Keep')
  }finally{x.close()}
})
test('explicit truncated result preserves control',async()=>{
  const x=await sdk([...streamed(footer()),result({stop_reason:'max_tokens'})]);try{assert.equal(x.status.decision,'Keep')}finally{x.close()}
})
test('current Gemini CLI stream-json wire produces declared status',()=>{
  const x=h(GeminiSession),ctx={messageId:'m',didStreamStart:false}
  try{
    x.s._processJsonlLine({type:'message',timestamp:'2026-11-06T00:00:00.000Z',role:'assistant',content:footer('New Gemini decision'),delta:true},ctx)
    x.s._processJsonlLine({type:'result',timestamp:'2026-11-06T00:00:00.001Z',status:'success',stats:{}},ctx)
    assert.equal(x.status.decision,'New Gemini decision')
  }finally{x.close()}
})
test('SDK final response text cannot be suppressed by prior streamed response',async()=>{
  const x=await sdk([...streamed(footer()),text('Final answer without declaration'),result()]);try{assert.equal(x.status.decision,'Keep')}finally{x.close()}
})
test('SDK one nonstream assistant response with two text blocks is parsed as a whole',async()=>{
  const f=footer('New decision'),split=f.indexOf('**Next:**')
  const x=await sdk([{type:'assistant',message:{content:[{type:'text',text:f.slice(0,split)},{type:'text',text:f.slice(split)}]}},result()]);try{assert.equal(x.status.decision,'New decision')}finally{x.close()}
})


test('literal payload identifiers survive structural Markdown in every footer field', () => {
  const f = footer('Inspect __tests__/foo__bar.js', 'Open **literal** and __tests__/foo__bar.js')
    .replace('✅ Verified', '✅ Updated __tests__/foo__bar.js')
    .replace('⛔ none', '⛔ Waiting for __tests__/foo__bar.js')
  const declaration = extractDeclaredStatus(f)
  assert.equal(declaration.summary, 'Updated __tests__/foo__bar.js')
  assert.equal(declaration.blockedOn, 'Waiting for __tests__/foo__bar.js')
  assert.equal(declaration.decision, 'Inspect __tests__/foo__bar.js')
  assert.equal(declaration.next, 'Open **literal** and __tests__/foo__bar.js')
})

test('focused introductions reject examples and history while ordinary work remains current', () => {
  for (const intro of ['Updated the deployment template.', 'Verified the example project.', 'Fixed the literal parser format.']) {
    assert.equal(extractDeclaredStatus(intro + '\n\n' + footer('Pick region'))?.decision, 'Pick region')
  }
  for (const intro of ['Example:', 'Template footer:', 'Here is an example footer:', 'The previous response ended with the following footer:', 'Old footer:', 'Here is the previous footer:']) {
    assert.equal(extractDeclaredStatus(intro + '\n\n' + footer()), null, intro)
  }
})

for (const status of ['error', 'cancelled', 'unknown']) test(`Gemini current wire ${status} result preserves pending decision`, () => {
  const x = h(GeminiSession), ctx = { messageId: 'gemini', didStreamStart: false }
  try {
    x.s._processJsonlLine({ type: 'message', role: 'assistant', delta: true, content: footer() }, ctx)
    x.s._processJsonlLine({ type: 'result', status, error: { type: 'ERROR', message: 'Incomplete' }, stats: {} }, ctx)
    assert.equal(x.status.decision, 'Keep')
  } finally { x.close() }
})

test('Gemini current wire separates responses at tool boundaries and ignores user content', () => {
  const x = h(GeminiSession), ctx = { messageId: 'gemini', didStreamStart: false }
  try {
    x.s._processJsonlLine({ type: 'message', role: 'assistant', delta: true, content: footer() }, ctx)
    x.s._processJsonlLine({ type: 'tool_use', tool_id: 'read', tool_name: 'read_file', parameters: {} }, ctx)
    x.s._processJsonlLine({ type: 'tool_result', tool_id: 'read', status: 'success', output: 'data' }, ctx)
    x.s._processJsonlLine({ type: 'message', role: 'user', content: footer(), delta: true }, ctx)
    x.s._processJsonlLine({ type: 'message', role: 'assistant', delta: true, content: 'Final answer with no declaration' }, ctx)
    x.s._processJsonlLine({ type: 'result', status: 'success', stats: {} }, ctx)
    assert.equal(x.status.decision, 'Keep')
    assert.equal(ctx.assistantResponseText, undefined)
  } finally { x.close() }
})

test('Gemini declaration accumulation is bounded and never parses a truncated candidate', () => {
  const x = h(GeminiSession), ctx = { messageId: 'gemini', didStreamStart: false }
  try {
    for (const content of [footer(), 'x'.repeat(131073), footer()]) x.s._processJsonlLine({ type: 'message', role: 'assistant', delta: true, content }, ctx)
    assert.equal(ctx.assistantResponseText, null)
    x.s._processJsonlLine({ type: 'result', status: 'success', stats: {} }, ctx)
    assert.equal(x.status.decision, 'Keep')
  } finally { x.close() }
})

for (const stream of [false, true]) test(`CLI ${stream ? 'streamed' : 'fallback'} successful result is eligible`, () => {
  const x = h(CliSession)
  try {
    x.s._currentMessageId = 'cli'
    x.s._currentCtx = { hasStreamStarted: stream, didStreamText: stream }
    if (stream) x.s._handleEvent(text(footer('CLI choice')))
    x.s._handleEvent(result({ result: footer('CLI choice') }))
    assert.equal(x.status.decision, 'CLI choice')
  } finally { x.close() }
})


test('a malformed later complete SDK response invalidates an intermediate declaration', async () => {
  const x = await sdk([text(footer()), { type: 'assistant', message: { content: null } }, result()])
  try { assert.equal(x.status.decision, 'Keep') } finally { x.close() }
})

test('empty final Codex exec response invalidates without emitting an invalid display delta', () => {
  const x = h(CodexSession), ctx = { messageId: 'codex', didStreamStart: false }
  try {
    x.s._processJsonlLine({ type: 'item.completed', item: { type: 'agent_message', id: 'first', text: footer() } }, ctx)
    x.s._processJsonlLine({ type: 'item.completed', item: { type: 'agent_message', id: 'last', text: '' } }, ctx)
    x.s._processJsonlLine({ type: 'turn.completed', usage: {} }, ctx)
    assert.equal(x.status.decision, 'Keep')
  } finally { x.close() }
})
