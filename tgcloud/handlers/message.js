import { api, db, fetch } from 'sdk';
import { INTERVAL_MS, parseClosedCandles, screen } from '../lib/screen.js';
import { paperProposals } from '../schema.js';

const TTL_MS = 90_000;
function validSignal(s,now) {
  if(s?.status!=='SIGNAL_PREVIEW_ONLY'||!['BUY','SELL'].includes(s.side))return false;
  if(![s.entry,s.stop,s.target].every(x=>Number.isFinite(x)&&x>0))return false;
  if(s.side==='BUY' ? !(s.stop<s.entry&&s.entry<s.target) : !(s.target<s.entry&&s.entry<s.stop))return false;
  if((Math.abs(s.target-s.entry)/Math.abs(s.entry-s.stop))<1.5)return false;
  const t=Date.parse(s.candle_utc);
  return Number.isFinite(t)&&t<=now&&now-t<=10*60_000;
}
export default async function (message) {
  if (!message?.chat?.id || message.chat.type !== 'private' || String(message.from?.id)!==String(message.chat.id)) return;
  const chatId=message.chat.id;
  const cmd=(message.text||'').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  if(cmd==='/start'||cmd==='/help'){
    await api.sendMessage({chat_id:chatId,text:'SENTINEL HYPE | PAPER ONLY\n/scan - HYPE 5m signal review\n/paper-test - button test\nNo live trading or automatic execution.'});return;
  }
  if(cmd==='/paper-test'){
    await api.sendMessage({chat_id:chatId,text:'SENTINEL | BUTTON TEST ONLY\nNo orders can be placed.',reply_markup:{inline_keyboard:[[{text:'YES (TEST)',callback_data:'sentinel_demo_yes_v1'},{text:'NO (TEST)',callback_data:'sentinel_demo_no_v1'}]]}});return;
  }
  if(cmd!=='/scan')return;
  try {
    const now=Date.now(),end=Math.floor(now/INTERVAL_MS)*INTERVAL_MS;
    const res=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin:'HYPE',interval:'5m',startTime:end-240*INTERVAL_MS,endTime:end}})});
    if(!res.ok)throw Error('Hyperliquid unavailable');
    const candles=parseClosedCandles(await res.json(),end),s=screen(candles);
    const lines=['SENTINEL HYPE | 5m | PAPER ONLY',`Status: ${s.status}`];
    for(const k of ['candle_utc','close','ema9','ema21','rsi14','side','entry','stop','target','reward_to_risk','candidate_side','candidate_reward_to_risk','reason']){
      if(s[k]!==undefined)lines.push(`${k}: ${s[k]}`);
    }
    if(!validSignal(s,now)){
      lines.push('No qualifying fresh proposal. No orders placed.');
      await api.sendMessage({chat_id:chatId,text:lines.join('\n')});return;
    }
    const fingerprint=`HYPE:5m:${s.candle_utc}:${s.side}:${chatId}`;
    const [p]=await db.insert(paperProposals).values({
      fingerprint,chatId:String(chatId),side:s.side,entry:String(s.entry),stop:String(s.stop),
      target:String(s.target),candleUtc:s.candle_utc,createdAt:now,expiresAt:now+TTL_MS,status:'PENDING'
    }).onConflictDoNothing({target:paperProposals.fingerprint}).returning().run();
    if(!p){
      await api.sendMessage({chat_id:chatId,text:'This HYPE candle already has a paper proposal. Duplicate blocked. No orders placed.'});return;
    }
    lines.push('PAPER decision only. Expires in 90 seconds. No orders placed.');
    await api.sendMessage({chat_id:chatId,text:lines.join('\n'),reply_markup:{inline_keyboard:[[
      {text:'YES · PAPER',callback_data:`sp:yes:${p.id}`},
      {text:'NO',callback_data:`sp:no:${p.id}`}
    ]]}});
  }catch(error){
    console.error('Scan/proposal failed',String(error?.message||error));
    await api.sendMessage({chat_id:chatId,text:'Scan or paper proposal unavailable. No orders placed.'});
  }
}
