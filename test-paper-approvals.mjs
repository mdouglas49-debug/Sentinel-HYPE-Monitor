import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApprovalRunner,approvalsEnabled} from './paper-approvals.mjs';
import {updateJournal} from './paper-journal.mjs';

const owner='123456',token='app12345:fixture-not-a-real-credential';
const end=Date.UTC(2026,10,4,16),approvedAt=end-240000+1000;
const order={mode:'SIMULATION_ONLY',status:'SIMULATED_ORDER',symbol:'HYPE',timeframe:'5m',side:'BUY',signal_id:`HYPE-5m-${end-600000}`,candle_utc:new Date(end-600000).toISOString(),timestamp:new Date(approvedAt).toISOString(),entry:100,stop:98,target:104,reward_to_risk:2};
const settings={PAPER_APPROVALS_ENABLED:'true',TELEGRAM_CHAT_ID:owner,TGCLOUD_TOKEN:token,TGCLOUD_APP_NAME:'app12345'};
function setup(t,{payload=order,bridgeStatus={},failure}={}){
 const root=mkdtempSync(join(tmpdir(),'sentinel-approval-runner-')),calls=[];
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 let delivered=false;
 const call=async(input,options)=>{
  assert.equal(options.token,token);assert.equal(options.app,'app12345');assert(!JSON.stringify(input).includes(token));calls.push(input);
  if(failure)throw Error(token+' provider-detail');
  if(input.operation==='status')return {configured:true,enabled:true,ownerId:owner,chatId:owner,bot_username:'SentinelHypeAI_bot',...bridgeStatus};
  if(input.operation==='drain'){assert.equal(input.limit,1);return {orders:delivered?[]:[payload],signal_ids:delivered?[]:[payload.signal_id],pending:delivered?0:1};}
  if(input.operation==='acknowledge'){delivered=true;return {acknowledged:1,signal_ids:input.signal_ids};}
  if(input.operation==='propose')return {status:'SENT',signal_id:order.signal_id,expires_at:end+90000};
  if(input.operation==='configure')return {configured:true,enabled:input.enabled,ownerId:input.ownerId,chatId:input.chatId};
  throw Error('Unexpected bridge operation');
 };
 const env={...settings},runner=createApprovalRunner({env,root,call,now:()=>end});
 return {root,env,runner,calls,call};
}
test('legacy mode leaves automatic simulation intact and never calls Telegram bridge',async t=>{
 assert.equal(approvalsEnabled(),false);assert.equal(approvalsEnabled('true'),true);assert.throws(()=>approvalsEnabled('TRUE'));
 const {root}=setup(t);writeFileSync(join(root,'simulated-order.json'),'legacy');
 const runner=createApprovalRunner({env:{},root,call:async()=>assert.fail('disabled approval mode called bridge')});
 assert.deepEqual(await runner.drain(),{enabled:false,has_order:false});assert.equal(readFileSync(join(root,'simulated-order.json'),'utf8'),'legacy');assert.deepEqual(await runner.acknowledge(),{acknowledged:0});
});
test('approved order keeps original schema, approval timing, and journal is duplicate-free through retry/restart',async t=>{
 const {root,runner,env,call}=setup(t);
 assert.equal((await runner.drain()).has_order,true);
 const original=readFileSync(join(root,'simulated-order.json'),'utf8'),record=JSON.parse(original);
 assert.deepEqual(record,order);assert.equal(record.timestamp,new Date(approvedAt).toISOString());assert(!original.includes(token));
 const first=Math.ceil(approvedAt/60000)*60000,bars=[{t:first,o:100,h:101,l:99,c:100},{t:first+60000,o:100,h:105,l:99,c:104}];
 const previous=updateJournal(null,null,[],Math.floor((approvedAt-60000)/60000)*60000);
 let journal=updateJournal(previous,record,bars,end);
 assert.equal(journal.orders.length,1);assert.equal(journal.orders[0].tracking.state,'CLOSED');assert(journal.orders[0].tracking.filled_at>=record.timestamp);
 const restarted=createApprovalRunner({env,root,call,now:()=>end});await restarted.drain();assert.equal(readFileSync(join(root,'simulated-order.json'),'utf8'),original);
 journal=updateJournal(JSON.parse(JSON.stringify(journal)),JSON.parse(original),bars,end+60000);assert.equal(journal.orders.length,1);assert.equal(journal.portfolio.orders.length,1);
 await assert.rejects(()=>restarted.acknowledge(),/both saved artifacts/);
 env.PAPER_SIMULATION_UPLOADED='true';await assert.rejects(()=>restarted.acknowledge(),/both saved artifacts/);
 env.PAPER_JOURNAL_UPLOADED='true';assert.equal((await restarted.acknowledge()).acknowledged,1);
 assert.equal((await restarted.drain()).has_order,false);assert.equal(existsSync(join(root,'simulated-order.json')),false);
});
test('missing credentials, wrong owner or disabled remote bridge cannot fall back to an old simulation',async t=>{
 for(const bridgeStatus of [{ownerId:'999'},{chatId:'999'},{enabled:false},{configured:false},{bot_username:'Wrong_bot'}]){
  const {root,runner}=setup(t,{bridgeStatus});writeFileSync(join(root,'simulated-order.json'),'old unapproved order');
  await assert.rejects(()=>runner.drain(),/configuration|disabled|different bot/);assert.equal(existsSync(join(root,'simulated-order.json')),false);
 }
 const {root}=setup(t);const runner=createApprovalRunner({env:{...settings,TGCLOUD_TOKEN:''},root,call:async()=>assert.fail('missing credentials reached bridge')});await assert.rejects(()=>runner.drain(),/Configure TGCLOUD_TOKEN/);
});
test('forged live/invalid/future approvals and mismatched IDs never write an order',async t=>{
 for(const payload of [{...order,mode:'LIVE'},{...order,stop:101},{...order,timestamp:new Date(end+120000).toISOString()},{...order,timestamp:order.candle_utc}]){
  const {root,runner}=setup(t,{payload});await assert.rejects(()=>runner.drain());assert.equal(existsSync(join(root,'simulated-order.json')),false);
 }
 const {root,env}=setup(t);const runner=createApprovalRunner({env,root,now:()=>end,call:async input=>input.operation==='status'?{configured:true,enabled:true,ownerId:owner,chatId:owner,bot_username:'SentinelHypeAI_bot'}:{orders:[order],signal_ids:['wrong']}});await assert.rejects(()=>runner.drain(),/IDs do not match/);assert(!existsSync(join(root,'simulated-order.json')));
});
test('tampered receipt/file cannot consume an approved decision',async t=>{
 const {root,runner,env,calls}=setup(t);await runner.drain();env.PAPER_SIMULATION_UPLOADED='true';env.PAPER_JOURNAL_UPLOADED='true';
 writeFileSync(join(root,'simulated-order.json'),JSON.stringify({...order,entry:101,target:108}));
 await assert.rejects(()=>runner.acknowledge(),/receipt changed/);assert(!calls.some(c=>c.operation==='acknowledge'));
});
test('proposals only accept qualifying scanner output and return no credentials',async t=>{
 const {root,runner,calls}=setup(t);writeFileSync(join(root,'latest-signal.json'),JSON.stringify({...order,status:'NO_SIGNAL'}));
 await assert.rejects(()=>runner.propose(),/qualifying/);assert(!calls.some(c=>c.operation==='propose'));
 writeFileSync(join(root,'latest-signal.json'),JSON.stringify({...order,status:'SIGNAL_PREVIEW_ONLY'}));const result=await runner.propose();assert.equal(result.status,'SENT');assert(!JSON.stringify(result).includes(token));
});
