import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:net"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, copyFileSync, unlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { Database } from "bun:sqlite"
import type { SessionSummarizeResponses } from "@opencode-ai/sdk/client"
import { BENCHMARK_CASES, scoreBenchmarkCase, scoreBenchmarkPreparation } from "./build-benchmark-fixtures.ts"
import { summarizeSessionMetrics } from "./build-benchmark-metrics.ts"
import { sendBenchmarkPrompt } from "./build-benchmark-transport.ts"
import { hostRetentionEvents, measureBuildBenchmarkRetention } from "./build-benchmark-retention.ts"
import { summarizeIssuedArms, finalCensus, compactionReceipt, compactionIsQualified, eligibility, benchmarkObservedStop, reconcileHostCensus, type BenchmarkArm, type BenchmarkTrack, type PairIssue } from "./build-benchmark-protocol.ts"
import { computeAlgSourceIdentity } from "../src/source-identity.ts"
import { seedVerificationHostDependencies } from "./verification-host-dependencies.ts"
import { verificationPluginConfiguration, realUserGlobalConfigRoots, snapshotGlobalOpenCodeConfig, stopCapturedProcess } from "./live-verify.ts"
import { benchmarkTaskPrompt, collectHardProject, collectHardRunProgress, hardBenchmarkIdentity, HARD_INTERPRETATION, HARD_ISOLATION, needsHardService, scoreHardDevelopmentFixture,
  prepareBenchmarkWorkload, readHardQualification, scheduleBenchmarkWorkload, terminalHardRows, type WorkloadOptions } from "./hard-benchmark-cohort.ts"
import { openHardFixtureService } from "./hard-benchmark-fixtures.ts"
import type { HardBenchmarkService } from "./hard-benchmark-service.ts"
import { startHardBenchmarkHost } from "./hard-benchmark-host.ts"
import { sha256Json } from "../src/persistence.ts"

/** Local feasibility pilot. JSON config supplies paths/provider, never credential values. */
export interface Config extends WorkloadOptions {
  outputRoot: string; hostExecutable: string; providerID: string; modelID: string;
  provider: Record<string, unknown>; authFile?: string; preflightOnly?: boolean; caseIds?: string[]; track?: BenchmarkTrack;
  ollama?: { executable: string; models: string; model: string };
}
const LIMITS = { trialMs: 480_000, assistantTurns: 40, reportedComponents: 200_000, outputTokens: 4096, suiteMs: 55*60_000 }
const USAGE_MONITORS = { reportedTokens: LIMITS.reportedComponents, reportedCostPerSuite: 5, enforcement: "component_cutoff_is_polled_with_overshoot_cost_is_telemetry_only_not_invoice_ceiling" }
const TARGETED = "Additional targeted falsification mandate: assess the original user deliverable, not whether a review memo sounds correct. Seek a concrete counterexample involving distinct entity counts, joins, UTC interval boundaries, denominators or conflicting sources when relevant. Read the actual artifact and supplied source. Preserve uncertainty when sources disagree. A useful criticism must cite the violated original criterion. Do not invent defects or new requirements."
const COMMON = "Work only in this fixture workspace. Do not access credentials, change global configuration, install packages, or use network services. The available Node runtime and fixture files are sufficient. Preserve supplied evidence, skills and visible tests. Finish the requested artifact and explain the result honestly."
const sha=(value:Buffer|string)=>createHash("sha256").update(value).digest("hex")
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const port=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return port as number}
function write(path:string,value:unknown){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2)+"\n")}
const CENSUS_LIMITS={perRequestMs:5_000,baseOverallMs:4_000,perSessionMs:1_500,maxOverallMs:25_000,activeOverallMs:25_000,finalFirstMs:51_000,finalRetryMs:51_000}
type CensusApi=(path:string,body?:unknown,ms?:number,signal?:AbortSignal)=>Promise<any>
type CensusProgress={listedSessions:number;completedHistories:number;failedEndpoint:string|null;overallBudgetMs:number|null;elapsedMs:number;complete:boolean}
export class SessionCensusError extends Error {
  constructor(readonly census:CensusProgress,reason:string){super(reason);this.name="SessionCensusError"}
}
async function censusRequest(api:CensusApi,path:string,deadline:number,signal?:AbortSignal,now=Date.now){
  signal?.throwIfAborted()
  const remaining=Math.floor(deadline-now())
  if(remaining<=0)throw new Error("census_overall_deadline_exceeded")
  const budget=Math.min(CENSUS_LIMITS.perRequestMs,remaining),controller=new AbortController()
  const abort=()=>controller.abort(signal?.reason)
  signal?.addEventListener("abort",abort,{once:true})
  const timer=setTimeout(()=>controller.abort(new DOMException("census request timed out","TimeoutError")),budget)
  let onAbort:()=>void=()=>{}
  try{
    return await Promise.race([api(path,undefined,budget,controller.signal),new Promise<never>((_,reject)=>{
      onAbort=()=>reject(controller.signal.reason)
      controller.signal.addEventListener("abort",onAbort,{once:true})
      if(controller.signal.aborted)onAbort()
    })])
  }finally{
    clearTimeout(timer);signal?.removeEventListener("abort",abort)
    controller.signal.removeEventListener("abort",onAbort);controller.abort()
  }
}
/** Complete bounded API census. The same endpoints and completeness rule apply to every arm. */
export async function collectSessionCensus(options:{api:CensusApi;sessions:Map<string,any>;messages:Map<string,any>;phase:string;benchmarkDeadline?:number;overallBudgetMs?:number;signal?:AbortSignal;now?:()=>number}):Promise<{metrics:ReturnType<typeof summarizeSessionMetrics>;coverage:CensusProgress}>{
  const now=options.now??Date.now,start=now(),progress:CensusProgress={listedSessions:0,completedHistories:0,failedEndpoint:null,overallBudgetMs:null,elapsedMs:0,complete:false}
  const initialDeadline=options.overallBudgetMs===undefined?Infinity:start+options.overallBudgetMs
  progress.overallBudgetMs=Number.isFinite(initialDeadline)?Math.max(0,initialDeadline-start):CENSUS_LIMITS.baseOverallMs
  const deadlineFor=(budget:number)=>Math.min(start+budget,options.benchmarkDeadline??Infinity,initialDeadline)
  let deadline=deadlineFor(CENSUS_LIMITS.baseOverallMs)
  const fail=(endpoint:string,reason:string):never=>{progress.failedEndpoint=endpoint;progress.elapsedMs=Math.max(0,now()-start);throw new SessionCensusError(progress,reason)}
  const request=async(path:string,requestDeadline:number)=>{
    try{return await censusRequest(options.api,path,requestDeadline,options.signal,now)}
    catch(error){fail(path,error instanceof Error?error.name||"census_request_failed":"census_request_failed")}
  }
  const rows=await request("/session?limit=10000",deadline)
  if(!Array.isArray(rows)||rows.length>=10_000)fail("/session?limit=10000","session_census_invalid_or_at_limit")
  progress.listedSessions=rows.length
  if(rows.some((row:any)=>typeof row?.id!=="string"||!row.id)||new Set(rows.map((row:any)=>row.id)).size!==rows.length)fail("/session?limit=10000","session_census_invalid_or_duplicate_ids")
  const volumeBudget=Math.min(CENSUS_LIMITS.maxOverallMs,CENSUS_LIMITS.baseOverallMs+rows.length*CENSUS_LIMITS.perSessionMs)
  deadline=deadlineFor(volumeBudget);progress.overallBudgetMs=Math.max(0,deadline-start)
  let next=0,failed=false
  const worker=async()=>{while(!failed){const index=next++;if(index>=rows.length)return;const s=rows[index];if(typeof s?.id!=="string"||!s.id){failed=true;fail("/session?limit=10000","session_census_invalid_id")}
    options.sessions.set(s.id,s)
    const endpoint=`/session/${s.id}/message?limit=10000`
    try{
      const history=await request(endpoint,deadline)
      if(!Array.isArray(history)){failed=true;fail(endpoint,"message_census_invalid")}
      if(history.length>=10_000){failed=true;fail(endpoint,"message_census_invalid_or_at_limit")}
      if(history.some((message:any)=>typeof message?.info?.id!=="string"||!message.info.id||(message.sessionID!==undefined&&message.sessionID!==s.id))){failed=true;fail(endpoint,"message_census_invalid_rows")}
      for(const m of history){const prior=options.messages.get(s.id+":"+m.info.id);options.messages.set(s.id+":"+m.info.id,{sessionID:s.id,...m,benchmarkPhase:prior?.benchmarkPhase??options.phase})}
      progress.completedHistories++
    }catch(error){failed=true;throw error}
  }}
  const workerCount=Math.min(3,rows.length)
  const outcomes=await Promise.allSettled(Array.from({length:workerCount},worker))
  const rejected=outcomes.find((outcome):outcome is PromiseRejectedResult=>outcome.status==="rejected")
  if(rejected){if(rejected.reason instanceof SessionCensusError)throw rejected.reason;fail(progress.failedEndpoint??"/session/message","census_worker_failed")}
  progress.complete=progress.completedHistories===progress.listedSessions
  progress.elapsedMs=Math.max(0,now()-start)
  if(!progress.complete)fail(progress.failedEndpoint??"/session/message","census_incomplete")
  return{metrics:summarizeSessionMetrics([...options.sessions.values()],[...options.messages.values()]),coverage:progress}
}

