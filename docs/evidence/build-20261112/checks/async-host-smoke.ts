import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
const repo=process.env.ALG_BENCHMARK_REPO!,exe=process.env.ALG_BENCHMARK_HOST!,root=process.argv[2]!
if(!repo||!exe||!root)throw Error("missing explicit smoke paths")
let calls=0
const service=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  const body=await req.json() as any;calls++
  await Bun.sleep(500)
  const common={id:`synthetic-${calls}`,object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:body.model}
  const text=[{...common,choices:[{index:0,delta:{role:"assistant",content:"Transport fixture complete."},finish_reason:null}]},
    {...common,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:16,completion_tokens:4,total_tokens:20}}]
    .map(row=>`data: ${JSON.stringify(row)}\n\n`).join("")+"data: [DONE]\n\n"
  return new Response(text,{headers:{"content-type":"text/event-stream"}})
}})
try{
  const {runBuildBenchmark}=await import(pathToFileURL(join(repo,"scripts/build-benchmark.ts")).href)
  await runBuildBenchmark({outputRoot:root,hostExecutable:exe,providerID:"transport-fixture",modelID:"synthetic",caseIds:["wafer-report-staged"],
    provider:{"transport-fixture":{npm:"@ai-sdk/openai-compatible",name:"Synthetic transport fixture",options:{baseURL:`http://127.0.0.1:${service.port}/v1`},models:{synthetic:{name:"Synthetic",tool_call:true,limit:{context:32768,output:4096}}}}}})
  const result=JSON.parse(readFileSync(join(root,"result.json"),"utf8"))
  if(!result.complete||result.fatal||!result.global_configuration_unchanged||result.results.some((r:any)=>r.status!=="preparation_milestone_not_reached"||!r.phases.some((p:any)=>p.phase==="initial"&&p.completed)||!r.cleanup||!r.metering_complete))throw Error("async host transport qualification failed")
  console.log(JSON.stringify({transport_smoke_passed:true,trials:result.results.length,synthetic_provider_calls:calls,quality_inference:false}))
}finally{service.stop(true)}
