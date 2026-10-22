// GitHub Actions scheduled read-only scanner. No trading operations.
import { appendFileSync } from 'node:fs';
import { INTERVAL_MS, parseClosedCandles, screen } from './tgcloud/lib/screen.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID secrets');
const end = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS;
const response = await fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'candleSnapshot', req: { coin: 'HYPE', interval: '5m', startTime: end - 240 * INTERVAL_MS, endTime: end } }),
  signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
const candles = parseClosedCandles(await response.json(), end);
if (candles.length < 60) throw new Error(`Only ${candles.length} completed candles`);
const last = candles.at(-1);
// Guard against old/lagged market data or a delayed workflow.
const ageMs = Date.now() - (last.t + INTERVAL_MS);
if (ageMs < 0 || ageMs > 10 * 60 * 1000) {
  console.log('Skipping stale/future candle:', new Date(last.t).toISOString(), 'ageMs=', ageMs);
  process.exit(0);
}
const result = screen(candles);
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'SIGNAL_PREVIEW_ONLY') {
  console.log('No qualifying signal; no Telegram message.');
  process.exit(0);
}
// Cache key is one per completed candle, independent of BUY/SELL.
writeFileSync('latest-signal.json', JSON.stringify({
  ...result,
  symbol: 'HYPE',
  timeframe: '5m'
}, null, 2));
const candleKey = String(last.t);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `candle_key=${candleKey}\n`);
const message = [
  'SENTINEL HYPE | 5m | READ-ONLY',
  `Candle: ${result.candle_utc}`,
  `Signal preview: ${result.side}`,
  `Entry: ${result.entry}`,
  `Stop: ${result.stop}`,
  `Target: ${result.target}`,
  `Reward/risk: ${result.reward_to_risk}:1`,
  'Hypothetical only. No orders placed.',
].join('\n');
// Save pending message for a separate deduplicated step.
import { writeFileSync } from 'node:fs';
writeFileSync('signal-message.txt', message);
console.log('Qualifying signal prepared; waiting for duplicate check.');
