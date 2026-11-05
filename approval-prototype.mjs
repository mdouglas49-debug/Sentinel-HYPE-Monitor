// Sentinel approval proposal sender. PAPER MODE ONLY.
// Telegram callback buttons require a persistent, authenticated webhook receiver.
// No execution code or broker credentials are included.
import { readFileSync } from 'node:fs';
const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) throw new Error('Missing Telegram credentials');
const s=JSON.parse(readFileSync('latest-signal.json','utf8'));
if(s.status!=='SIGNAL_PREVIEW_ONLY'||s.symbol!=='HYPE'||s.timeframe!=='5m') throw new Error('Invalid signal');
if(!['BUY','SELL'].includes(s.side)) throw new Error('Invalid side');
if(![s.entry,s.stop,s.target].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>0)) throw new Error('Invalid prices');
if(s.side==='BUY' ? !(s.stop<s.entry&&s.entry<s.target) : !(s.target<s.entry&&s.entry<s.stop)) throw new Error('Invalid levels');
if(Math.abs(s.target-s.entry)/Math.abs(s.entry-s.stop)<1.5) throw new Error('Insufficient R:R');
const ts=Date.parse(s.candle_utc);
if(!Number.isFinite(ts)||Date.now()-ts<0||Date.now()-ts>10*60*1000) throw new Error('Stale signal');
const id='HYPE-5m-'+ts;
const msg=['SENTINEL HYPE | APPROVAL PROTOTYPE','PAPER ONLY — NO LIVE ORDERS',s.side+' HYPE 5m','Entry: '+s.entry,'Stop: '+s.stop,'Target: '+s.target,'R:R '+s.reward_to_risk+':1','Proposal '+id,'Buttons are not enabled until secure callback service is deployed.'].join('\n');
const res=await fetch('https://api.telegram.org/bot'+token+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text:msg}),signal:AbortSignal.timeout(20000)});
if(!res.ok)throw new Error('Telegram HTTP '+res.status);
const out=await res.json();if(!out.ok)throw new Error('Telegram rejected message');
console.log('Paper approval proposal delivered; no orders placed');
