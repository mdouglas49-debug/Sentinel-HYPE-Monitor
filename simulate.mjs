import { writeFileSync } from 'node:fs';

const signal = {
  status: 'SIGNAL_PREVIEW_ONLY',
  side: 'BUY',
  entry: 40,
  stop: 39.5,
  target: 41,
  candle_utc: '2026-10-21T20:00:00Z'
};

function simulate(s) {
  if (s.status !== 'SIGNAL_PREVIEW_ONLY') {
    throw new Error('Signal not eligible');
  }

  if (!['BUY', 'SELL'].includes(s.side)) {
    throw new Error('Invalid direction');
  }

  const { entry, stop, target } = s;

  if (![entry, stop, target].every(
    v => typeof v === 'number' && Number.isFinite(v) && v > 0
  )) {
    throw new Error('Invalid prices');
  }

  if (s.side === 'BUY' && !(stop < entry && entry < target)) {
    throw new Error('Invalid BUY stop/target');
  }

  if (s.side === 'SELL' && !(target < entry && entry < stop)) {
    throw new Error('Invalid SELL stop/target');
  }

  const rr = Math.abs(target - entry) / Math.abs(entry - stop);

  if (rr < 1.5) throw new Error('Reward/risk too low');

  return {
    mode: 'SIMULATION_ONLY',
    symbol: 'HYPE',
    side: s.side,
    entry,
    stop,
    target,
    reward_to_risk: Number(rr.toFixed(2)),
    status: 'SIMULATED_ORDER',
    timestamp: new Date().toISOString()
  };
}

const result = simulate(signal);
writeFileSync('simulated-order.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
