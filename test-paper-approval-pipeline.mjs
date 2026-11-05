// Full deployable SDK -> runner -> original simulation JSON -> journal path.
// Telegram is a fake API; SDK decisions/outbox use actual durable SQLite.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTelegramRuntime} from './test-support/telegram-runtime.mjs';
import {createApprovalRunner} from './paper-approvals.mjs';
import {updateJournal,validateJournal} from './paper-journal.mjs';

const runtime=await createTelegramRuntime({now:Date.parse('2026-11-04T16:20:15.000Z')});
const root=mkdtempSync(join(tmpdir(),'sentinel-paper-pipeline-')),owner='123456789';
const env={PAPER_APPROVALS_ENABLED:'true',TELEGRAM_CHAT_ID:owner,TGCLOUD_TOKEN:'app12345:fixture-not-a-real-credential'};
const runner=()=>createApprovalRunner({env,root,call:(args)=>runtime.bridge(args),now:()=>runtime.now});
const signal=()=>({status:'SIGNAL_PREVIEW_ONLY',symbol:'HYPE',timeframe:'5m',side:'BUY',entry:100,stop:98,target:104,candle_utc:new Date(Math.floor(runtime.now/300000)*300000-300000).toISOString()});
const click=(message,choice)=>({id:'query-'+message.message_id+'-'+choice,data:message.reply_markup.inline_keyboard[0][choice==='yes'?0:1].callback_data,from:{id:Number(owner)},message:{message_id:message.message_id,chat:{id:Number(owner),type:'private'}}});
try{
 await runner().configure();
 let journal=updateJournal(null,null,[],Math.floor(runtime.now/60000)*60000);
 writeFileSync(join(root,'latest-signal.json'),JSON.stringify(signal()));
 await runner().propose();const prompt=runtime.sent.at(-1);
 assert.equal((await runner().drain()).has_order,false,'A sent proposal must not itself become a paper trade');
 runtime.now+=1200;const approvalTime=runtime.now;
 assert.equal((await runtime.callback(click(prompt,'yes'))).status,'APPROVED_PAPER');
 const sdkOrder=(await runtime.bridge({operation:'drain'})).orders[0];
 assert.equal(sdkOrder.timestamp,new Date(approvalTime).toISOString());
 // Callback replay, a lost runner process and an unacknowledged drain all
 // preserve the same order and the first YES timestamp.
 await runtime.callback(click(prompt,'yes'));await runtime.restart();runtime.now+=300000;
 await runner().drain();const text=readFileSync(join(root,'simulated-order.json'),'utf8'),order=JSON.parse(text);
 assert.equal(order.signal_id,sdkOrder.signal_id);assert.equal(order.timestamp,sdkOrder.timestamp);
 const entry=Math.ceil(approvalTime/60000)*60000,bars=[{t:entry,o:100,h:101,l:99,c:100},{t:entry+60000,o:100,h:105,l:99,c:104}],end=Math.floor(runtime.now/60000)*60000;
 journal=updateJournal(journal,order,bars,end);
 assert.equal(journal.orders.length,1);assert.equal(journal.portfolio.orders.length,1);assert.equal(journal.orders[0].tracking.state,'CLOSED');
 writeFileSync(join(root,'paper-journal.json'),JSON.stringify(journal));
 // An upload failure or missing confirmation cannot consume the durable row.
 await assert.rejects(()=>runner().acknowledge(),/both saved artifacts/);
 assert.equal((await runtime.bridge({operation:'drain'})).orders.length,1);
 await runtime.restart();await runner().drain();assert.equal(readFileSync(join(root,'simulated-order.json'),'utf8'),text);
 journal=updateJournal(validateJournal(JSON.parse(readFileSync(join(root,'paper-journal.json'),'utf8'))),JSON.parse(text),bars,end);
 assert.equal(journal.orders.length,1);assert.equal(journal.portfolio.orders.length,1);
 env.PAPER_SIMULATION_UPLOADED='true';env.PAPER_JOURNAL_UPLOADED='true';
 assert.equal((await runner().acknowledge()).acknowledged,1);assert.equal((await runner().acknowledge()).acknowledged,0);
 assert.equal((await runner().drain()).has_order,false);assert(!existsSync(join(root,'simulated-order.json')));
 // A subsequent NO and an expired YES leave the imported journal unchanged.
 for(const choice of ['no','expired']){
  runtime.now+=300000;writeFileSync(join(root,'latest-signal.json'),JSON.stringify(signal()));await runner().propose();const message=runtime.sent.at(-1);
  if(choice==='expired')runtime.now+=90000;
  const result=await runtime.callback(click(message,choice==='no'?'no':'yes'));
  assert.equal(result.status,choice==='no'?'REJECTED':'EXPIRED');assert.equal((await runner().drain()).has_order,false);
  journal=updateJournal(journal,null,[],Math.floor(runtime.now/60000)*60000);assert.equal(journal.orders.length,1);
 }
 assert.equal(runtime.sqlite.prepare("SELECT count(*) AS n FROM sentinel_paper_proposals WHERE status='APPROVED_PAPER'").get().n,1);
 console.log('Full paper approval pipeline passed: signal, Telegram buttons, durable YES, original simulation JSON, modeled fill/exit, journal replay, upload-before-ACK, restart, NO and expired approval. No external messages or live trades.');
}finally{runtime.close();rmSync(root,{recursive:true,force:true});}
