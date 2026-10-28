// Sentinel paper-only approval state machine. No broker calls.
// The caller must persist records transactionally and authenticate Telegram user/chat.
// Never interpret a callback as authority to execute without independent risk checks.
import { createHash, randomUUID } from 'node:crypto';
export const APPROVAL_TTL_MS=90_000;
export function proposal(signal, now=Date.now()) {
  if(signal?.status!=='SIGNAL_PREVIEW_ONLY'||signal.symbol!=='HYPE'||signal.timeframe!=='5m') throw Error('Unsupported signal');
  if(!['BUY','SELL'].includes(signal.side))throw Error('Invalid side');
  const {entry,stop,target}=signal;
  if(![entry,stop,target].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>0))throw Error('Invalid price');
  if(signal.side==='BUY'?!(stop<entry&&entry<target):!(target<entry&&entry<stop))throw Error('Invalid stop/target');
  if(Math.abs(target-entry)/Math.abs(entry-stop)<1.5)throw Error('Insufficient reward/risk');
  const candle=Date.parse(signal.candle_utc);
  if(!Number.isFinite(candle)||now<candle||now-candle>10*60_000)throw Error('Stale candle');
  const fingerprint=createHash('sha256').update(JSON.stringify([signal.symbol,signal.timeframe,signal.candle_utc,signal.side,entry,stop,target])).digest('hex');
  return {id:randomUUID(),fingerprint,signal:{symbol:'HYPE',timeframe:'5m',side:signal.side,entry,stop,target,candle_utc:signal.candle_utc},status:'PENDING',created_at:now,expires_at:now+APPROVAL_TTL_MS,mode:'PAPER_ONLY'};
}
export function decide(record,choice,actor,allowedActor,now=Date.now()){
  if(!record||record.mode!=='PAPER_ONLY')throw Error('Unknown proposal');
  if(String(actor)!==String(allowedActor))throw Error('Unauthorized Telegram user');
  if(!['YES','NO'].includes(choice))throw Error('Invalid response');
  if(record.status!=='PENDING')throw Error('Already decided');
  if(now>=record.expires_at)return {...record,status:'EXPIRED',decided_at:now};
  return {...record,status:choice==='YES'?'APPROVED_PAPER':'REJECTED',decided_at:now};
}
// Required integration contract:
// 1. Verify webhook authenticity (Telegram secret token) and callback.from.id.
// 2. Load proposal from durable storage and atomically compare-and-swap PENDING -> terminal status.
// 3. Bind callback data to proposal id; answerCallbackQuery; update Telegram message.
// 4. On APPROVED_PAPER, record paper decision ONLY. No live orders.
// 5. Enforce per-account drawdown, copy ratio, live market freshness, idempotency and
//    position/stop verification in a separate execution service before ever enabling live.
