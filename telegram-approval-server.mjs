// PAPER-ONLY Telegram YES/NO webhook server. Node 24, zero dependencies.
// Do not deploy over the existing Telegram webhook until migration is planned.
// Single-instance file storage for development; production requires transactional DB.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { proposal, decide } from './approval-core.mjs';

const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId,
  TELEGRAM_ALLOWED_USER_ID: allowedUser, TELEGRAM_WEBHOOK_SECRET: webhookSecret,
  SENTINEL_PROPOSAL_SECRET: proposalSecret }=process.env;
if (![token,chatId,allowedUser,webhookSecret,proposalSecret].every(Boolean))
  throw Error('Missing required environment variables');
if (webhookSecret.length<20 || proposalSecret.length<32) throw Error('Secrets too short');
const storePath=process.env.SENTINEL_APPROVAL_STORE || './approval-state.json';
let state=existsSync(storePath)?JSON.parse(readFileSync(storePath,'utf8')):{records:{},fingerprints:{}};
function persist(){const tmp=storePath+'.tmp';writeFileSync(tmp,JSON.stringify(state,null,2),{mode:0o600});renameSync(tmp,storePath);}
function equal(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length && timingSafeEqual(x,y);}
async function tg(method,payload){
  const response=await fetch('https://api.telegram.org/bot'+token+'/'+method,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)
  });
  const result=await response.json();
  if(!response.ok||!result.ok)throw Error('Telegram '+method+' failed');
  return result.result;
}
function readBody(req){return new Promise((resolve,reject)=>{let data='';req.on('data',chunk=>{data+=chunk;if(data.length>16384){reject(Error('Payload too large'));req.destroy();}});req.on('end',()=>{try{resolve(JSON.parse(data))}catch{reject(Error('Invalid JSON'))}});req.on('error',reject);});}
function reply(res,code,data){res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));}
export async function handleProposal(signal){
  const p=proposal(signal);
  if(state.fingerprints[p.fingerprint])return {status:'DUPLICATE',id:state.fingerprints[p.fingerprint]};
  state.records[p.id]=p;state.fingerprints[p.fingerprint]=p.id;persist();
  const text=['SENTINEL HYPE — PAPER APPROVAL',p.signal.side+' HYPE (5m)',
    'Entry: '+p.signal.entry,'Stop: '+p.signal.stop,'Target: '+p.signal.target,
    'Expires in 90 seconds. YES records a PAPER decision only.','No live order will be sent.'].join('\n');
  try {
    const sent=await tg('sendMessage',{chat_id:chatId,text,reply_markup:{inline_keyboard:[[
      {text:'YES · PAPER',callback_data:'YES:'+p.id},
      {text:'NO',callback_data:'NO:'+p.id}
    ]]}});
    state.records[p.id].telegram_message_id=sent.message_id;persist();
    return {status:'SENT',id:p.id};
  }catch(err){state.records[p.id].status='DELIVERY_FAILED';persist();throw err;}
}
export async function handleCallback(callback){
  const id=callback?.id;
  if(!id)return;
  const user=callback.from?.id,chat=callback.message?.chat?.id;
  let response='Approval unavailable';
  if(String(user)!==String(allowedUser)||String(chat)!==String(chatId))response='Unauthorized';
  else {
    const match=/^(YES|NO):([0-9a-f-]{36})$/.exec(callback.data||'');
    if(!match)response='Invalid approval';
    else {
      const record=state.records[match[2]];
      if(!record)response='Unknown proposal';
      else {
        try{
          const result=decide(record,match[1],user,allowedUser);
          state.records[record.id]=result;persist();
          response=result.status==='APPROVED_PAPER'?'YES recorded (PAPER ONLY)':result.status==='REJECTED'?'Rejected':result.status==='EXPIRED'?'Expired':result.status;
          if(record.telegram_message_id)await tg('editMessageReplyMarkup',{chat_id:chatId,message_id:record.telegram_message_id,reply_markup:{inline_keyboard:[]}});
        }catch{response='Already decided or invalid';}
      }
    }
  }
  await tg('answerCallbackQuery',{callback_query_id:id,text:response,show_alert:false});
}
export function startServer(){
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST')return reply(res,405,{error:'Method not allowed'});
    try{
      if(req.url==='/telegram'){
        if(!equal(req.headers['x-telegram-bot-api-secret-token'],webhookSecret))return reply(res,403,{error:'Forbidden'});
        const update=await readBody(req);
        if(update.callback_query)await handleCallback(update.callback_query);
        return reply(res,200,{ok:true});
      }
      if(req.url==='/proposal'){
        if(!equal(req.headers['x-sentinel-proposal-secret'],proposalSecret))return reply(res,403,{error:'Forbidden'});
        return reply(res,200,await handleProposal(await readBody(req)));
      }
      return reply(res,404,{error:'Not found'});
    }catch(e){console.error(e.message);return reply(res,500,{error:'Processing failed'});}
  });
  server.listen(Number(process.env.PORT||8080),'127.0.0.1',()=>console.log('Sentinel PAPER approval service listening locally'));
  return server;
}
if(process.argv[1] && import.meta.url===new URL('file://'+process.argv[1]).href)startServer();
