import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const result=await build({entryPoints:['src/lib/native-monitor.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {nativeMonitorData}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const inventory={memory:{totalGb:64},gpus:[{id:'gpu0',index:0,vramGb:24,unified:false}]};
const instance={id:'one',model:'q2_0',label:'Qwen3.8-Flash-Next',context:32768,gpus:[0],phase:'generating',loadedAt:'2026-10-14T10:00:00Z',metrics:{time:100,live:{state:'generating',prompt_tokens:1000,generated:20,tok_s:12,prefill_tok_s_mean:250,queued:0},engine:{max_context:32768,expert_slots:32,experts:256},hardware:{cpu:30,ram_used:16*1024**3,ram_total:64*1024**3,gpu_mem_used:10*1024**3,gpu_util:80,gpu_temp:60},history:{tok_s:[10,null,12],gpu_mem_used:[9*1024**3,null,10*1024**3]},requests:[{id:'request',time:90,prompt_tokens:1000,reused:500,output_tokens:100,decode_tok_s:10,decode_peak_tok_s:15,prompt_ms:2000,duration_s:10}],totals:{requests:1,prompt_tokens:1000,reused:500,output_tokens:100,prompt_ms:2000,decode_ms:10000}}};
test('native facts feed existing charts, context and request history with correct units',()=>{
 const data=nativeMonitorData({instances:[instance],hardware:{gpus:[{index:0}]}},inventory);
 assert.equal(data.outputTps,12);assert.equal(data.context.usedTokens,1020);assert.equal(data.hardware.ramUsedGb,16);assert.equal(data.hardware.gpus[0].memoryUsedGb,10);
 assert.deepEqual(data.history.map(sample=>sample.outputTps),[10,null,12]);assert.deepEqual(data.history.map(sample=>sample.t),[98000,99000,100000]);assert.equal(data.requests[0].promptTps,250);assert.equal(data.requests[0].peakTps,15);assert.equal(data.totals.cachedTokens,500);
});
test('missing request peak remains unknown',()=>{
 const request={...instance.metrics.requests[0],decode_peak_tok_s:undefined};
 const data=nativeMonitorData({instances:[{...instance,metrics:{...instance.metrics,requests:[request]}}]},inventory);
 assert.equal(data.requests[0].peakTps,null);
});
test('missing native measurements stay unknown and do not use demo readings',()=>{
 const data=nativeMonitorData({instances:[{...instance,metrics:null}],hardware:{gpus:[{index:0}]}},inventory);
 assert(Number.isNaN(data.outputTps));assert.equal(data.hardware.ramUsedGb,null);assert.equal(data.hardware.gpus[0].utilizationPct,null);assert.equal(data.telemetry.throughput,'unavailable');assert.deepEqual(data.history,[]);assert(Number.isNaN(data.context.usedTokens));
});
test('model scope filters requests and does not add system RAM once per model',()=>{
 const other={...instance,id:'two',model:'other',metrics:{...instance.metrics,time:101,hardware:{...instance.metrics.hardware,ram_used:20*1024**3},requests:[]}};
 const data=nativeMonitorData({instances:[instance,other],hardware:{gpus:[{index:0}]}},inventory,'one');assert.equal(data.requests.length,1);assert.equal(data.requests[0].instanceId,'one');assert.equal(data.hardware.ramUsedGb,20);
});

test('active requests retain their engine scope and per-request readings',()=>{
 const withRequests=(id,requests)=>({...instance,id,metrics:{...instance.metrics,live:{...instance.metrics.live,requests}}});
 const running={id:'r1',state:'generating',prompt_tokens:100,generated:20,max_tokens:400,max_context:32768,tok_s:13.5,elapsed_s:7};
 const queued={id:'r2',state:'queued',prompt_tokens:200,max_tokens:500,elapsed_s:9};
 const native={instances:[withRequests('one',[running,null]),withRequests('two',[queued])]};
 assert.deepEqual(nativeMonitorData(native,inventory).activeRequests.map(r=>[r.id,r.instanceId,r.elapsed]),[['r2','two',9],['r1','one',7]]);
 assert.deepEqual(nativeMonitorData(native,inventory,'one').activeRequests,[{
  id:'r1',instanceId:'one',model:instance.label,state:'generating',promptTokens:100,outputTokens:20,
  maxTokens:400,maxContext:32768,tps:13.5,elapsed:7,
 }]);
 assert.equal(nativeMonitorData(native,inventory,'two').activeRequests[0].outputTokens,null);
});

test('GPU histories retain their device scope and never spread one card reading across multiple GPUs',()=>{
 const two={...inventory,gpus:[...inventory.gpus,{id:'gpu1',index:1,vramGb:24,unified:false}]};
 const data=nativeMonitorData({instances:[instance],hardware:{gpus:[{index:0},{index:1}]}},two);
 assert.deepEqual(data.history[0].gpuIds,['gpu0']);assert.equal(data.history[0].gpus.length,1);assert.equal(data.hardware.gpus[1].utilizationPct,null);
 const split={...instance,gpus:[0,1],metrics:{...instance.metrics,hardware:{...instance.metrics.hardware,gpus:[{index:0,util:40},{index:1,util:80}]}}};
 const across=nativeMonitorData({instances:[split],hardware:{gpus:[{index:0},{index:1}]}},two);
 assert.deepEqual(across.history[0].gpuIds,['gpu0','gpu1']);assert.equal(across.history[0].gpus,undefined);assert.deepEqual(across.hardware.gpus.map(gpu=>gpu.utilizationPct),[40,80]);
});