/** A final pass owns its polls: cancel and settle them before a retry or host stop. */
export async function collectFinalSessionCensus(options:{api:CensusApi;sessions:Map<string,any>;messages:Map<string,any>;phase:string;graceMs:number;pollMs?:number}):Promise<Awaited<ReturnType<typeof finalCensus>> & {
  coverage:CensusProgress|null;failure?:{endpoint:string|null;reason:string}
}>{
  const deadline=Date.now()+options.graceMs,controller=new AbortController()
  let coverage:CensusProgress|null=null,failure:{endpoint:string|null;reason:string}|null=null
  const poll=async()=>{
    const started=Date.now()
    try{
      const captured=await collectSessionCensus({...options,benchmarkDeadline:deadline,signal:controller.signal})
      const current=captured.coverage
      let status:any
      try{
        status=await censusRequest(options.api,"/session/status",Math.min(deadline,started+(current.overallBudgetMs??0)),controller.signal)
        if(!status||typeof status!=="object"||Array.isArray(status))throw new Error("status_census_invalid")
      }catch(error){
        current.failedEndpoint="/session/status";current.complete=false;current.elapsedMs=Date.now()-started
        throw new SessionCensusError(current,error instanceof Error?error.message:"census_request_failed")
      }
      coverage={...current,elapsedMs:Date.now()-started};failure=null
      const active=[...options.sessions.keys()].filter(id=>status[id]&&status[id].type!=="idle").length
      const pending=[...options.messages.values()].some(m=>m.parts?.some((p:any)=>p.type==="tool"&&["pending","running"].includes(p.state?.status)))
      return{metrics:captured.metrics,activeSessions:active,pendingWork:pending,quiescent:current.complete&&active===0&&!pending}
    }catch(error){
      coverage=error instanceof SessionCensusError?error.census:null
      failure={endpoint:coverage?.failedEndpoint??null,reason:error instanceof Error?error.message:"census_request_failed"}
      throw error
    }
  }
  let inFlight:ReturnType<typeof poll>|undefined
  const timer=setTimeout(()=>controller.abort(new DOMException("final census grace expired","TimeoutError")),options.graceMs)
  let receipt:Awaited<ReturnType<typeof finalCensus>>
  try{
    receipt=await finalCensus({graceMs:options.graceMs,pollMs:options.pollMs??250,census:()=>{
      controller.signal.throwIfAborted()
      inFlight=poll();return inFlight
    }})
  }finally{
    clearTimeout(timer);controller.abort()
    if(inFlight)await Promise.allSettled([inFlight])
  }
  return{...receipt,coverage,...(failure?{failure}:{})}
}
type Tracked = ReturnType<typeof launch>
function launch(exe:string,args:string[],cwd:string,env:NodeJS.ProcessEnv){
  const child=spawn(exe,args,{cwd,env,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]})
  let stdout="",stderr="",closed=false,code:number|null=null
  child.stdout.on("data",b=>stdout=(stdout+b.toString()).slice(-131072));child.stderr.on("data",b=>stderr=(stderr+b.toString()).slice(-131072))
  child.on("close",c=>{closed=true;code=c});child.on("error",()=>closed=true)
  return {child,stdout:()=>stdout,stderr:()=>stderr,exit:()=>({observed:closed||child.exitCode!==null,code:code??child.exitCode,signal:child.signalCode})}
}
function isolatedEnv(root:string){
  const env:NodeJS.ProcessEnv={}
  for(const key of ["PATH","SystemRoot","WINDIR","ComSpec","PATHEXT"])if(process.env[key])env[key]=process.env[key]
  for(const sub of ["home","config","data","cache","state","tmp"])mkdirSync(join(root,sub),{recursive:true})
  return Object.assign(env,{HOME:join(root,"home"),USERPROFILE:join(root,"home"),APPDATA:join(root,"home/AppData/Roaming"),LOCALAPPDATA:join(root,"home/AppData/Local"),
    XDG_CONFIG_HOME:join(root,"config"),XDG_DATA_HOME:join(root,"data"),XDG_CACHE_HOME:join(root,"cache"),XDG_STATE_HOME:join(root,"state"),
    TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TMPDIR:join(root,"tmp"),OPENCODE_CONFIG:join(root,"opencode.json"),OPENCODE_ALG_CONFIG:join(root,"alg-options.json"),
    OPENCODE_DISABLE_PROJECT_CONFIG:"1",OPENCODE_DISABLE_CLAUDE_CODE:"1",OPENCODE_DISABLE_CLAUDE_CODE_SKILLS:"1",
    OPENCODE_DISABLE_AUTOUPDATE:"1",OPENCODE_DISABLE_TELEMETRY:"1",DO_NOT_TRACK:"1",NO_COLOR:"1"})
}
function files(root:string):Array<{path:string;bytes:number;sha256:string}>{
  const result:Array<{path:string;bytes:number;sha256:string}>=[]
  const walk=(dir:string,prefix:string)=>{for(const e of readdirSync(dir,{withFileTypes:true})){if(e.name===".git"||e.name==="node_modules")continue;const p=join(dir,e.name),rel=prefix+e.name;if(e.isDirectory())walk(p,rel+"/");else if(e.isFile()){const b=readFileSync(p);result.push({path:rel,bytes:b.length,sha256:sha(b)})}}}
  walk(root,"");return result
}

