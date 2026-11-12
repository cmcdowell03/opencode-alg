import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { randomBytes, createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

const repo = resolve(process.argv[2] ?? ""), mode = process.argv[3]
if (!process.argv[2] || !["gemma", "luna"].includes(mode!)) throw Error("source and gemma/luna required")
const root = join(import.meta.dir, `adversarial-20261111-${mode}-corrected`)
if (existsSync(root)) throw Error("Evidence destination exists; no implicit reruns")
mkdirSync(root)
const save = (name:string, value:unknown) => writeFileSync(join(root,name),JSON.stringify(value,null,2))
const sha = (value:Buffer|string) => createHash("sha256").update(value).digest("hex")
const { runAdversarialEvaluation } = await import(pathToFileURL(join(repo,"scripts/adversarial-evaluation.ts")).href)
const { computeAlgSourceIdentity } = await import(pathToFileURL(join(repo,"src/source-identity.ts")).href)
const { seedVerificationHostDependencies } = await import(pathToFileURL(join(repo,"scripts/verification-host-dependencies.ts")).href)
const { verificationPluginConfiguration, realUserGlobalConfigRoots, snapshotGlobalOpenCodeConfig, stopCapturedProcess } = await import(pathToFileURL(join(repo,"scripts/live-verify.ts")).href)
const key = randomBytes(32), globals = realUserGlobalConfigRoots(), before = snapshotGlobalOpenCodeConfig(globals,key).sha256
const project=join(root,"project"), home=join(root,"home"), cfg=join(root,"config"), data=join(root,"data")
for (const path of [project,home,cfg,data,join(root,"tmp"),join(root,"cache"),join(root,"state"),join(data,"opencode")]) mkdirSync(path,{recursive:true})
seedVerificationHostDependencies(join(cfg,"opencode"),repo)
const env:Record<string,string>={}
for(const k of ["PATH","SystemRoot","WINDIR","ComSpec","PATHEXT"])if(process.env[k])env[k]=process.env[k]!
Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:join(home,"AppData/Roaming"),LOCALAPPDATA:join(home,"AppData/Local"),
  XDG_CONFIG_HOME:cfg,XDG_DATA_HOME:data,XDG_CACHE_HOME:join(root,"cache"),XDG_STATE_HOME:join(root,"state"),
  TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TMPDIR:join(root,"tmp"),OPENCODE_CONFIG:join(root,"opencode.json"),
  OPENCODE_ALG_CONFIG:join(root,"alg-options.json"),OPENCODE_DISABLE_PROJECT_CONFIG:"1",OPENCODE_DISABLE_DEFAULT_PLUGINS:"1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS:"1",OPENCODE_DISABLE_CLAUDE_CODE:"1",OPENCODE_DISABLE_CLAUDE_CODE_SKILLS:"1",
  OPENCODE_DISABLE_AUTOUPDATE:"1",OPENCODE_DISABLE_TELEMETRY:"1",DO_NOT_TRACK:"1",NO_COLOR:"1"})
const children:any[]=[]
function start(exe:string,args:string[],extra:Record<string,string>,name:string) {
  const child=spawn(exe,args,{cwd:project,env:{...env,...extra},shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]})
  const row={child,name,pid:child.pid,closed:false,code:null as number|null,stdout:"",stderr:""}
  child.stdout.on("data",b=>{row.stdout=(row.stdout+b.toString()).slice(-65536)})
  child.stderr.on("data",b=>{row.stderr=(row.stderr+b.toString()).slice(-65536)})
  child.on("close",code=>{row.closed=true;row.code=code});child.on("error",()=>{row.closed=true})
  children.push(row); return row
}
async function port():Promise<number> { const server=createServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const p=(server.address() as any).port;await new Promise<void>(r=>server.close(()=>r()));return p }
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const deadline=AbortSignal.timeout(30*60*1000), authCopy=join(data,"opencode/auth.json")
let failure:string|null=null, cleanup=true, report:any=null, calls=0, knownCost=0, capped=true, api:any, consecutiveTransportFailures=0
const identity=computeAlgSourceIdentity(repo), plugin=verificationPluginConfiguration(repo)
const provider=mode==="gemma"?"alg-local":"openai", model=mode==="gemma"?"gemma4":"gpt-6-luna"
const MAX_OUTPUT=2048
save("plan.json",{kind:"alg-paired-model-host",model:`${provider}/${model}`,calls_max:40,output_tokens_per_call:MAX_OUTPUT,wall_ms:1800000,
  per_call_ms:120000,consecutive_transport_failure_stop:3,reported_cost_stop_usd:5,source_sha256:identity.digest,started_at:new Date().toISOString(),harness_sha256:sha(readFileSync(import.meta.filename)),
  evaluator_sha256:sha(readFileSync(join(repo,"scripts/adversarial-evaluation.ts"))),cases_sha256:sha(readFileSync(join(repo,"scripts/adversarial-cases.ts"))),
  scope:"Synthetic fixed evidence; fresh real OpenCode sessions, ALG prompt/parser/validation; no live factory query or nested execution"})
