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
import { scheduleIssuedPairs, summarizeIssuedArms, finalCensus, compactionReceipt, compactionIsQualified, eligibility, benchmarkObservedStop, reconcileHostCensus, type BenchmarkTrack } from "./build-benchmark-protocol.ts"
import { computeAlgSourceIdentity } from "../src/source-identity.ts"
import { seedVerificationHostDependencies } from "./verification-host-dependencies.ts"
import { verificationPluginConfiguration, realUserGlobalConfigRoots, snapshotGlobalOpenCodeConfig, stopCapturedProcess } from "./live-verify.ts"

/** Local feasibility pilot. JSON config supplies paths/provider, never credential values. */
interface Config {
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

export async function runBuildBenchmark(config:Config){
  const repo=resolve(import.meta.dir,".."),root=resolve(config.outputRoot)
  if(config.caseIds && (!config.caseIds.length || new Set(config.caseIds).size!==config.caseIds.length || config.caseIds.some(id=>!BENCHMARK_CASES.some(c=>c.id===id))))throw Error("caseIds must select distinct known cases")
  const selectedCases=BENCHMARK_CASES.filter(fixture=>!config.caseIds||config.caseIds.includes(fixture.id))
  const track=config.track??"default"
  if(track!=="default"&&track!=="targeted_compatibility")throw Error("track must be default or targeted_compatibility")
  const issuedCases=scheduleIssuedPairs(selectedCases,track)
  const pairs=issuedCases.map(({pair})=>pair)
  if(existsSync(root))throw Error("Evidence destination exists; no implicit rerun")
  mkdirSync(root,{recursive:true})
  const initialIdentity=computeAlgSourceIdentity(repo), plugin=verificationPluginConfiguration(repo)
  const hmac=randomBytes(32), globals=realUserGlobalConfigRoots(), before=snapshotGlobalOpenCodeConfig(globals,hmac).sha256
  const secrets:string[]=[], scrub=(s:string)=>secrets.reduce((text,secret)=>text.replaceAll(secret,"[REDACTED]"),s)
  const json=(path:string,value:unknown)=>write(path,JSON.parse(scrub(JSON.stringify(value))))
  const suiteDeadline=Date.now()+LIMITS.suiteMs
  const protocol={schema:"alg-build-pilot-v1",started_at:new Date().toISOString(),source_commit:execFileSync("git",["rev-parse","HEAD"],{cwd:repo}).toString().trim(),source_sha256:initialIdentity.digest,
    harness_sha256:sha(readFileSync(import.meta.filename)),protocol_sha256:sha(readFileSync(join(repo,"scripts/build-benchmark-protocol.ts"))),fixtures_sha256:sha(readFileSync(join(repo,"scripts/build-benchmark-fixtures.ts"))),metrics_sha256:sha(readFileSync(join(repo,"scripts/build-benchmark-metrics.ts"))),transport_sha256:sha(readFileSync(join(repo,"scripts/build-benchmark-transport.ts"))),prompt_transport:"prompt_async",
    model:`${config.providerID}/${config.modelID}`,limits:LIMITS,preflight_only:!!config.preflightOnly,track,
    pairs:issuedCases.map(({pair,order})=>({...pair,arms:[...pair.arms],order})),
    cases:selectedCases.map(c=>({id:c.id,criteria:c.criteria,initialPrompt:c.initialPrompt,followupPrompt:c.followupPrompt??null,fixture_files:Object.entries(c.files).map(([path,text])=>({path,sha256:sha(text)}))})),
    retention_sha256:sha(readFileSync(join(repo,"scripts/build-benchmark-retention.ts"))),
    retention_boundaries_sha256:sha(readFileSync(join(repo,"scripts/build-benchmark-retention-boundaries.ts"))),
    interpretation:"Single-repeat feasibility pilot. Equal externally enforced time and per-call output limits; assistant-turn and reported-component thresholds are cumulative polling-based cutoffs subject to overshoot across root/children/maintenance/phases, not hard provider-request or invoice caps. ALG internal gates are diagnostics, never the independent oracle. Reported cost is telemetry only. Session-visible usage is not proof of complete provider billing. No superiority claim.",
    enforcement:{time:"host deadline",output:"per-call configured limit",assistantTurns:"cumulative observed cutoff; polling overshoot possible",reportedTokens:"cumulative observed component cutoff; polling overshoot possible",reportedCost:"telemetry only"},
    usage_monitors:USAGE_MONITORS,
    targeted_mandate:TARGETED,common_instruction:COMMON,unmeasured:["actual provider invoice","hidden model calls not represented by session messages","operator minutes","production MCP cost/reuse","multi-hour reliability","hardware-normalized latency"]}
  json(join(root,"plan.json"),protocol)
  const results:any[]=pairs.flatMap(pair=>pair.arms.map(({arm})=>({pairId:pair.pairId,caseId:pair.caseId,arm,status:"issued_not_started",passed:false}))),authCopies:string[]=[];let local:Tracked|undefined,localBase:string|undefined,knownCost=0,fatal:string|null=null
  const updateResult=(pairId:string,arm:string,patch:Record<string,unknown>)=>{const row=results.find(r=>r.pairId===pairId&&r.arm===arm);if(row)Object.assign(row,patch);const pair=pairs.find(p=>p.pairId===pairId);const pairArm=pair?.arms.find(a=>a.arm===arm);if(pairArm){const status=patch.status;if(status==="running")pairArm.status="running";else if(status==="completed"||status==="preflight_passed")pairArm.status="completed";else if(status==="issued_not_started")pairArm.status="issued_not_started";else if(status!==undefined)pairArm.status="stopped"}}
  try{
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
      const dir=join(root,`${caseIndex+1}-${fixture.id}-${arm}`),project=join(dir,"project"),env=isolatedEnv(dir),authCopy=join(dir,"data/opencode/auth.json")
      mkdirSync(project,{recursive:true});for(const [path,text] of Object.entries(fixture.files)){mkdirSync(dirname(join(project,path)),{recursive:true});writeFileSync(join(project,path),text)}
      execFileSync("git",["init","-q"],{cwd:project});execFileSync("git",["add","."],{cwd:project});execFileSync("git",["-c","user.name=ALG Benchmark","-c","user.email=benchmark@localhost","commit","-qm","Frozen synthetic task"],{cwd:project})
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
      const configuration={plugin:arm==="build"?[]:[plugin.source.spec],autoupdate:false,share:"disabled",snapshot:false,model,small_model:model,
        permission:{"*":"allow",external_directory:"deny",webfetch:"deny",websearch:"deny",question:"deny"},mcp:{},skills:{paths:requiredSkills.length?[join(project,".opencode/skills")]:[]},compaction:{auto:false,prune:false},provider,agent:agents}
      json(join(dir,"opencode.json"),configuration);json(join(dir,"alg-options.json"),{skillEvolution:{enabled:false},sessionMemory:{mode:"assist"},workspace:{mode:"observe"}})
      const armConfigHash=sha(readFileSync(join(dir,"opencode.json")))
      let server:Tracked|undefined,api:(path:string,body?:unknown,ms?:number)=>Promise<any>,base="",rootSession="",stopReason:string|null=null
      const sessions=new Map<string,any>(),messages=new Map<string,any>(),samples:any[]=[],phases:any[]=[],processes:number[]=[],start=Date.now()
      updateResult(pair.pairId,arm,{status:"running"})
      let activeStart=0,deadline=0,cleanup=true,meteringComplete=true,score:any=null,preflight:any=null,phase1:any=null,restarted=false,childBudgetOvershoot=0,finalCensusReceipt:any=null,currentPhase="setup"
      let compactionInput: Parameters<typeof compactionReceipt>[0] | undefined
      const rootMessages=()=>[...messages.values()].filter(message=>message.sessionID===rootSession)
      const event=(value:unknown)=>appendFileSync(join(dir,"events.jsonl"),scrub(JSON.stringify({at:new Date().toISOString(),...value as any}))+"\n")
      const collect=async(final=false)=>{
        const censusDeadline=final?Date.now()+5000:Math.min(Date.now()+10_000,deadline||Infinity)
        const remaining=()=>Math.max(1,censusDeadline-Date.now())
        const rows=await api("/session?limit=10000",undefined,remaining());let next=0
        if(!Array.isArray(rows)||rows.length>=10000)throw Error("session_census_invalid_or_at_limit")
        await Promise.all(Array.from({length:Math.min(3,rows.length)},async()=>{while(next<rows.length){const s=rows[next++];sessions.set(s.id,s);const history=await api(`/session/${s.id}/message?limit=10000`,undefined,remaining());if(!Array.isArray(history)||history.length>=10000)throw Error("message_census_invalid_or_at_limit");for(const m of history){const prior=messages.get(s.id+":"+m.info.id);messages.set(s.id+":"+m.info.id,{sessionID:s.id,...m,benchmarkPhase:prior?.benchmarkPhase??currentPhase})}}}))
        const metric=summarizeSessionMetrics([...sessions.values()],[...messages.values()])
        const turns=metric.assistantTurns.total,tokens=metric.usage.totalReportedTokens,cost=metric.cost.reportedTotal
        samples.push({at_ms:Date.now()-start,assistant_turns:turns,tokens,reported_cost:cost,sessions:sessions.size})
        if(activeStart)stopReason??=benchmarkObservedStop({now:Date.now(),deadline,assistantTurns:turns,reportedComponents:tokens},LIMITS)
        childBudgetOvershoot=Math.max(childBudgetOvershoot,turns-LIMITS.assistantTurns)
        return metric
      }
      const launchHost=async()=>{
        const port=await freePort(),password=randomBytes(24).toString("hex");secrets.push(password,Buffer.from("opencode:"+password).toString("base64"));base=`http://127.0.0.1:${port}`
        server=launch(config.hostExecutable,["serve","--hostname","127.0.0.1","--port",String(port)],project,{...env,OPENCODE_SERVER_PASSWORD:password});if(server.child.pid)processes.push(server.child.pid)
        api=async(path,body,ms=15_000)=>{const url=new URL(path,base);url.searchParams.set("directory",project);const r=await fetch(url,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",Authorization:"Basic "+Buffer.from("opencode:"+password).toString("base64")},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(ms)});if(!r.ok)throw Error(`host_http_${r.status}:${path}`);const text=await r.text();return text?JSON.parse(text):null}
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
          try{await collect();const status=await api("/session/status",undefined,Math.max(1,Math.min(3000,deadline-Date.now())));idle=[...sessions.keys()].every(id=>!status[id]||status[id].type==="idle")&&![...messages.values()].some(m=>m.parts?.some((p:any)=>p.type==="tool"&&["pending","running"].includes(p.state?.status)))}catch(e){meteringComplete=false;event({event:"collector_error",message:String(e)});stopReason??=Date.now()>=deadline?"trial_deadline":"telemetry_failure"}
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
        await launchHost();const registered=await api!("/experimental/tool/ids"),availableAgents=await api!("/agent"),providers=await api!("/provider")
        const selected=providers.all.find((p:any)=>p.id===config.providerID)?.models?.[config.modelID]
        if(!selected||!providers.connected.includes(config.providerID))throw Error("selected model unavailable")
        if(selected.limit?.output!==LIMITS.outputTokens)throw Error("provider output limit differs from protocol")
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
        preflight={health:await api!("/global/health"),tools:registered,agents:availableAgents.map((a:any)=>({name:a.name,mode:a.mode,model:a.model??null,steps:a.steps??null,prompt_sha256:typeof a.prompt==="string"?sha(a.prompt):null,targeted_mandate:typeof a.prompt==="string"&&a.prompt.includes(TARGETED),permission:a.permission})),selected:{provider:config.providerID,model:config.modelID,limit:selected.limit},source_sha256:initialIdentity.digest,fixture_files:files(project)}
        json(join(dir,"preflight.json"),preflight)
        json(join(dir,"skills-preflight.json"),discoveredSkills.map((s:any)=>({name:s.name,location:s.location,content_sha256:typeof s.content==="string"?sha(s.content):null})))
        if(!config.preflightOnly){
          activeStart=Date.now();deadline=Math.min(activeStart+LIMITS.trialMs,suiteDeadline)
          rootSession=(await api!("/session",{title:`Frozen benchmark ${fixture.id} ${arm}`})).id
          const send=async(prompt:string)=>{
            const outcome=await sendBenchmarkPrompt({api:api!,sessionID:rootSession,body:{model:{providerID:config.providerID,modelID:config.modelID},agent:arm==="build"?"build":"orchestrator",parts:[{type:"text",text:COMMON+"\n\n"+prompt}]},deadline,cancelled:()=>stopReason})
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
              request.response=await api!(`/session/${rootSession}/summarize`,{providerID:config.providerID,modelID:config.modelID},LIMITS.trialMs) as SessionSummarizeResponses[200]
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
          const census=async()=>{const metric=await collect(true);const status=await api("/session/status",undefined,1000);const active=[...sessions.keys()].filter(id=>status[id]&&status[id].type!=="idle").length;const pending=[...messages.values()].some((m:any)=>m.parts?.some((p:any)=>p.type==="tool"&&["pending","running"].includes(p.state?.status)));return{metrics:metric,activeSessions:active,pendingWork:pending,quiescent:active===0&&!pending}}
          if(stopReason){await Promise.all([...sessions.keys()].map(id=>api(`/session/${id}/abort`,{},1000).catch(()=>null)));event({event:"final_cancel_requested",sessions:sessions.size})}
          finalCensusReceipt=await finalCensus({graceMs:5000,pollMs:250,census})
          if(finalCensusReceipt.outcome!=="quiescent"){
            stopReason??="final_census_unresolved"
            await Promise.all([...sessions.keys()].map(id=>api(`/session/${id}/abort`,{},1000).catch(()=>null)))
            event({event:"final_census_abort",outcome:finalCensusReceipt.outcome,sessions:sessions.size})
            finalCensusReceipt=await finalCensus({graceMs:1500,pollMs:250,census})
          }
          meteringComplete=finalCensusReceipt.outcome==="quiescent"
          if(!meteringComplete)stopReason??="final_census_unresolved"
          const stopped=await stopCapturedProcess(server);cleanup&&=stopped.passed;json(join(dir,"host-log.json"),{stdout:server.stdout(),stderr:server.stderr()})
        }
        if(existsSync(authCopy))unlinkSync(authCopy)
        if(!config.preflightOnly)score=await scoreBenchmarkCase(fixture.id,project).catch(error=>({passed:false,scorer_error:String(error)}))
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
        const stateFiles=files(project),algStates:any[]=[]
        for(const entry of stateFiles.filter(e=>/^\.opencode\/runs\/[^/]+\/progress\.json$/.test(e.path))){try{const state=JSON.parse(readFileSync(join(project,entry.path),"utf8"));algStates.push({run_id:state.run_id,status:state.status,global_attempts:state.global_attempts,nodes:Object.values(state.nodes??{}).map((n:any)=>({id:n.id,status:n.status,attempts:n.attempts?.map((a:any)=>({outcome:a.outcome,failures:a.failures,session_id:a.session_id}))}))})}catch{}}
        const artifactPassed=score?.passed===true
        const qualification=eligibility({artifactPassed,workflowComplete:!config.preflightOnly&&!stopReason,sourceIntegrity:computeAlgSourceIdentity(repo).digest===initialIdentity.digest,configIntegrity:snapshotGlobalOpenCodeConfig(globals,hmac).sha256===before&&sha(readFileSync(join(dir,"opencode.json")))===armConfigHash,cleanup:cleanup&&(!config.authFile||!existsSync(authCopy)),censusQuiescent:!config.preflightOnly&&finalCensusReceipt?.outcome==="quiescent",isolationQualified:false})
        const compaction=compactionInput?compactionReceipt(compactionInput):null
        const observedCompaction=compactionInput?compactionReceipt({...compactionInput,afterMessages:rootMessages()}):undefined
        const retentionEvents=activeStart?hostRetentionEvents({taskId:`${pair.pairId}:${fixture.id}:${arm}`,sessions:[...sessions.values()],messages:[...messages.values()],startedAt:activeStart,endedAt:Date.now(),restarted,compactionReceipt:observedCompaction,censusComplete:databaseCensus.qualified}):[]
        const retention=measureBuildBenchmarkRetention(retentionEvents,[])
        const result={pairId:pair.pairId,caseId:fixture.id,arm,status:config.preflightOnly?(stopReason?"preflight_failed":"preflight_passed"):(stopReason?"stopped":"completed"),stopReason,passed:artifactPassed,
          scored_task_success:artifactPassed&&!config.preflightOnly&&!stopReason&&qualification.workflowEligible&&cleanup&&databaseCensus.qualified&&
            computeAlgSourceIdentity(repo).digest===initialIdentity.digest&&snapshotGlobalOpenCodeConfig(globals,hmac).sha256===before&&sha(readFileSync(join(dir,"opencode.json")))===armConfigHash,
          independent_score:score,metrics:metric,wall_ms:activeStart?Date.now()-activeStart:null,total_with_startup_ms:Date.now()-start,phases,rootSession,
          recovery:{requested:!!compactionInput,recoveryRequired:!!fixture.followupPrompt,restarted,compactionRecovered:compactionIsQualified(compaction),compaction,phase1},retention:retention.tasks[0]??{status:"unavailable_preflight"},alg_states:algStates,budget_observed_overshoot:childBudgetOvershoot,
          retention_boundaries:retention.boundaryRetention,
          cleanup,metering_complete:null,observed_metering_stable:meteringComplete,final_census:finalCensusReceipt,
          coverage:{historical_message_pagination:databaseCensus.qualified?"IDs_reconciled_with_stopped_host_database":"unqualified",provider_usage:"session_reported_fields_only",quiescent_snapshot:finalCensusReceipt?.outcome==="quiescent"},databaseCensus,
          reported_component_overshoot:Math.max(0,metric.usage.totalReportedTokens-LIMITS.reportedComponents),eligibility:qualification,auth_copy_removed:!existsSync(authCopy),processes,source_unchanged:computeAlgSourceIdentity(repo).digest===initialIdentity.digest,arm_config_sha256:armConfigHash,
          final_files:stateFiles,usage_monitors:USAGE_MONITORS,measurement_limits:protocol.unmeasured}
        json(join(dir,"result.json"),result);updateResult(pair.pairId,arm,result);console.log(JSON.stringify({case:fixture.id,arm,status:result.status,passed:result.passed,wall_ms:result.wall_ms}));
      }
    }
  }catch(error){fatal=error instanceof Error?error.message:String(error)}
  finally{
    for(const path of authCopies)if(existsSync(path))unlinkSync(path)
    let localStopped=true;if(local)localStopped=(await stopCapturedProcess(local)).passed
    for(const name of ["id_ed25519","id_ed25519.pub"]){const p=join(root,"local-service/home/.ollama",name);if(existsSync(p))unlinkSync(p)}
    const unchanged=snapshotGlobalOpenCodeConfig(globals,hmac).sha256===before
    const armOutcomes=summarizeIssuedArms(results,config.preflightOnly?"preflight":"trial")
    const result={schema:"alg-build-pilot-v1",...armOutcomes,fatal,model:protocol.model,limits:LIMITS,track,pairs,results,
      known_reported_cost:knownCost,reported_cost_is_invoice:false,usage_monitors:USAGE_MONITORS,global_configuration_unchanged:unchanged,local_model_stopped:localStopped,source_unchanged:computeAlgSourceIdentity(repo).digest===initialIdentity.digest}
    json(join(root,"result.json"),result);console.log(JSON.stringify({terminal:true,model:protocol.model,trials:results.length,fatal,global_configuration_unchanged:unchanged,local_model_stopped:localStopped}));
    if(fatal||!unchanged||!localStopped||results.some(r=>r.cleanup===false))process.exitCode=1
  }
}
export { freePort, launch, isolatedEnv }
if(import.meta.main){if(!process.argv[2])throw Error("Usage: bun scripts/build-benchmark.ts <non-secret-config.json>");await runBuildBenchmark(JSON.parse(readFileSync(resolve(process.argv[2]),"utf8")))}
