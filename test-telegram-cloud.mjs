import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runBridge,loadBridgeSources,TelegramBridgeError} from './telegram-cloud.mjs';
const token='app12345:not-a-real-credential-for-tests',sources={'endpoints/paper_bridge':'export default async (input,ctx) => ({mode:"SIMULATION_ONLY"});'};
const options={app:'app12345',token,sources};
const success=result=>Response.json({ok:true,result:{result,log:[{text:token}],time:0.001}});
const rejected=code=>error=>error instanceof TelegramBridgeError&&error.code===code&&!error.message.includes(token);

test('uses official CLI run contract, fixed module/origin and header-only credential',async()=>{
 let calls=0;
 const input={operation:'propose',signal:{symbol:'HYPE'}};
 const result=await runBridge(input,{...options,fetcher:async(url,request)=>{
  calls++;assert.equal(url,'https://cloud.telegram.org/app12345/manage/run');assert.equal(request.method,'POST');assert.equal(request.redirect,'error');assert.equal(request.headers.Authorization,`Bearer ${token}`);assert(request.signal instanceof AbortSignal);
  const body=JSON.parse(request.body);assert.deepEqual(body,{module:'endpoints/paper_bridge',sources,args:input,ctx:{sentinelAutomation:true}});assert(!request.body.includes(token));
  return success({status:'PENDING',mode:'SIMULATION_ONLY'});
 }});
 assert.deepEqual(result,{status:'PENDING',mode:'SIMULATION_ONLY'});assert.equal(calls,1);assert(!JSON.stringify(result).includes(token));
});
test('derives app identity from credential without a configurable destination',async()=>{
 const value=await runBridge({operation:'drain'},{token,sources,fetcher:async url=>{assert.equal(url,'https://cloud.telegram.org/app12345/manage/run');return success({orders:[]});}});assert.deepEqual(value,{orders:[]});
});
test('rejects mismatched app, header injection, invalid graphs and embedded credentials before fetch',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return success({});};
 await assert.rejects(()=>runBridge({}, {...options,app:'app999',fetcher}),rejected('CONFIGURATION'));
 await assert.rejects(()=>runBridge({}, {...options,app:'https://attacker.example',fetcher}),rejected('CONFIGURATION'));
 await assert.rejects(()=>runBridge({}, {...options,token:token+'\r\nInjected: value',fetcher}),rejected('CONFIGURATION'));
 await assert.rejects(()=>runBridge({}, {...options,sources:{'handlers/message':'export default ()=>{}'},fetcher}),rejected('SOURCE'));
 await assert.rejects(()=>runBridge({token}, {...options,fetcher}),rejected('CREDENTIAL_BOUNDARY'));
 await assert.rejects(()=>runBridge({}, {...options,sources:{...sources,'lib/key':token},fetcher}),rejected('CREDENTIAL_BOUNDARY'));
 await assert.rejects(()=>runBridge({data:'x'.repeat(1048576)}, {...options,fetcher}),rejected('REQUEST_TOO_LARGE'));
 assert.equal(calls,0);
});
test('uses one bounded POST and reports ambiguous delivery without retrying or provider details',async()=>{
 let calls=0;
 await assert.rejects(()=>runBridge({operation:'ack'}, {...options,fetcher:async()=>{calls++;throw Error(token+' secret server detail');}}),rejected('NETWORK'));assert.equal(calls,1);
 for(const [status,code] of [[401,'AUTHORIZATION'],[403,'AUTHORIZATION'],[429,'RATE_LIMIT'],[302,'HTTP'],[500,'HTTP']])await assert.rejects(()=>runBridge({}, {...options,fetcher:async()=>new Response(token,{status})}),rejected(code));
 await assert.rejects(()=>runBridge({}, {...options,timeoutMs:5,fetcher:async(_url,request)=>new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(Error(token)),{once:true}))}),rejected('NETWORK'));
});
test('bounds response bytes and rejects malformed/failed run envelopes without returning logs',async()=>{
 const responses=[
  [new Response('x'.repeat(262145)), 'RESPONSE_TOO_LARGE'],
  [new Response('{}',{headers:{'Content-Length':'262145'}}),'RESPONSE_TOO_LARGE'],
  [new Response('not JSON '+token),'INVALID_RESPONSE'],
  [Response.json({ok:false,description:token,parameters:{log:token}}),'RUN_FAILED'],
  [Response.json({ok:true,result:{log:token}}),'INVALID_RESPONSE'],
  [success({secret:token}),'CREDENTIAL_BOUNDARY'],
 ];
 for(const [response,code] of responses)await assert.rejects(()=>runBridge({}, {...options,fetcher:async()=>response}),rejected(code));
});
test('loads a complete local graph with only deployable JS module names and rejects symlinks',()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'sentinel-tgcloud-'));
 try{
  for(const folder of ['endpoints','handlers','lib','lib/internal'])mkdirSync(path.join(directory,folder),{recursive:true});
  const files={'schema.js':'schema','endpoints/paper_bridge.js':'bridge','handlers/callback_query.js':'callback','lib/internal/store.js':'store','README.md':'not deployed'};
  for(const [name,body] of Object.entries(files))writeFileSync(path.join(directory,name),body);
  assert.deepEqual(loadBridgeSources(directory),{'endpoints/paper_bridge':'bridge','handlers/callback_query':'callback','lib/internal/store':'store',schema:'schema'});
  symlinkSync(path.join(directory,'schema.js'),path.join(directory,'lib/credential.js'));assert.throws(()=>loadBridgeSources(directory),rejected('SOURCE'));
 }finally{rmSync(directory,{recursive:true,force:true});}
});
