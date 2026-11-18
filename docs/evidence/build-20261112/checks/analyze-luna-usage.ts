import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = path.resolve(process.argv[2] ?? process.cwd())
const { summarizeSessionMetrics } = await import(pathToFileURL(path.join(repo, 'scripts/build-benchmark-metrics.ts')).href)
const evidence = path.join(repo, 'docs/evidence/build-20261112/luna-corrected')
const arms = fs.readdirSync(evidence).filter((name) => fs.existsSync(path.join(evidence, name, 'messages.json'))).sort()
const result: any = { source: 'docs/evidence/build-20261112/luna-corrected', accounting: 'scripts/build-benchmark-metrics.ts summarizeSessionMetrics; latest message by sessionID+info.id', arms: [] }

function readJson(file: string): any { return JSON.parse(fs.readFileSync(file, 'utf8')) }
function latest(messages: any[]): any[] {
  const m = new Map<string, any>()
  for (const row of messages) if (row?.sessionID && row?.info?.id != null) m.set(JSON.stringify([row.sessionID, row.info.id]), row)
  return [...m.values()]
}
function metrics(sessions: any[], messages: any[]): any {
  const x = summarizeSessionMetrics(sessions, messages)
  return { sessions: x.sessions, assistantTurns: x.assistantTurns, usage: x.usage, cost: x.cost, toolCalls: x.tools.total, toolStatus: { completed: x.tools.completed, error: x.tools.error, pending: x.tools.pending }, toolsByName: x.tools.byName, repeatedExactToolInputs: x.repeatedExactToolInputs, skillLoads: x.skillLoads, algTools: x.algTools, observedErrors: x.observedErrors }
}
for (const arm of arms) {
  const dir = path.join(evidence, arm)
  const rawSessions = readJson(path.join(dir, 'sessions.json'))
  const sessions = Array.isArray(rawSessions) ? rawSessions : rawSessions.sessions
  const messages = latest(readJson(path.join(dir, 'messages.json')))
  const titles = new Map(sessions.map((s: any) => [s.id, s.title ?? s.id]))
  const root = sessions.find((s: any) => !s.parentID)
  const rootIds = new Set(sessions.filter((s: any) => !s.parentID).map((s: any) => s.id))
  const buckets = new Map<string, any[]>()
  for (const m of messages) {
    const title = String(titles.get(m.sessionID) ?? '')
    const match = title.match(/\/([^/]+)\/a(\d+)/)
    const key = rootIds.has(m.sessionID) ? 'primary' : match ? `child:${match[1]}:attempt${match[2]}` : `child:${m.info?.agent ?? 'unknown'}`
    const list = buckets.get(key) ?? []; list.push(m); buckets.set(key, list)
  }
  const sessionById = new Map(sessions.map((s: any) => [s.id, s]))
  const agentAttributions = [...buckets.entries()].map(([label, rows]) => {
    const ids = [...new Set(rows.map((m: any) => m.sessionID))]
    return { label, sessions: ids.map((id) => ({ id, parentID: sessionById.get(id)?.parentID, title: titles.get(id) })), metrics: metrics(sessions.filter((s: any) => ids.includes(s.id)), rows) }
  })
  const eventsFile = path.join(dir, 'events.jsonl')
  const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : []
  const boundary = events.filter((e: any) => ['start', 'complete', 'stopped', 'restart_stop', 'trial_error'].includes(e.event)).map((e: any) => ({ at: e.at, phase: e.phase, event: e.event, reason: e.reason }))
  const marks = events.filter((e: any) => e.phase && e.event === 'start').map((e: any) => ({ phase: e.phase, start: Date.parse(e.at) })).sort((a: any,b: any) => a.start-b.start)
  const phaseRows: any[] = []
  for (let i=0;i<marks.length;i++) {
    const start = marks[i].start
    const end = marks[i+1]?.start ?? Infinity
    const phaseName = marks[i].phase
    const rows = messages.filter((m: any) => {
      const created = Number(m.info?.time?.created)
      if (!Number.isFinite(created)) return false
      if (created < start || created >= end) return false
      return true
    })
    phaseRows.push({ phase: phaseName, metrics: metrics(sessions.filter((s:any)=>rows.some((m:any)=>m.sessionID===s.id)), rows) })
  }
  const compactRows = messages.filter((m:any)=>m.info?.agent==='compaction')
  const reads: any[] = []
  for (const m of messages) for (let i=0;i<(m.parts??[]).length;i++) {
    const part=m.parts[i]
    if(part?.type!=='tool'||part.tool!=='read') continue
    const input=part.state?.input??part.input??{}
    const file=typeof input==='string'?input:(input.filePath??input.path??input.file??JSON.stringify(input))
    reads.push({session:m.sessionID, agent:m.info?.agent, file:String(file), status:part.state?.status??'unknown'})
  }
  const readCounts = new Map<string, {calls:number; sessions:Set<string>; agents:Set<string>; statuses:Record<string,number>}>()
  for(const r of reads){const v=readCounts.get(r.file)??{calls:0,sessions:new Set<string>(),agents:new Set<string>(),statuses:{}};v.calls++;v.sessions.add(r.session);if(r.agent)v.agents.add(r.agent);v.statuses[r.status]=(v.statuses[r.status]??0)+1;readCounts.set(r.file,v)}
  const duplicateReads=[...readCounts.entries()].filter(([,v])=>v.calls>1).map(([file,v])=>({file,calls:v.calls,sessions:v.sessions.size,agents:[...v.agents],status:v.statuses,interpretation:v.sessions.size>1?'cross-session reread; compatible with independent verification, not automatically redundant':'same-session exact-path reread'}))
  const summary = metrics(sessions, messages)
  result.arms.push({ arm, outcome: readJson(path.join(dir,'result.json')).status ?? readJson(path.join(dir,'result.json')).outcome ?? null, recovery: readJson(path.join(dir,'result.json')).recovery, boundary, summary, agentAttributions, phases: phaseRows, compactionAssistantTurns: compactRows.length, readCalls: reads.length, duplicateReads })
}
function compact(m: any): any { const c=m.usage.components; return { turns:{total:m.assistantTurns.total,finished:m.assistantTurns.finished,error:m.assistantTurns.error},tokens:{input:c.input.reportedTotal,output:c.output.reportedTotal,reasoning:c.reasoning.reportedTotal,cacheRead:c.cacheRead.reportedTotal,cacheWrite:c.cacheWrite.reportedTotal,totalReported:m.usage.totalReportedTokens},costReported:m.cost.reportedTotal,tools:m.toolCalls,skills:m.skillLoads,algTools:m.algTools } }
console.log(JSON.stringify(result.arms.map((a:any)=>({arm:a.arm,outcome:a.outcome,summary:compact(a.summary),agents:a.agentAttributions.map((x:any)=>({label:x.label,tokens:x.metrics.usage.totalReportedTokens,input:x.metrics.usage.components.input.reportedTotal,output:x.metrics.usage.components.output.reportedTotal,cacheRead:x.metrics.usage.components.cacheRead.reportedTotal})),phases:a.phases.map((x:any)=>({phase:x.phase,tokens:x.metrics.usage.totalReportedTokens,turns:x.metrics.assistantTurns.total})),readCalls:a.readCalls,duplicateReads:a.duplicateReads.map((x:any)=>({file:path.basename(x.file),calls:x.calls,sessions:x.sessions,interpretation:x.interpretation}))})),null,2))
