import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const signalFile = 'latest-signal.json';
const outputFile = 'simulated-order.json';

if (!existsSync(signalFile)) {
  console.log('NO_SIGNAL: No qualifying Sentinel signal available.');
  process.exit(0);
}

const signal = JSON.parse(readFileSync(signalFile, 'utf8'));

if (signal.status !== 'SIGNAL_PREVIEW_ONLY') {
  throw new Error('Signal not eligible for simulation');
}

if (signal.symbol !== 'HYPE' || signal.timeframe !== '5m') {
  throw new Error('Unexpected symbol or timeframe');
}

if (!['BUY', 'SELL'].includes(signal.side)) {
  throw new Error('Invalid trade direction');
}

const { entry, stop, target } = signal;

if (![entry, stop, target].every(
  value => typeof value === 'number' &&
           Number.isFinite(value) &&
           value > 0
)) {
  throw new Error('Invalid entry, stop, or target');
}

if (signal.side === 'BUY' && !(stop < entry && entry < target)) {
  throw new Error('Invalid BUY setup');
}

if (signal.side === 'SELL' && !(target < entry && entry < stop)) {
  throw new Error('Invalid SELL setup');
}

const rewardToRisk = Math.abs(target - entry) / Math.abs(entry - stop);

if (rewardToRisk < 1.5) {
  throw new Error('Reward-to-risk below minimum');
}

const candleTime = Date.parse(signal.candle_utc);

if (!Number.isFinite(candleTime)) {
  throw new Error('Invalid candle timestamp');
}

const age = Date.now() - candleTime;
const maxAge = 15 * 60 * 1000;

if (age < 0 || age > maxAge) {
  throw new Error('Signal is stale or from the future');
}

const signalId = `HYPE-5m-${candleTime}`;

if (existsSync(outputFile)) {
  const previous = JSON.parse(readFileSync(outputFile, 'utf8'));

  if (previous.signal_id === signalId) {
    console.log('DUPLICATE: Signal already simulated.');
    process.exit(0);
  }
}

const result = {
  mode: 'SIMULATION_ONLY',
  signal_id: signalId,
  symbol: 'HYPE',
  timeframe: '5m',
  side: signal.side,
  entry,
  stop,
  target,
  reward_to_risk: Number(rewardToRisk.toFixed(2)),
  status: 'SIMULATED_ORDER',
  candle_utc: signal.candle_utc,
  timestamp: new Date().toISOString()
};

writeFileSync(outputFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
