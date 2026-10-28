import { api, fetch } from 'sdk';
import { INTERVAL_MS, parseClosedCandles, screen } from '../lib/screen.js';

// Telegram Serverless routes message updates to handlers/message.js.
// /paper-test is an isolated button transport test, NOT a trade approval.
export default async function (message) {
  if (!message?.chat?.id || message.chat.type !== 'private') return;
  const cmd = (message.text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  if (cmd === '/start' || cmd === '/help') {
    await api.sendMessage({chat_id:message.chat.id,text:'SENTINEL HYPE AI | READ-ONLY\n/scan - HYPE 5m screening preview\n/paper-test - test YES/NO buttons (no trades)\nNo broker orders or account access.'});
    return;
  }
  if (cmd === '/paper-test') {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: 'SENTINEL | BUTTON TEST ONLY\nThis is not a trading signal or trade approval.\nTap YES or NO to verify Telegram callbacks. No orders will be placed.',
      reply_markup: { inline_keyboard: [[
        {text:'YES (TEST)',callback_data:'sentinel_demo_yes_v1'},
        {text:'NO (TEST)',callback_data:'sentinel_demo_no_v1'}
      ]] }
    });
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