try {
  let localBase:string|undefined
  if(mode==="gemma") {
    const p=await port();localBase=`http://127.0.0.1:${p}`
    const ollama=start("C:/Users/codym/AppData/Local/Programs/Ollama/ollama.exe",["serve"],{OLLAMA_HOST:`127.0.0.1:${p}`,OLLAMA_MODELS:"C:/Users/codym/.ollama/models",OLLAMA_NO_CLOUD:"1",OLLAMA_NUM_PARALLEL:"1",OLLAMA_CONTEXT_LENGTH:"16384",OLLAMA_KEEP_ALIVE:"10m"},"ollama")
    let ready=false
    for(let i=0;i<60;i++){if(ollama.closed)throw Error("local_model_startup_failed");try{ready=(await fetch(localBase+"/api/tags",{signal:AbortSignal.timeout(1000)})).ok}catch{}if(ready)break;await delay(500)}
    if(!ready)throw Error("local_model_unavailable")
    const response=await fetch(localBase+"/api/show",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model}),signal:AbortSignal.timeout(10000)})
    if(!response.ok)throw Error("local_model_metadata_unavailable")
    const info:any=await response.json();save("model.json",{name:model,details:info.details,capabilities:info.capabilities})
    // Load the existing local weights before timing paired requests; no benchmark question or answer is supplied.
    const warmStart=Date.now()
    const warm=await fetch(localBase+"/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({model,prompt:"",stream:false,keep_alive:"10m"}),signal:AbortSignal.any([deadline,AbortSignal.timeout(240000)])})
    if(!warm.ok)throw Error("local_model_preload_failed")
    const warmed:any=await warm.json()
    save("model-load.json",{elapsed_ms:Date.now()-warmStart,done:warmed.done,done_reason:warmed.done_reason,prompt_eval_count:warmed.prompt_eval_count??0,eval_count:warmed.eval_count??0})
  } else {
    // The host's built-in OAuth provider integration must remain available for the connected OpenAI account.
    delete env.OPENCODE_DISABLE_DEFAULT_PLUGINS
    const all=JSON.parse(readFileSync("C:/Users/codym/.local/share/opencode/auth.json","utf8"))
    if(!all.openai)throw Error("openai_not_connected")
    writeFileSync(authCopy,JSON.stringify({openai:all.openai}))
  }
  const config:any={plugin:[plugin.source.spec],autoupdate:false,share:"disabled",snapshot:false,model:`${provider}/${model}`,small_model:`${provider}/${model}`,
    permission:{"*":"deny"},mcp:{},compaction:{auto:false,prune:false},
    provider:mode==="gemma"?{"alg-local":{npm:"@ai-sdk/openai-compatible",name:"Local benchmark",options:{baseURL:localBase+"/v1"},models:{gemma4:{name:"Local Gemma4",tool_call:true,limit:{context:16384,output:MAX_OUTPUT}}}}}:
      {openai:{models:{"gpt-6-luna":{limit:{context:128000,output:MAX_OUTPUT}}}}},
    agent:{evaluation:{mode:"primary",steps:1,permission:{"*":"deny"},prompt:"Evaluate only the supplied synthetic case. Do not use tools, files or external sources. Follow the supplied JSON output contract. Do not claim evidence beyond the provided data."}}}
  save("opencode.json",config);save("alg-options.json",{skillEvolution:{enabled:false},sessionMemory:{mode:"off"},environmentMemory:{mode:"off"}})
  const p=await port(),password=randomBytes(24).toString("hex")
  const server=start("C:/Users/codym/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.exe",["serve","--hostname","127.0.0.1","--port",String(p)],{OPENCODE_SERVER_PASSWORD:password},"opencode")
  api=async(path:string,body?:unknown,ms=15000)=>{
    const url=new URL(path,`http://127.0.0.1:${p}`);url.searchParams.set("directory",project)
    const response=await fetch(url,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",Authorization:"Basic "+Buffer.from("opencode:"+password).toString("base64")},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([deadline,AbortSignal.timeout(ms)])})
    if(!response.ok)throw Error(`host_http_${response.status}`)
    return await response.json()
  }
  let ready=false
  for(let i=0;i<120;i++){if(server.closed)throw Error("host_startup_failed");try{await api("/global/health",undefined,1000);ready=true}catch{}if(ready)break;await delay(500)}
  if(!ready)throw Error("host_unavailable")
  const providers=await api("/provider",undefined,60000), selected=providers.all.find((x:any)=>x.id===provider)?.models?.[model]
  if(!selected||!providers.connected.includes(provider))throw Error("requested_model_unavailable")
  save("preflight.json",{health:await api("/global/health"),selected:{id:model,provider,limit:selected.limit,capabilities:selected.capabilities},source:plugin.source.digest,tools_disabled:true})
  if(selected.limit?.output!==MAX_OUTPUT)throw Error("model_output_limit_not_applied")
  const toolIds=await api("/experimental/tool/ids"), tools=Object.fromEntries(toolIds.map((id:string)=>[id,false]))
  const complete=async(request:any)=>{
    if(calls>=40||deadline.aborted||knownCost>=5)throw Error("trial_budget_exhausted")
    if(consecutiveTransportFailures>=3)throw Error("provider_failure_stop")
    if(request.maxOutputTokens!==MAX_OUTPUT)throw Error("unequal_provider_output_limit")
    calls++;const started=Date.now();const session=await api("/session",{title:`Paired synthetic evaluation ${calls}`})
    try {
      const response=await api(`/session/${session.id}/message`,{model:{providerID:provider,modelID:model},agent:"evaluation",parts:[{type:"text",text:request.prompt}],tools},120000)
      if(response.info?.error)throw Error("provider_response_error")
      const text=(response.parts??[]).filter((x:any)=>x.type==="text").map((x:any)=>x.text??"").join("\n")
      const tokens=response.info?.tokens
      if(!tokens||!Number.isFinite(tokens.input)||!Number.isFinite(tokens.output))throw Error("usage_missing")
      const usage={input:tokens.input,output:tokens.output,reasoning:tokens.reasoning??0,cacheRead:tokens.cache?.read??0,cacheWrite:tokens.cache?.write??0}
      const cost=Number.isFinite(response.info?.cost)?response.info.cost:undefined;knownCost+=cost??0
      if(usage.output+usage.reasoning>MAX_OUTPUT)capped=false
      save(`call-${String(calls).padStart(2,"0")}.json`,{session:session.id,model:response.info?.modelID,provider:response.info?.providerID,usage,costUsd:cost??null,
        finish:response.info?.finish??null,elapsed_ms:Date.now()-started,output_limit_met:usage.output+usage.reasoning<=MAX_OUTPUT})
      console.log(JSON.stringify({event:"call",model,call:calls,ms:Date.now()-started,output:usage.output,reasoning:usage.reasoning}))
      consecutiveTransportFailures=0
      return {text,actualTokens:Object.values(usage).reduce((a,b)=>a+b,0),usage,costUsd:cost,durationMs:Date.now()-started}
    } catch(error) { consecutiveTransportFailures++; await api(`/session/${session.id}/abort`,{},5000).catch(()=>{});throw error }
  }
  report=await runAdversarialEvaluation({model:`${provider}/${model}`,complete,artifactDirectory:root,reviewMaxOutputTokens:MAX_OUTPUT,checkerMaxOutputTokens:MAX_OUTPUT})
} catch(error){failure=error instanceof Error?error.message:"harness_failure"}
finally {
  for(const row of children.slice().reverse()) { const stopped=await stopCapturedProcess({child:row.child,stdout:()=>row.stdout,stderr:()=>row.stderr,exit:()=>({observed:row.closed||row.child.exitCode!==null,code:row.code??row.child.exitCode,signal:row.child.signalCode})});cleanup&&=stopped.passed }
  if(existsSync(authCopy))unlinkSync(authCopy)
  for(const name of ["id_ed25519","id_ed25519.pub"]){const path=join(home,".ollama",name);if(existsSync(path))unlinkSync(path)}
  const unchanged=snapshotGlobalOpenCodeConfig(globals,key).sha256===before
  const sourceUnchanged=computeAlgSourceIdentity(repo).digest===identity.digest
  const result={complete:!!report,failure,source_sha256:identity.digest,source_unchanged:sourceUnchanged,model:`${provider}/${model}`,actual_calls:calls,known_reported_cost:knownCost,
    output_cap_observed:capped,cleanup,auth_copy_removed:!existsSync(authCopy),global_config_unchanged:unchanged,report:report?{runId:report.runId,paired:report.paired,schemaFailures:report.schemaFailures,transportFailures:report.transportFailures}:null,
    processes:children.map(row=>({name:row.name,pid:row.pid,closed:row.closed,exit_code:row.code}))}
  save("result.json",result);console.log(JSON.stringify(result));process.exitCode=failure||!cleanup||!unchanged||!sourceUnchanged?1:0
}
