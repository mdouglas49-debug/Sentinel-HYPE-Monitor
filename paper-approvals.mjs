// Approval transport only. The only executable trade format is SIMULATION_ONLY.
import {readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runBridge} from './telegram-cloud.mjs';
import {validateOrder} from './paper-order.mjs';

export function approvalsEnabled(value='false'){
 if(!['true','false',''].includes(value))throw Error('PAPER_APPROVALS_ENABLED must be true or false.');
 return value==='true';
}
const hash=text=>createHash('sha256').update(text).digest('hex');
const json=text=>JSON.parse(text);
function checkBot(status){if(String(status?.bot_username||'').toLowerCase()!=='sentinelhypeai_bot')throw Error('Telegram approval app belongs to a different bot.');}
export function createApprovalRunner({env=process.env,call=runBridge,root=process.cwd(),now=()=>Date.now()}={}){
 const enabled=approvalsEnabled(env.PAPER_APPROVALS_ENABLED||'false');
 const file=name=>resolve(root,name);
 function configuration(){
  const owner=String(env.TELEGRAM_CHAT_ID||'');
  if(!/^[1-9]\d{0,15}$/.test(owner)||!Number.isSafeInteger(Number(owner)))throw Error('Configure the owner private TELEGRAM_CHAT_ID for paper approvals.');
  if(!env.TGCLOUD_TOKEN)throw Error('Configure TGCLOUD_TOKEN using the separate Telegram Serverless CLI app credential.');
  return {owner,options:{token:env.TGCLOUD_TOKEN,...(env.TGCLOUD_APP_NAME?{app:env.TGCLOUD_APP_NAME}:{})}};
 }
 async function invoke(input){const {options}=configuration();return call(input,options);}
 async function checked(){
  const {owner}=configuration(),status=await invoke({operation:'status'});
  checkBot(status);
  if(!status?.configured||status.ownerId!==owner||status.chatId!==owner)throw Error('Telegram approval owner configuration does not match this scanner.');
  if(!status.enabled)throw Error('Telegram paper approvals are disabled at the bot. No unapproved trade will be substituted.');
  return status;
 }
 function approvedOrder(input){
  const order=validateOrder(input),stamp=Date.parse(order.timestamp),candle=Date.parse(order.candle_utc);
  if(stamp<candle+300000||stamp>now()+60000)throw Error('Invalid paper approval time.');
  return order;
 }
 async function configure(){const {owner}=configuration();checkBot(await invoke({operation:'status'}));return invoke({operation:'configure',ownerId:owner,chatId:owner,enabled});}
 async function propose(){
  if(!enabled)return {status:'DISABLED'};
  await checked();
  const signal=json(readFileSync(file('latest-signal.json'),'utf8'));
  if(signal?.symbol!=='HYPE'||signal?.timeframe!=='5m'||signal?.status!=='SIGNAL_PREVIEW_ONLY')throw Error('Only a qualifying HYPE 5m signal can request paper approval.');
  const result=await invoke({operation:'propose',signal});
  if(!['SENT','DUPLICATE'].includes(result?.status))throw Error('Telegram paper proposal was not delivered. No unapproved trade was created.');
  return {status:result.status,signal_id:result.signal_id,expires_at:result.expires_at};
 }
 async function drain(){
  if(!enabled)return {enabled:false,has_order:false};
  // A failed/empty approval read must never reuse an automatic or stale file.
  for(const name of ['simulated-order.json','paper-approval-receipt.json'])rmSync(file(name),{force:true});
  await checked();
  const result=await invoke({operation:'drain',limit:1});
  if(!result||!Array.isArray(result.orders)||result.orders.length>1||!Array.isArray(result.signal_ids)||result.signal_ids.length!==result.orders.length)throw Error('Telegram returned an invalid paper approval batch.');
  const orders=result.orders.map(approvedOrder);
  if(orders.some((order,i)=>order.signal_id!==result.signal_ids[i]))throw Error('Telegram paper approval IDs do not match the approved orders.');
  if(!orders.length)return {enabled:true,has_order:false};
  const text=JSON.stringify(orders[0],null,2)+'\n';
  writeFileSync(file('simulated-order.json'),text);
  writeFileSync(file('paper-approval-receipt.json'),JSON.stringify({version:1,signal_ids:[orders[0].signal_id],sha256:hash(text)}));
  return {enabled:true,has_order:true,signal_id:orders[0].signal_id};
 }
 async function acknowledge(){
  if(!enabled||!existsSync(file('paper-approval-receipt.json')))return {acknowledged:0};
  if(env.PAPER_SIMULATION_UPLOADED!=='true'||env.PAPER_JOURNAL_UPLOADED!=='true')throw Error('Paper approval acknowledgment requires both saved artifacts and journal checkpoint.');
  const receipt=json(readFileSync(file('paper-approval-receipt.json'),'utf8')),text=readFileSync(file('simulated-order.json'),'utf8'),order=approvedOrder(json(text));
  if(receipt.version!==1||receipt.sha256!==hash(text)||!Array.isArray(receipt.signal_ids)||receipt.signal_ids.length!==1||receipt.signal_ids[0]!==order.signal_id)throw Error('Paper approval receipt changed before acknowledgment.');
  await checked();
  const result=await invoke({operation:'acknowledge',signal_ids:receipt.signal_ids});
  if(!Number.isInteger(result?.acknowledged)||result.acknowledged<0||!Array.isArray(result.signal_ids)||result.signal_ids.length!==1||result.signal_ids[0]!==order.signal_id)throw Error('Telegram did not confirm the paper approval acknowledgment. Retrying the same order is safe.');
  return {acknowledged:result.acknowledged,signal_ids:result.signal_ids};
 }
 return {configure,propose,drain,acknowledge,status:checked};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const operation=process.argv[2],runner=createApprovalRunner();
  if(!['configure','status','propose','drain','acknowledge'].includes(operation))throw Error('Use configure, status, propose, drain, or acknowledge.');
  const result=await runner[operation]();
  if(operation==='drain'&&process.env.GITHUB_OUTPUT){const {appendFileSync}=await import('node:fs');appendFileSync(process.env.GITHUB_OUTPUT,`has_order=${result.has_order?'true':'false'}\n`);}
  console.log(JSON.stringify(result));
 }catch(error){
  // Provider text and credential-bearing fetch errors are never printed.
  const message=String(error?.message||'');
  console.error(/^(PAPER_APPROVALS_ENABLED|Configure |Telegram approval app|Telegram approval owner|Telegram paper approvals|Only a qualifying|Telegram paper proposal|Telegram returned an invalid|Telegram paper approval IDs|Invalid paper approval time|Invalid Sentinel simulation|Invalid simulation reward|Paper approval acknowledgment|Paper approval receipt|Telegram did not confirm)/.test(message)?message:'Paper approval operation failed. Existing approvals remain queued; retry after checking the bridge configuration.');
  process.exitCode=1;
 }
}
