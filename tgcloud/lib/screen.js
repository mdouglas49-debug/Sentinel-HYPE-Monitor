// Read-only HYPE 5m screening, ported from the Sentinel Python sandbox.
// No orders, trading endpoints, or private credentials.
export const INTERVAL_MS = 300000;
const MIN_RR = 1.5;

export function ema(values, period) {
  if (values.length < period) throw new Error('Not enough prices for EMA');
  let out = values.slice(0, period).reduce((a,b) => a+b, 0) / period;
  const alpha = 2/(period+1);
  for (const value of values.slice(period)) out = alpha*value + (1-alpha)*out;
  return out;
}
export function rsi(values, period=14) {
  if (values.length-1 < period) throw new Error('Not enough prices for RSI');
  const changes = values.slice(1).map((v,i) => v-values[i]);
  let gain = changes.slice(0,period).reduce((a,v) => a+Math.max(v,0),0)/period;
  let loss = changes.slice(0,period).reduce((a,v) => a+Math.max(-v,0),0)/period;
  for (const change of changes.slice(period)) {
    gain = (gain*(period-1)+Math.max(change,0))/period;
    loss = (loss*(period-1)+Math.max(-change,0))/period;
  }
  if (gain===0 && loss===0) return 50;
  if (loss===0) return 100;
  return 100-100/(1+gain/loss);
}
function pivots(candles, left=2, right=2) {
  const highs=[], lows=[];
  for (let i=left; i<candles.length-right; i++) {
    const c=candles[i];
    if (candles.slice(i-left,i).every(v=>c.h>v.h) && candles.slice(i+1,i+right+1).every(v=>c.h>=v.h)) highs.push(c.h);
    if (candles.slice(i-left,i).every(v=>c.l<v.l) && candles.slice(i+1,i+right+1).every(v=>c.l<=v.l)) lows.push(c.l);
  }
  return {highs,lows};
}
export function evaluate(candles, side, entry) {
  if (candles.length<20 || !['BUY','SELL'].includes(side)) return {status:'BLOCKED',reason:'Insufficient candles or invalid direction'};
  const {highs,lows}=pivots(candles);
  const buffer=0.001;
  const stops=side==='BUY' ? lows.filter(v=>v<entry) : highs.filter(v=>v>entry);
  const targets=side==='BUY' ? highs.filter(v=>v>entry).sort((a,b)=>a-b) : lows.filter(v=>v<entry).sort((a,b)=>b-a);
  if (!stops.length || !targets.length) return {status:'BLOCKED',reason:'No confirmed protective swing or target'};
  const stop=stops[stops.length-1]*(side==='BUY'?1-buffer:1+buffer);
  const target=targets[0];
  const risk=Math.abs(entry-stop), reward=Math.abs(entry-target);
  if (!(risk>0 && reward>0)) return {status:'BLOCKED',reason:'Invalid risk/reward'};
  return {status:'PREVIEW_ONLY',side,entry,stop:Number(stop.toFixed(4)),target,reward_to_risk:Number((reward/risk).toFixed(2))};
}
export function screen(candles) {
  if (candles.length<60) return {status:'NO_SIGNAL',reason:'Need at least 60 completed candles'};
  const closes=candles.map(c=>c.c), close=closes.at(-1);
  const fast=ema(closes,9), slow=ema(closes,21), strength=rsi(closes);
  let side=null;
  if (close>fast && fast>slow && strength>=52 && strength<=70) side='BUY';
  else if (close<fast && fast<slow && strength>=30 && strength<=48) side='SELL';
  const result={status:'NO_SIGNAL',candle_utc:new Date(candles.at(-1).t).toISOString(),close,ema9:Number(fast.toFixed(4)),ema21:Number(slow.toFixed(4)),rsi14:Number(strength.toFixed(2)),minimum_reward_to_risk:MIN_RR};
  if (!side) return {...result,reason:'Trend and momentum filters not aligned'};
  const preview=evaluate(candles,side,close);
  if (preview.status!=='PREVIEW_ONLY') return {...result,reason:preview.reason};
  if (preview.reward_to_risk<MIN_RR) return {...result,reason:'Reward-to-risk below minimum',candidate_side:side,candidate_reward_to_risk:preview.reward_to_risk};
  return {...result,...preview,status:'SIGNAL_PREVIEW_ONLY',reason:'Rule-based candidate, not validated for live trading'};
}
export function parseClosedCandles(raw, end) {
  if (!Array.isArray(raw)) throw new Error('Unexpected Hyperliquid response');
  const unique=new Map();
  for (const c of raw) {
    const t=Number(c.t),h=Number(c.h),l=Number(c.l),close=Number(c.c);
    if (![t,h,l,close].every(Number.isFinite) || h<l || close<l || close>h) throw new Error('Invalid OHLC data');
    if (t+INTERVAL_MS<=end) unique.set(t,{t,h,l,c:close});
  }
  return [...unique.values()].sort((a,b)=>a.t-b.t);
}
