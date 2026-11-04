import { api, fetch } from 'sdk';
import { INTERVAL_MS, parseClosedCandles, screen } from '../lib/screen.js';
import { bridgeConfiguration, ownerMessage, proposeSignal } from '../lib/paper-approval.js';

// Keep the existing read-only /scan strategy and the staging button test.
export default async function(message) {
  const config = await bridgeConfiguration();
  if (!ownerMessage(message,config)) return;
  const chatId = config.chat_id;
  const cmd = (message.text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  if (cmd === '/start' || cmd === '/help') {
    await api.sendMessage({chat_id:chatId,text:'SENTINEL HYPE | PAPER ONLY\n/scan — HYPE 5m signal review\n/paper-test — button test\nYES queues only a hypothetical paper simulation. Live execution is disabled.'}); return;
  }
  if (cmd === '/paper-test') {
    await api.sendMessage({chat_id:chatId,text:'SENTINEL | BUTTON TEST ONLY\nNo paper or live orders can be placed.',reply_markup:{inline_keyboard:[[{text:'YES (TEST)',callback_data:'sentinel_demo_yes_v1'},{text:'NO (TEST)',callback_data:'sentinel_demo_no_v1'}]]}}); return;
  }
  if (cmd !== '/scan') return;
  try {
    const now = Date.now(), end = Math.floor(now/INTERVAL_MS)*INTERVAL_MS;
    const res = await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin:'HYPE',interval:'5m',startTime:end-240*INTERVAL_MS,endTime:end}})});
    if (!res.ok) throw Error('Hyperliquid unavailable.');
    const candles = parseClosedCandles(await res.json(),end), s = screen(candles);
    const lines = ['SENTINEL HYPE | 5m | PAPER ONLY',`Candles: ${candles.length}`,`Status: ${s.status}`];
    for (const key of ['candle_utc','close','ema9','ema21','rsi14','side','entry','stop','target','reward_to_risk','candidate_side','candidate_reward_to_risk','reason']) if (s[key] !== undefined) lines.push(`${key}: ${s[key]}`);
    if (s.status === 'SIGNAL_PREVIEW_ONLY' && config.enabled) {
      const result = await proposeSignal({...s,symbol:'HYPE',timeframe:'5m'});
      if (result.status === 'SENT') return;
      lines.push(result.status === 'DUPLICATE' ? 'This candle already has a paper proposal or decision. Duplicate blocked.' : result.status === 'EXPIRED' ? 'This candle’s original proposal expired. No paper entry queued.' : 'Paper proposal delivery is pending.');
    } else lines.push('Read-only preview. No qualifying enabled paper proposal.');
    lines.push('No live order is placed.');
    await api.sendMessage({chat_id:chatId,text:lines.join('\n')});
  } catch {
    await api.sendMessage({chat_id:chatId,text:'Scan or paper proposal unavailable. No live order placed. Retry /scan for the same candle to recover an unconfirmed proposal.'});
  }
}