export function initializeBenchmarkWorkspaceGit(project: string): void {
  execFileSync("git", ["-c", "core.longpaths=true", "init", "-q"], { cwd: project })
  // Disposable repository only. Do not depend on or change the operator's global settings.
  execFileSync("git", ["config", "--local", "core.longpaths", "true"], { cwd: project })
  execFileSync("git", ["add", "."], { cwd: project })
  execFileSync("git", ["-c", "user.name=ALG Benchmark", "-c", "user.email=benchmark@localhost", "commit", "-qm", "Frozen synthetic task"], { cwd: project })
}

export async function runBuildBenchmark(config:Config){
  const repo=resolve(import.meta.dir,".."),root=resolve(config.outputRoot)
  const selection=prepareBenchmarkWorkload(config,BENCHMARK_CASES,LIMITS),hard=selection.workload==="hard-development",limits=selection.limits
  const selectedCases=selection.cases
  const hardIdentity=hard?hardBenchmarkIdentity(repo,selection.hardFixtures):undefined
  const hardQualification=hard?readHardQualification(resolve(config.hardQualification!),hardIdentity!,selection.hardFixtures):undefined
  const track=config.track??"default"
  if(track!=="default"&&track!=="targeted_compatibility")throw Error("track must be default or targeted_compatibility")
  if(existsSync(root))throw Error("Evidence destination exists; no implicit rerun")
  mkdirSync(root,{recursive:true})
  const initialIdentity=computeAlgSourceIdentity(repo), plugin=verificationPluginConfiguration(repo)
  const hmac=randomBytes(32), globals=realUserGlobalConfigRoots(), before=snapshotGlobalOpenCodeConfig(globals,hmac).sha256
  const secrets:string[]=[], scrub=(s:string)=>secrets.reduce((text,secret)=>text.replaceAll(secret,"[REDACTED]"),s)
  const json=(path:string,value:unknown)=>write(path,JSON.parse(scrub(JSON.stringify(value))))
  const suiteDeadline=Date.now()+limits.suiteMs
  const usageMonitors=hard?{...USAGE_MONITORS,reportedTokens:limits.reportedComponents,reportedCostPerSuite:null}:USAGE_MONITORS
  const protocol={schema:"alg-build-pilot-v1",started_at:new Date().toISOString(),source_commit:execFileSync("git",["rev-parse","HEAD"],{cwd:repo}).toString().trim(),source_sha256:initialIdentity.digest,
    harness_sha256:sha(readFileSync(import.meta.filename)),protocol_sha256:sha(readFileSync(join(repo,"scripts/build-benchmark-protocol.ts"))),fixtures_sha256:sha(readFileSync(join(repo,"scripts/build-benchmark-fixtures.ts"))),metrics_sha256:sha(readFileSync(join(repo,"scripts/build-benchmark-metrics.ts"))),transport_sha256:sha(readFileSync(join(repo,"scripts/build-benchmark-transport.ts"))),prompt_transport:"prompt_async",
    model:`${config.providerID}/${config.modelID}`,limits,preflight_only:!!config.preflightOnly,track,
    ...(hard?{workload:"hard-development",hard:{...hardIdentity,cohort_sha256:sha(readFileSync(join(repo,"scripts/hard-benchmark-cohort.ts"))),
      host_executable_sha256:sha(readFileSync(config.hostExecutable)),qualification_evidence_sha256:hardQualification!.sha256,
      order_seed:selection.orderSeed,order_algorithm:"sha256-sort-v1+alternating-arms-seed-bit",plan_sha256:selection.planSha256,
      native_compaction:selection.compaction,requested_host_compaction:false,
      service_instruction_exception:"Only the supplied per-arm fixture HTTP endpoint on 127.0.0.1 via Node fetch; no other network services.",
      isolation:HARD_ISOLATION,confirmation_qualified:false,interpretation:HARD_INTERPRETATION}}:{}),
    pairs:[] as Array<PairIssue & {order:BenchmarkArm[]}>,
    cases:selectedCases.map(c=>({id:c.id,criteria:c.criteria,initialPrompt:c.initialPrompt,followupPrompt:c.followupPrompt??null,fixture_files:Object.entries(c.files).map(([path,text])=>({path,sha256:sha(text)}))})),
    retention_sha256:sha(readFileSync(join(repo,"scripts/build-benchmark-retention.ts"))),
    retention_boundaries_sha256:sha(readFileSync(join(repo,"scripts/build-benchmark-retention-boundaries.ts"))),
    interpretation:"Single-repeat feasibility pilot. Equal externally enforced time and per-call output limits; assistant-turn and reported-component thresholds are cumulative polling-based cutoffs subject to overshoot across root/children/maintenance/phases, not hard provider-request or invoice caps. ALG internal gates are diagnostics, never the independent oracle. Reported cost is telemetry only. Session-visible usage is not proof of complete provider billing. No superiority claim.",
    enforcement:{time:"host deadline",output:"per-call configured limit",assistantTurns:"cumulative observed cutoff; polling overshoot possible",reportedTokens:"cumulative observed component cutoff; polling overshoot possible",reportedCost:"telemetry only"},
    usage_monitors:usageMonitors,
    targeted_mandate:TARGETED,common_instruction:COMMON,unmeasured:["actual provider invoice","hidden model calls not represented by session messages","operator minutes","production MCP cost/reuse","multi-hour reliability","hardware-normalized latency"]}
  const issuedCases=scheduleBenchmarkWorkload(selection,track),pairs=issuedCases.map(({pair})=>pair)
  protocol.pairs=issuedCases.map(({pair,order})=>({...pair,arms:[...pair.arms],order}))
  const sourceUnchanged=()=>{try{return computeAlgSourceIdentity(repo).digest===initialIdentity.digest&&(!hard||
    (sha256Json(hardBenchmarkIdentity(repo,selection.hardFixtures))===sha256Json(hardIdentity)&&
    sha(readFileSync(import.meta.filename))===protocol.harness_sha256&&sha(readFileSync(join(repo,"scripts/hard-benchmark-cohort.ts")))===protocol.hard!.cohort_sha256))}catch{return false}}
  const results:any[]=pairs.flatMap(pair=>pair.arms.map(({arm})=>({pairId:pair.pairId,caseId:pair.caseId,arm,status:"issued_not_started",passed:false}))),authCopies:string[]=[];let local:Tracked|undefined,localBase:string|undefined,knownCost=0,fatal:string|null=null
  const updateResult=(pairId:string,arm:string,patch:Record<string,unknown>)=>{const row=results.find(r=>r.pairId===pairId&&r.arm===arm);if(row)Object.assign(row,patch);const pair=pairs.find(p=>p.pairId===pairId);const pairArm=pair?.arms.find(a=>a.arm===arm);if(pairArm){const status=patch.status;if(status==="running")pairArm.status="running";else if(status==="completed"||status==="preflight_passed")pairArm.status="completed";else if(status==="issued_not_started")pairArm.status="issued_not_started";else if(status!==undefined)pairArm.status="stopped"}}
  try{
    json(join(root,"plan.json"),protocol)
    if(hard){json(join(root,"hard-fixtures.json"),selection.hardFixtures);json(join(root,"hard-qualification.json"),hardQualification!.evidence)}
    if(config.ollama){
      const serviceRoot=join(root,"local-service"),env=isolatedEnv(serviceRoot),p=await freePort();localBase=`http://127.0.0.1:${p}`
      local=launch(config.ollama.executable,["serve"],serviceRoot,{...env,OLLAMA_HOST:`127.0.0.1:${p}`,OLLAMA_MODELS:config.ollama.models,OLLAMA_NO_CLOUD:"1",OLLAMA_NUM_PARALLEL:"1",OLLAMA_CONTEXT_LENGTH:"32768",OLLAMA_KEEP_ALIVE:"10m"})
      let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(localBase+"/api/tags",{signal:AbortSignal.timeout(500)})).ok}catch{}if(ready)break;await sleep(250)}
      if(!ready)throw Error("local model server unavailable")
      const metadata=await fetch(localBase+"/api/show",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:config.ollama.model})}).then(r=>r.json()) as any
      json(join(root,"local-model.json"),{details:metadata.details,capabilities:metadata.capabilities})
      if(!config.preflightOnly){const t=Date.now();const warm=await fetch(localBase+"/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:config.ollama.model,prompt:"",stream:false,keep_alive:"10m"}),signal:AbortSignal.timeout(240_000)}).then(r=>r.json()) as any;json(join(root,"preload.json"),{ms:Date.now()-t,done:warm.done,eval_count:warm.eval_count??0})}
    }
    for(const {fixture,pair,index:caseIndex,order} of issuedCases)for(const arm of order){
      if(Date.now()>=suiteDeadline){updateResult(pair.pairId,arm,{status:"stopped_before_start_suite_deadline",passed:false});continue}
      // Keep hard-arm paths equally short on Windows; case/arm identity lives in plan/result receipts.
      const directoryName=hard?`${String(caseIndex+1).padStart(2,"0")}-${arm==="build"?"bld":"alg"}`:`${caseIndex+1}-${fixture.id}-${arm}`
      const dir=join(root,directoryName),project=join(dir,"project"),authCopy=join(dir,"data/opencode/auth.json")
      const hardFixture=hard?selection.hardFixtures.find(record=>record.contestant.id===fixture.id)!:undefined
      let hardService:HardBenchmarkService|undefined,hardHost:Awaited<ReturnType<typeof startHardBenchmarkHost>>|undefined,server:Tracked|undefined
      let hostStopAttempted=false,hardCollection:ReturnType<typeof collectHardProject>|undefined,serviceStop:Promise<void>|undefined
      const serviceReceipt:any={required:!!hardFixture&&needsHardService(hardFixture),started:false,stopped:false,ledger_before:null,ledger_after:null,errors:[] as string[]}
      const stopService=()=>serviceStop??=(async()=>{
        if(hardHost){try{await hardHost.stop();serviceReceipt.stopped=true}catch(error){serviceReceipt.errors.push(`service_stop:${String(error)}`)}}
        if(hardService){try{serviceReceipt.ledger_after=await hardService.ledger()}catch(error){serviceReceipt.errors.push(`service_ledger_after:${String(error)}`)}}
      })()
      try{
      const env=isolatedEnv(dir)
      mkdirSync(project,{recursive:true});for(const [path,text] of Object.entries(fixture.files)){mkdirSync(dirname(join(project,path)),{recursive:true});writeFileSync(join(project,path),text)}
      initializeBenchmarkWorkspaceGit(project)
      seedVerificationHostDependencies(join(dir,"config/opencode"),repo)
      if(config.authFile){const saved=JSON.parse(readFileSync(config.authFile,"utf8"));const auth=saved[config.providerID];if(!auth)throw Error("configured provider is not connected");for(const value of Object.values(auth))if(typeof value==="string"&&value.length>20)secrets.push(value);mkdirSync(dirname(authCopy),{recursive:true});authCopies.push(authCopy);writeFileSync(authCopy,JSON.stringify({[config.providerID]:auth}))}
      const model=`${config.providerID}/${config.modelID}`,agents:Record<string,unknown>={build:{model},general:{model},explore:{model},compaction:{model},summary:{model},title:{model}}
      const requiredSkills=Object.keys(fixture.files).filter(path=>/^\.opencode\/skills\/[^/]+\/SKILL\.md$/.test(path)).map(path=>({name:path.split("/")[2]!,path:resolve(project,path)}))
      if(arm!=="build"){
        const dest=join(dir,"config/opencode/agents");mkdirSync(dest,{recursive:true})
        for(const role of ["orchestrator","explorer","researcher","implementer","checker"]){let text=readFileSync(join(repo,`agents/${role}.md`),"utf8");if(role==="checker"&&arm==="alg_targeted")text+="\n\n"+TARGETED+"\n";writeFileSync(join(dest,role+".md"),text);agents[role]={model}}
      }
      const provider=structuredClone(config.provider) as any
      if(localBase)provider[config.providerID].options.baseURL=localBase+"/v1"
      // OpenCode adds this metadata on startup when absent. Seed it before
      // hashing so benign host initialization cannot invalidate the arm.
      const configuration={$schema:"https://opencode.ai/config.json",plugin:arm==="build"?[]:[plugin.source.spec],autoupdate:false,share:"disabled",snapshot:false,model,small_model:model,
        permission:{"*":"allow",external_directory:"deny",webfetch:"deny",websearch:"deny",question:"deny"},mcp:{},skills:{paths:requiredSkills.length?[join(project,".opencode/skills")]:[]},compaction:selection.compaction,provider,agent:agents}
      json(join(dir,"opencode.json"),configuration);json(join(dir,"alg-options.json"),{skillEvolution:{enabled:false},sessionMemory:{mode:"assist"},workspace:{mode:"observe"}})
      const armConfigHash=sha(readFileSync(join(dir,"opencode.json")))
      let api:CensusApi=async()=>{throw new Error("host_api_unavailable")},base="",rootSession="",stopReason:string|null=null
      const sessions=new Map<string,any>(),messages=new Map<string,any>(),samples:any[]=[],phases:any[]=[],processes:number[]=[],start=Date.now()
      updateResult(pair.pairId,arm,{status:"running"})
      let activeStart=0,deadline=0,cleanup=true,meteringComplete=true,score:any=null,preflight:any=null,phase1:any=null,restarted=false,childBudgetOvershoot=0,finalCensusReceipt:any=null,currentPhase="setup"
      let compactionInput: Parameters<typeof compactionReceipt>[0] | undefined
      const rootMessages=()=>[...messages.values()].filter(message=>message.sessionID===rootSession)
      const event=(value:unknown)=>appendFileSync(join(dir,"events.jsonl"),scrub(JSON.stringify({at:new Date().toISOString(),...value as any}))+"\n")
      let lastCensusCoverage:CensusProgress|null=null
      const collect=async()=>{
        const collected=await collectSessionCensus({api,sessions,messages,phase:currentPhase,benchmarkDeadline:deadline||undefined,overallBudgetMs:CENSUS_LIMITS.activeOverallMs})
        const metric=collected.metrics,coverage=collected.coverage
        lastCensusCoverage=coverage
        const turns=metric.assistantTurns.total,tokens=metric.usage.totalReportedTokens,cost=metric.cost.reportedTotal
        samples.push({at_ms:Date.now()-start,assistant_turns:turns,tokens,reported_cost:cost,sessions:sessions.size})
        if(activeStart)stopReason??=benchmarkObservedStop({now:Date.now(),deadline,assistantTurns:turns,reportedComponents:tokens},limits)
        childBudgetOvershoot=Math.max(childBudgetOvershoot,turns-limits.assistantTurns)
        return metric
      }
      const launchHost=async()=>{
        const port=await freePort(),password=randomBytes(24).toString("hex");secrets.push(password,Buffer.from("opencode:"+password).toString("base64"));base=`http://127.0.0.1:${port}`
        server=launch(config.hostExecutable,["serve","--hostname","127.0.0.1","--port",String(port)],project,{...env,OPENCODE_SERVER_PASSWORD:password});if(server.child.pid)processes.push(server.child.pid)
        api=async(path,body,ms=15_000,signal)=>{const url=new URL(path,base);url.searchParams.set("directory",project);const r=await fetch(url,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",Authorization:"Basic "+Buffer.from("opencode:"+password).toString("base64")},body:body===undefined?undefined:JSON.stringify(body),signal:signal??AbortSignal.timeout(ms)});if(!r.ok)throw Error(`host_http_${r.status}:${path}`);const text=await r.text();return text?JSON.parse(text):null}
        let ready=false;for(let i=0;i<150;i++){try{await api("/global/health",undefined,500);ready=true}catch{}if(ready)break;if(server.exit().observed)throw Error("host exited during startup");await sleep(300)}if(!ready)throw Error("host startup timeout")
      }
      const bounded=async(label:string,request:()=>Promise<any>)=>{
        currentPhase=label
        if(Date.now()>=deadline)stopReason??="trial_deadline"
        if(stopReason)throw Error(stopReason)
        event({phase:label,event:"start"});const t=Date.now();let done=false,error:unknown,result:any
        const promise=request().then(value=>{result=value;done=true},e=>{error=e;done=true})
        let idle=false
        while(!done||!idle){
          await sleep(1000)
          try{await collect();const coverage=lastCensusCoverage!;const remaining=Math.min((coverage.overallBudgetMs??0)-coverage.elapsedMs,deadline-Date.now());if(remaining<=0){coverage.failedEndpoint="/session/status";coverage.complete=false;throw new SessionCensusError(coverage,"census_overall_deadline_exceeded")}const statusMs=Math.min(3000,remaining),statusStarted=Date.now();let status:any;try{status=await api("/session/status",undefined,statusMs)}catch(error){coverage.failedEndpoint="/session/status";coverage.complete=false;coverage.elapsedMs+=Date.now()-statusStarted;throw new SessionCensusError(coverage,error instanceof Error?error.name||"census_request_failed":"census_request_failed")}coverage.elapsedMs+=Date.now()-statusStarted;if(!status||typeof status!=="object"||Array.isArray(status)){coverage.failedEndpoint="/session/status";coverage.complete=false;throw new SessionCensusError(coverage,"status_census_invalid")}idle=[...sessions.keys()].every(id=>!status[id]||status[id].type==="idle")&&![...messages.values()].some(m=>m.parts?.some((p:any)=>p.type==="tool"&&["pending","running"].includes(p.state?.status)))}catch(e){meteringComplete=false;const census=e instanceof SessionCensusError?e.census:lastCensusCoverage;event({event:"collector_error",message:e instanceof SessionCensusError?e.message:String(e),endpoint:e instanceof SessionCensusError?e.census.failedEndpoint:null,census:census??null});stopReason??=Date.now()>=deadline?"trial_deadline":"telemetry_failure"}
          if(Date.now()>=deadline)stopReason??="trial_deadline";if(stopReason||error)break
        }
        if(stopReason||error){
          stopReason??=String(error)
          const fresh=await api("/session",undefined,2500).catch(()=>[]);for(const s of fresh)sessions.set(s.id,s)
          await Promise.all([...sessions.values()].map(s=>api(`/session/${s.id}/abort`,{},2500).catch(()=>{})))
          await Promise.race([promise,sleep(1000)]);event({phase:label,event:"stopped",reason:stopReason??String(error)});throw Error(stopReason??String(error))
        }
        await promise;if(result?.info?.error)throw Error(`model_error:${result.info.error.name??"unknown"}`)
        await collect();if(Date.now()>=deadline)stopReason??="trial_deadline";if(stopReason)throw Error(stopReason)
        phases.push({phase:label,ms:Date.now()-t,completed:true});event({phase:label,event:"complete"});return result
      }
      try{
        if(hardFixture&&needsHardService(hardFixture)){
          hardService=await openHardFixtureService(hardFixture,join(dir,"service"))
          serviceReceipt.ledger_before=await hardService.ledger()
          hardHost=await startHardBenchmarkHost(hardService);serviceReceipt.started=true
          json(join(dir,"service-before.json"),serviceReceipt.ledger_before)
        }
        await launchHost();const registered=await api!("/experimental/tool/ids"),availableAgents=await api!("/agent"),providers=await api!("/provider")
        const selected=providers.all.find((p:any)=>p.id===config.providerID)?.models?.[config.modelID]
        if(!selected||!providers.connected.includes(config.providerID))throw Error("selected model unavailable")
        if(selected.limit?.output!==limits.outputTokens)throw Error("provider output limit differs from protocol")
        if(arm==="build"&&registered.some((id:string)=>id.startsWith("alg_")))throw Error("ALG leaked into native baseline")
        if(arm!=="build"&&!registered.includes("alg_run"))throw Error("ALG absent from experimental arm")
        if(!availableAgents.some((a:any)=>a.name===(arm==="build"?"build":"orchestrator")))throw Error("primary agent missing")
        const checker=availableAgents.find((a:any)=>a.name==="checker")
        if(arm!=="build"&&(typeof checker?.prompt!=="string"||checker.prompt.includes(TARGETED)!==(arm==="alg_targeted")))throw Error("loaded checker mandate differs from arm")
        const discoveredSkills=requiredSkills.length?await api!("/skill"):[]
        const pathIdentity=(path:string)=>process.platform==="win32"?resolve(path).toLowerCase():resolve(path)
        for(const expected of requiredSkills){
          const skill=discoveredSkills.find((s:any)=>s.name===expected.name)
          const body=readFileSync(expected.path,"utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,"").trim()
          if(!skill||typeof skill.location!=="string"||pathIdentity(skill.location)!==pathIdentity(expected.path)||typeof skill.content!=="string"||skill.content.trim()!==body)throw Error(`required fixture skill unavailable or changed:${expected.name}`)
        }
        preflight={health:await api!("/global/health"),tools:registered,agents:availableAgents.map((a:any)=>({name:a.name,mode:a.mode,model:a.model??null,steps:a.steps??null,prompt_sha256:typeof a.prompt==="string"?sha(a.prompt):null,targeted_mandate:typeof a.prompt==="string"&&a.prompt.includes(TARGETED),permission:a.permission})),selected:{provider:config.providerID,model:config.modelID,limit:selected.limit},source_sha256:initialIdentity.digest,fixture_files:hardFixture?collectHardProject(project,hardFixture).manifest:files(project)}
        json(join(dir,"preflight.json"),preflight)
        json(join(dir,"skills-preflight.json"),discoveredSkills.map((s:any)=>({name:s.name,location:s.location,content_sha256:typeof s.content==="string"?sha(s.content):null})))
        if(!config.preflightOnly){
          activeStart=Date.now();deadline=Math.min(activeStart+limits.trialMs,suiteDeadline)
          rootSession=(await api!("/session",{title:`Frozen benchmark ${fixture.id} ${arm}`})).id
          const send=async(prompt:string)=>{
            const text=benchmarkTaskPrompt(COMMON,prompt,hardHost?.url)
            if(hard)json(join(dir,`${currentPhase}-prompt.json`),{sha256:sha(text),text})
            const outcome=await sendBenchmarkPrompt({api:api!,sessionID:rootSession,body:{model:{providerID:config.providerID,modelID:config.modelID},agent:arm==="build"?"build":"orchestrator",parts:[{type:"text",text}]},deadline,cancelled:()=>stopReason})
            if(outcome.status==="completed"||outcome.status==="model_error")return outcome.assistant
            if(outcome.status==="incomplete")throw Error(`model_incomplete:${outcome.finish}`)
            if(outcome.status==="deadline")throw Error("trial_deadline")
            if(outcome.status==="cancelled")throw Error(outcome.reason)
            throw Error(`${outcome.status}:${outcome.error}`)
          }
          await bounded("initial",()=>send(fixture.initialPrompt))
          if(fixture.followupPrompt){
            const prepPath=join(project,"preparation.md")
            phase1={files:files(project),at_ms:Date.now()-activeStart,preparation_content:existsSync(prepPath)?readFileSync(prepPath,"utf8").slice(0,16384):null,report_absent:!existsSync(join(project,"report.json")),independent_score:await scoreBenchmarkPreparation(project)};json(join(dir,"phase1.json"),phase1)
            if(!phase1.independent_score.passed||!phase1.report_absent)throw Error("preparation_milestone_not_reached")
            const beforeSummary=await api!(`/session/${rootSession}/message`)
            await bounded("compaction",async()=>{
              const request={requestId:randomBytes(16).toString("hex"),requestedAt:new Date().toISOString(),rootSessionId:rootSession,
                response:undefined as unknown,beforeMessages:beforeSummary,afterMessages:[],continuation:{status:"not_completed"}}
              compactionInput=request
              request.response=await api!(`/session/${rootSession}/summarize`,{providerID:config.providerID,modelID:config.modelID},limits.trialMs) as SessionSummarizeResponses[200]
              return request.response
            })
            const stopped=await stopCapturedProcess(server!);cleanup&&=stopped.passed;event({event:"restart_stop",passed:stopped.passed});if(!stopped.passed)throw Error("restart cleanup failed")
            await launchHost();restarted=true
            const request=compactionInput!
            request.afterMessages=await api!(`/session/${rootSession}/message`)
            const followup=fixture.followupPrompt
            const continuation=await bounded("followup",()=>send(followup))
            const continuationScore=await scoreBenchmarkCase(fixture.id,project).catch(()=>({passed:false}))
            request.continuationMessages=rootMessages()
            request.continuation={status:continuation?.info?.error?"error":"completed",
              userMessageID:typeof continuation?.info?.parentID==="string"?continuation.info.parentID:undefined,
              assistantID:typeof continuation?.info?.id==="string"?continuation.info.id:undefined,scorePassed:continuationScore.passed===true}
            if(!compactionIsQualified(compactionReceipt(request)))throw Error("compaction request, summary, persisted marker, and continuation were not linked")
          }
        }
      }catch(error){stopReason??=error instanceof Error?error.message:String(error);event({event:"trial_error",reason:stopReason})}
      finally{
        if(server){
          if(stopReason){await Promise.all([...sessions.keys()].map(id=>api(`/session/${id}/abort`,{},1000).catch(()=>null)));event({event:"final_cancel_requested",sessions:sessions.size})}
          finalCensusReceipt=await collectFinalSessionCensus({api,sessions,messages,phase:currentPhase,graceMs:CENSUS_LIMITS.finalFirstMs})
          if(finalCensusReceipt.outcome!=="quiescent"){
            stopReason??="final_census_unresolved"
            await Promise.all([...sessions.keys()].map(id=>api(`/session/${id}/abort`,{},1000).catch(()=>null)))
            event({event:"final_census_abort",outcome:finalCensusReceipt.outcome,sessions:sessions.size,endpoint:finalCensusReceipt.failure?.endpoint??finalCensusReceipt.coverage?.failedEndpoint??null,coverage:finalCensusReceipt.coverage})
            finalCensusReceipt=await collectFinalSessionCensus({api,sessions,messages,phase:currentPhase,graceMs:CENSUS_LIMITS.finalRetryMs})
          }
          meteringComplete=finalCensusReceipt.outcome==="quiescent"
          if(!meteringComplete)stopReason??="final_census_unresolved"
          hostStopAttempted=true
          const stopped=await stopCapturedProcess(server);cleanup&&=stopped.passed;json(join(dir,"host-log.json"),{stdout:server.stdout(),stderr:server.stderr()})
        }
        if(hard){await stopService();cleanup&&=serviceReceipt.errors.length===0&&(!hardHost||serviceReceipt.stopped)}
        if(existsSync(authCopy))unlinkSync(authCopy)
        if(hardFixture){
          try{
            if(!cleanup)throw Error("contestant_or_service_cleanup_unresolved")
            hardCollection=collectHardProject(project,hardFixture)
            if(!config.preflightOnly)score=await scoreHardDevelopmentFixture(hardFixture,{files:hardCollection.files},{service:hardService})
          }catch(error){score={passed:false,scorer_error:String(error)};stopReason??="hard_independent_score_unavailable"}
          json(join(dir,"hard-grader-receipt.json"),{score,collection:hardCollection?{manifest:hardCollection.manifest,excluded:hardCollection.excluded,bytes:hardCollection.bytes,limits:hardCollection.limits}:null,service:serviceReceipt})
        }else if(!config.preflightOnly)score=await scoreBenchmarkCase(fixture.id,project).catch(error=>({passed:false,scorer_error:String(error)}))
        const metric=summarizeSessionMetrics([...sessions.values()],[...messages.values()]) as any
        let databaseCensus: ReturnType<typeof reconcileHostCensus> | {qualified:false;reason:string} = {qualified:false,reason:"unavailable"}
        let db:Database|undefined
        try {
          db=new Database(join(dir,"data/opencode/opencode.db"),{readonly:true})
          databaseCensus=reconcileHostCensus({storedSessions:(db.query("SELECT id FROM session").all() as Array<{id:string}>).map(s=>s.id),
            storedMessages:db.query("SELECT id, session_id FROM message").all() as Array<{id:string;session_id:string}>,observedSessions:[...sessions.keys()],
            observedMessages:[...messages.values()].map(m=>({id:m.info.id,session_id:m.sessionID})),quiescent:cleanup&&finalCensusReceipt?.outcome==="quiescent"})
        } catch { databaseCensus={qualified:false,reason:"database_read_or_schema_unavailable"} } finally {db?.close()}
        knownCost+=metric.cost.reportedTotal
        json(join(dir,"messages.json"),[...messages.values()]);json(join(dir,"sessions.json"),[...sessions.values()]);json(join(dir,"samples.json"),samples)
        const stateFiles=hard?hardCollection?.manifest??[]:files(project),algStates:any[]=[]
        let algProgressCoverage="legacy_unbounded_collection"
        if(hard){
          try{const diagnostic=collectHardRunProgress(project);algStates.push(...diagnostic.states);algProgressCoverage=diagnostic.coverage}
          catch(error){algProgressCoverage=`unavailable:${error instanceof Error?error.message:String(error)}`}
        }else for(const entry of stateFiles.filter(e=>/^\.opencode\/runs\/[^/]+\/progress\.json$/.test(e.path))){try{const state=JSON.parse(readFileSync(join(project,entry.path),"utf8"));algStates.push({run_id:state.run_id,status:state.status,global_attempts:state.global_attempts,nodes:Object.values(state.nodes??{}).map((n:any)=>({id:n.id,status:n.status,attempts:n.attempts?.map((a:any)=>({outcome:a.outcome,failures:a.failures,session_id:a.session_id}))}))})}catch{}}
        const artifactPassed=score?.passed===true
        const qualification=eligibility({artifactPassed,workflowComplete:!config.preflightOnly&&!stopReason,sourceIntegrity:sourceUnchanged(),configIntegrity:snapshotGlobalOpenCodeConfig(globals,hmac).sha256===before&&sha(readFileSync(join(dir,"opencode.json")))===armConfigHash,cleanup:cleanup&&(!config.authFile||!existsSync(authCopy)),censusQuiescent:!config.preflightOnly&&finalCensusReceipt?.outcome==="quiescent",isolationQualified:false})
        const compaction=compactionInput?compactionReceipt(compactionInput):null
        const observedCompaction=compactionInput?compactionReceipt({...compactionInput,afterMessages:rootMessages()}):undefined
        const retentionEvents=activeStart?hostRetentionEvents({taskId:`${pair.pairId}:${fixture.id}:${arm}`,sessions:[...sessions.values()],messages:[...messages.values()],startedAt:activeStart,endedAt:Date.now(),restarted,compactionReceipt:observedCompaction,censusComplete:databaseCensus.qualified}):[]
        const retention=measureBuildBenchmarkRetention(retentionEvents,[])
        const result={pairId:pair.pairId,caseId:fixture.id,arm,status:config.preflightOnly?(stopReason?"preflight_failed":"preflight_passed"):(stopReason?"stopped":"completed"),stopReason,passed:artifactPassed,
          scored_task_success:artifactPassed&&!config.preflightOnly&&!stopReason&&qualification.workflowEligible&&cleanup&&databaseCensus.qualified&&
            sourceUnchanged()&&snapshotGlobalOpenCodeConfig(globals,hmac).sha256===before&&sha(readFileSync(join(dir,"opencode.json")))===armConfigHash,
          independent_score:score,metrics:metric,wall_ms:activeStart?Date.now()-activeStart:null,total_with_startup_ms:Date.now()-start,phases,rootSession,
          recovery:{requested:!!compactionInput,recoveryRequired:!!fixture.followupPrompt,restarted,compactionRecovered:compactionIsQualified(compaction),compaction,phase1},retention:retention.tasks[0]??{status:"unavailable_preflight"},alg_states:algStates,alg_progress_coverage:algProgressCoverage,budget_observed_overshoot:childBudgetOvershoot,
          retention_boundaries:retention.boundaryRetention,
          cleanup,metering_complete:null,observed_metering_stable:meteringComplete,final_census:finalCensusReceipt,
          coverage:{historical_message_pagination:databaseCensus.qualified?"IDs_reconciled_with_stopped_host_database":"unqualified",provider_usage:"session_reported_fields_only",quiescent_snapshot:finalCensusReceipt?.outcome==="quiescent"},databaseCensus,
          reported_component_overshoot:Math.max(0,metric.usage.totalReportedTokens-limits.reportedComponents),eligibility:qualification,auth_copy_removed:!existsSync(authCopy),processes,source_unchanged:sourceUnchanged(),arm_config_sha256:armConfigHash,
          final_files:stateFiles,usage_monitors:usageMonitors,measurement_limits:protocol.unmeasured}
        json(join(dir,"result.json"),result);updateResult(pair.pairId,arm,result);console.log(JSON.stringify({case:fixture.id,arm,status:result.status,passed:result.passed,wall_ms:result.wall_ms}));
      }
      }catch(error){
        if(!hard)throw error
        updateResult(pair.pairId,arm,{status:config.preflightOnly?"preflight_failed":"stopped",stopReason:String(error),passed:false,scored_task_success:false,setup_or_finalization_error:true,cleanup:false})
      }finally{
        if(hard){
          if(server&&!hostStopAttempted){hostStopAttempted=true;try{const stopped=await stopCapturedProcess(server);if(!stopped.passed)serviceReceipt.errors.push("contestant_stop_failed")}catch(error){serviceReceipt.errors.push(`contestant_stop:${String(error)}`)}}
          await stopService()
          try{if(existsSync(authCopy))unlinkSync(authCopy)}catch(error){serviceReceipt.errors.push(`auth_cleanup:${String(error)}`)}
          const row=results.find(r=>r.pairId===pair.pairId&&r.arm===arm)!
          if(serviceReceipt.errors.length)updateResult(pair.pairId,arm,{status:config.preflightOnly?"preflight_failed":"stopped",passed:false,scored_task_success:false,cleanup:false})
          Object.assign(row,{hard_service:serviceReceipt,isolation:HARD_ISOLATION,confirmation_qualified:false,
            requested_host_compaction:false,native_compaction:selection.compaction,alg_state_diagnostics:"bounded_post_stop_private_progress_projection_excluded_from_grader",
            compaction_evidence:{basis:"existing_metrics_and_retention_receipts",requested_boundary:"not_requested",information_loss:"not_measured"},
            final_files_coverage:hardCollection?"complete_user_files_with_declared_runtime_exclusions":"unavailable_collection_or_setup_failure"})
          json(join(dir,"service-receipt.json"),serviceReceipt);json(join(dir,"result.json"),row)
        }
      }
    }
  }catch(error){fatal=error instanceof Error?error.message:String(error)}
  finally{
    const suiteCleanupErrors:string[]=[]
    for(const path of authCopies)try{if(existsSync(path))unlinkSync(path)}catch(error){if(!hard)throw error;suiteCleanupErrors.push(`auth_cleanup:${String(error)}`)}
    let localStopped=true
    try{if(local)localStopped=(await stopCapturedProcess(local)).passed}catch(error){if(!hard)throw error;localStopped=false;suiteCleanupErrors.push(`local_stop:${String(error)}`)}
    for(const name of ["id_ed25519","id_ed25519.pub"]){const p=join(root,"local-service/home/.ollama",name);try{if(existsSync(p))unlinkSync(p)}catch(error){if(!hard)throw error;suiteCleanupErrors.push(`local_identity_cleanup:${String(error)}`)}}
    let unchanged=false
    try{unchanged=snapshotGlobalOpenCodeConfig(globals,hmac).sha256===before}catch(error){if(!hard)throw error;suiteCleanupErrors.push(`global_config_receipt:${String(error)}`)}
    if(hard)for(const row of terminalHardRows(results,fatal??"cohort_terminated_before_completion",!!config.preflightOnly))updateResult(row.pairId,row.arm,row)
    const armOutcomes=summarizeIssuedArms(results,config.preflightOnly?"preflight":"trial")
    const result={schema:"alg-build-pilot-v1",...armOutcomes,fatal,model:protocol.model,limits,track,pairs,results,
      ...(hard?{workload:"hard-development",hard:protocol.hard,suite_cleanup_errors:suiteCleanupErrors}:{}),
      known_reported_cost:knownCost,reported_cost_is_invoice:false,usage_monitors:usageMonitors,global_configuration_unchanged:unchanged,local_model_stopped:localStopped,source_unchanged:sourceUnchanged()}
    json(join(root,"result.json"),result);console.log(JSON.stringify({terminal:true,model:protocol.model,trials:results.length,fatal,global_configuration_unchanged:unchanged,local_model_stopped:localStopped}));
    if(fatal||!unchanged||!localStopped||suiteCleanupErrors.length||results.some(r=>r.cleanup===false)||(hard&&!sourceUnchanged()))process.exitCode=1
  }
}
export { freePort, launch, isolatedEnv, LIMITS as BUILD_BENCHMARK_CONTROL_LIMITS }
if(import.meta.main){if(!process.argv[2])throw Error("Usage: bun scripts/build-benchmark.ts <non-secret-config.json>");await runBuildBenchmark(JSON.parse(readFileSync(resolve(process.argv[2]),"utf8")))}
