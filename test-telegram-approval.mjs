// Real SQLite + a fake SDK exercises the deployable serverless modules without
// Telegram sends, GitHub dispatches, credentials or exchange execution.
import assert from 'node:assert/strict';
import {createTelegramRuntime} from './test-support/telegram-runtime.mjs';
const runtime=await createTelegramRuntime({now:Date.parse('2026-11-04T16:20:15.000Z')});
const {sent,answers,edits}=runtime;
const context={sentinelAutomation:true},owner='123456789';
const freshSignal=()=>({status:'SIGNAL_PREVIEW_ONLY',symbol:'HYPE',timeframe:'5m',side:'BUY',entry:100,stop:98,target:104,candle_utc:new Date(Math.floor(runtime.now/300000)*300000-300000).toISOString()});
const callback=(proposal,choice='yes',overrides={})=>({id:'callback-'+proposal.message_id+'-'+choice,data:`sp:${choice}:${proposal.proposal_id}`,from:{id:Number(owner)},message:{message_id:proposal.message_id,chat:{id:Number(owner),type:'private'}},...overrides});
let bridge=runtime.endpoint,handle=runtime.callback;
try{
 const endpoint=runtime.endpoint;
 const status=await endpoint({operation:'status'},context);assert.equal(status.configured,false);assert.equal(status.bot_username,'SentinelHypeAI_bot');
 await assert.rejects(()=>endpoint({operation:'configure',ownerId:owner,chatId:owner,enabled:true},{}),/management/);
 await assert.rejects(()=>endpoint({operation:'drain'},{sentinelAutomation:true,initData:{user:{id:Number(owner)}}}),/management/);
 assert.equal((await bridge({operation:'propose',signal:freshSignal()},context)).status,'DISABLED');assert.equal(sent.length,0);
 await assert.rejects(()=>bridge({operation:'configure',ownerId:owner,chatId:'987654321',enabled:true},context),/private owner/);
 await assert.rejects(()=>bridge({operation:'configure',ownerId:'1 OR 1=1',chatId:owner,enabled:true},context),/Invalid/);
 await bridge({operation:'configure',ownerId:owner,chatId:owner,enabled:true},context);
 for(const signal of [{...freshSignal(),candle_utc:new Date(runtime.now-1000).toISOString()},{...freshSignal(),entry:'100'},{...freshSignal(),symbol:'BTC'},{...freshSignal(),stop:101},{...freshSignal(),candle_utc:new Date(runtime.now-600001).toISOString()}])await assert.rejects(()=>bridge({operation:'propose',signal},context));
 const first=await bridge({operation:'propose',signal:freshSignal()},context);assert.equal(first.status,'SENT');assert.equal(first.expires_at,runtime.now+90000);assert(sent.at(-1).text.includes('No live order'));
 const repeat=await bridge({operation:'propose',signal:{...freshSignal(),entry:100.2}},context);assert.equal(repeat.status,'DUPLICATE');assert.equal(repeat.proposal_id,first.proposal_id);assert.equal(sent.length,1);
 assert.equal((await handle(callback(first,'yes',{from:{id:999}}))).status,'UNAUTHORIZED');
 assert.equal((await handle(callback(first,'yes',{message:{message_id:first.message_id,chat:{id:Number(owner),type:'group'}}}))).status,'UNAUTHORIZED');
 assert.equal((await handle(callback(first,'yes',{message:{message_id:first.message_id+1,chat:{id:Number(owner),type:'private'}}}))).status,'UNBOUND');
 assert.equal((await bridge({operation:'drain'},context)).orders.length,0);
 assert.deepEqual((await bridge({operation:'acknowledge',signal_ids:[first.signal_id,'HYPE-5m-1']},context)).signal_ids,[],'Unknown or pending proposals cannot be confirmed as delivered');
 const decidedAt=runtime.now+1200;runtime.now=decidedAt;
 await Promise.all([handle(callback(first,'yes')),handle(callback(first,'no')),handle(callback(first,'yes'))]);
 let drained=await bridge({operation:'drain'},context);assert.equal(drained.orders.length,1);assert.equal(drained.orders[0].timestamp,new Date(decidedAt).toISOString());assert.equal(drained.orders[0].signal_id,first.signal_id);assert.deepEqual(Object.keys(drained.orders[0]).sort(),['mode','signal_id','symbol','timeframe','side','entry','stop','target','reward_to_risk','status','candle_utc','timestamp'].sort());assert.equal(drained.orders[0].mode,'SIMULATION_ONLY');assert.equal(drained.orders[0].status,'SIMULATED_ORDER');
 const frozen=JSON.stringify(drained.orders);runtime.now+=1000;await handle(callback(first,'yes'));assert.equal(JSON.stringify((await bridge({operation:'drain'},context)).orders),frozen);
 // Restart the durable SDK database and module. No in-memory decision is needed.
 await runtime.restart();bridge=runtime.endpoint;
 assert.equal(JSON.stringify((await bridge({operation:'drain'},context)).orders),frozen);
 await bridge({operation:'acknowledge',signal_ids:[first.signal_id,first.signal_id]},context);assert.equal((await bridge({operation:'drain'},context)).orders.length,0);assert.equal((await bridge({operation:'acknowledge',signal_ids:[first.signal_id]},context)).acknowledged,0);assert.deepEqual((await bridge({operation:'acknowledge',signal_ids:[first.signal_id,'HYPE-5m-1']},context)).signal_ids,[first.signal_id]);
 await assert.rejects(()=>bridge({operation:'drain',limit:51},context),/1–50/);await assert.rejects(()=>bridge({operation:'acknowledge',signal_ids:['bad-id']},context),/Sentinel/);
 runtime.now+=300000;const rejected=await bridge({operation:'propose',signal:freshSignal()},context);assert.equal((await handle(callback(rejected,'no'))).status,'REJECTED');assert.equal((await handle(callback(rejected,'yes'))).status,'REJECTED');assert.deepEqual((await bridge({operation:'acknowledge',signal_ids:[rejected.signal_id]},context)).signal_ids,[]);assert.equal((await bridge({operation:'drain'},context)).orders.length,0);
 runtime.now+=300000;const expiring=await bridge({operation:'propose',signal:freshSignal()},context);runtime.now=expiring.expires_at;assert.equal((await handle(callback(expiring,'yes'))).status,'EXPIRED');assert.equal((await bridge({operation:'drain'},context)).orders.length,0);
 // Disabling between callback load and CAS must fail closed atomically.
 runtime.now+=300000;const racing=await bridge({operation:'propose',signal:freshSignal()},context);runtime.disableDuringDecision=true;assert.equal((await handle(callback(racing,'yes'))).status,'PENDING');assert.equal(runtime.sqlite.prepare('SELECT approved_order_json FROM sentinel_paper_proposals WHERE id = ?').get(racing.proposal_id).approved_order_json,null);await bridge({operation:'configure',ownerId:owner,chatId:owner,enabled:true},context);await handle(callback(racing,'no'));
 // Lost Telegram send results do not create a new proposal, refresh expiry, or
 // change the payload. Only the latest confirmed message may approve it.
 runtime.now+=300000;const retriedSignal=freshSignal();runtime.loseNextSend=true;await assert.rejects(()=>bridge({operation:'propose',signal:retriedSignal},context),/not confirmed/);const lost=sent.at(-1),original=runtime.sqlite.prepare('SELECT * FROM sentinel_paper_proposals WHERE signal_id = ?').get(`HYPE-5m-${Date.parse(retriedSignal.candle_utc)}`);
 runtime.now+=1000;const recovered=await bridge({operation:'propose',signal:retriedSignal},context);assert.equal(recovered.proposal_id,original.id);assert.equal(recovered.expires_at,original.expires_at);assert.notEqual(recovered.message_id,lost.message_id);assert.equal((await handle(callback(recovered,'yes',{message:{message_id:lost.message_id,chat:{id:Number(owner),type:'private'}}}))).status,'UNBOUND');assert.equal((await handle(callback(recovered,'yes'))).status,'APPROVED_PAPER');
 drained=await bridge({operation:'drain'},context);assert.equal(drained.orders.length,1);assert.equal(drained.signal_ids[0],recovered.signal_id);
 // A slow send whose lease is replaced must not claim successful delivery
 // when the replacement also fails. Otherwise the scanner could cache the
 // candle and suppress the only viable retry.
 runtime.now+=300000;const leaseSignal=freshSignal(),realSend=runtime.sdk.api.sendMessage;
 let releaseSlow,startSlow,attempts=0;
 const slowStarted=new Promise(resolve=>{startSlow=resolve;});
 runtime.sdk.api.sendMessage=async payload=>{const attempt=++attempts,result=await realSend(payload);if(attempt===1){startSlow();await new Promise(resolve=>{releaseSlow=resolve;});return result;}throw Error('Replacement send was unconfirmed');};
 try{
  const slowProposal=bridge({operation:'propose',signal:leaseSignal},context);await slowStarted;
  runtime.now+=30001;await assert.rejects(()=>bridge({operation:'propose',signal:leaseSignal},context),/not confirmed/);
  releaseSlow();const pendingDelivery=await slowProposal;assert.equal(pendingDelivery.status,'DELIVERY_PENDING');assert.equal(pendingDelivery.message_id,null);
 }finally{runtime.sdk.api.sendMessage=realSend;}
 const leaseRecovered=await bridge({operation:'propose',signal:leaseSignal},context);assert.equal(leaseRecovered.status,'SENT');await handle(callback(leaseRecovered,'no'));
 const handler=runtime.message;
 const beforeTest=drained.orders.length;await handler({chat:{id:Number(owner),type:'private'},from:{id:Number(owner)},text:'/paper-test'});const demo=sent.at(-1);assert.equal(demo.reply_markup.inline_keyboard[0][0].callback_data,'sentinel_demo_yes_v1');assert.equal((await handle({id:'demo',data:'sentinel_demo_yes_v1',from:{id:Number(owner)},message:{message_id:demo.message_id,chat:{id:Number(owner),type:'private'}}})).status,'TEST_ONLY');assert.equal((await bridge({operation:'drain'},context)).orders.length,beforeTest);
 const sentBefore=sent.length;await handler({chat:{id:999,type:'private'},from:{id:999},text:'/scan'});assert.equal(sent.length,sentBefore);assert.equal(runtime.marketReads,0);
 await handler({chat:{id:Number(owner),type:'private'},from:{id:Number(owner)},text:'/scan'});assert.equal(runtime.marketReads,1);assert(sent.at(-1).text.includes('Status: NO_SIGNAL'));assert.equal((await bridge({operation:'drain'},context)).orders.length,beforeTest);
 await bridge({operation:'configure',ownerId:owner,chatId:owner,enabled:false},context);assert.equal((await bridge({operation:'drain'},context)).status,'DISABLED');assert.equal((await handle(callback(recovered,'yes'))).status,'UNAUTHORIZED');await bridge({operation:'configure',ownerId:owner,chatId:owner,enabled:true},context);assert.equal((await bridge({operation:'drain'},context)).orders.length,1);
 assert(answers.length>0&&edits.length>0);console.log('Telegram approval checks passed: authenticated management context, configured owner/private chat, message binding, atomic YES/NO, immutable payload, 90s expiry, restart recovery, send retry, durable drain/ack, unchanged simulation JSON, read-only /scan and inert button test.');
}finally{runtime.close();}
