import { api, fetch } from 'sdk';
import { INTERVAL_MS, parseClosedCandles, screen } from '../lib/screen.js';

// Preserved from the user's deployed Telegram Serverless message.js.
// PAPER-ONLY: /scan remains read-only; no broker execution.
export default async function (message) {
  if (!message?.chat?.id || message.chat.type !== 'private') return;
  const cmd = (message.text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  if (cmd === '/start' || cmd === '/help') {
    await api.sendMessage({chat_id:message.chat.id,text:'SENTINEL HYPE AI | READ-ONLY\nUse /scan for a HYPE 5m screening preview.\nNo API keys, orders, or Trading Bridge access.\nAutomatic timed checks are not enabled in this serverless prototype.'});
    return;
  }
  if (cmd !== '/scan') return;
  try {
    const now=Date.now();
    const end=Math.floor(now/INTERVAL_MS)*INTERVAL_MS;
    const res=await fetch('https://api.hyperliquid.xyz/info',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({type:'candleSnapshot',req:{coin:'HYPE',interval:'5m',startTime:end-240*INTERVAL_MS,endTime:end}})
    });
    if (!res.ok) throw new Error(`Hyperliquid HTTP ${res.status}`);
    const candles=parseClosedCandles(await res.json(),end);
    const result=screen(candles);
    const lines=[`SENTINEL HYPE | 5m | READ-ONLY`,`Candles: ${candles.length}`,`Status: ${result.status}`];
    for (const key of ['candle_utc','close','ema9','ema21','rsi14','side','entry','stop','target','reward_to_risk','candidate_side','candidate_reward_to_risk','reason']) {
      if (result[key]!==undefined) lines.push(`${key}: ${result[key]}`);
    }
    lines.push('Preview only. No orders placed.');
    await api.sendMessage({chat_id:message.chat.id,text:lines.join('\n')});
  } catch (error) {
    console.error('Scan failed',error);
    await api.sendMessage({chat_id:message.chat.id,text:'Scan unavailable. No orders placed. Please try again later.'});
  }
}
