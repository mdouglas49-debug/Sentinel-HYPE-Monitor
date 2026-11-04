export function validateOrder(o) {
    if (!o || o.mode !== 'SIMULATION_ONLY' || o.status !== 'SIMULATED_ORDER' || o.symbol !== 'HYPE' || o.timeframe !== '5m' || !['BUY', 'SELL'].includes(o.side) || ![o.entry, o.stop, o.target].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0) || !Number.isFinite(Date.parse(o.candle_utc)) || !Number.isFinite(Date.parse(o.timestamp)) || o.signal_id !== `HYPE-5m-${Date.parse(o.candle_utc)}` || (o.side === 'BUY' ? !(o.stop < o.entry && o.entry < o.target) : !(o.target < o.entry && o.entry < o.stop)))
        throw Error('Invalid Sentinel simulation record.');
    const rr = Math.abs(o.target - o.entry) / Math.abs(o.entry - o.stop);
    if (!Number.isFinite(rr) || rr < 1.5)
        throw Error('Invalid simulation reward/risk.');
    return { mode: 'SIMULATION_ONLY', status: 'SIMULATED_ORDER', signal_id: o.signal_id, symbol: 'HYPE', timeframe: '5m', side: o.side, entry: o.entry, stop: o.stop, target: o.target, reward_to_risk: rr, candle_utc: o.candle_utc, timestamp: o.timestamp };
}
export function mergeOrders(previous, incoming) { const map = new Map(previous.map(o => [o.signal_id, o])); for (const o of incoming)
    if (!map.has(o.signal_id))
        map.set(o.signal_id, o); return [...map.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 2000); }
