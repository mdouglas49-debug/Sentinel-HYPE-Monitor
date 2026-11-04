export const MINUTE = 60000;
export const defaults = { quantity: 1, fee_bps: 5, slippage_bps: 2 };
export function validateAssumptions(a) { if (!a || !Number.isFinite(a.quantity) || a.quantity <= 0 || a.quantity > 1000000 || !Number.isFinite(a.fee_bps) || a.fee_bps < 0 || a.fee_bps > 100 || !Number.isFinite(a.slippage_bps) || a.slippage_bps < 0 || a.slippage_bps > 100)
    throw Error('Use a positive quantity, fee from 0–100 bps, and slippage from 0–100 bps.'); return { quantity: a.quantity, fee_bps: a.fee_bps, slippage_bps: a.slippage_bps }; }
export function parseBars(raw, end) { if (!Array.isArray(raw))
    throw Error('Unexpected candle data.'); const unique = new Map(); for (const v of raw) {
    const b = { t: Number(v.t), o: Number(v.o), h: Number(v.h), l: Number(v.l), c: Number(v.c) };
    if (!Object.values(b).every(Number.isFinite) || b.t % MINUTE !== 0 || b.l <= 0 || b.h < b.l || b.o < b.l || b.o > b.h || b.c < b.l || b.c > b.h)
        throw Error('Invalid one-minute candle.');
    if (b.t + MINUTE <= end)
        unique.set(b.t, b);
} return [...unique.values()].sort((a, b) => a.t - b.t); }
export function startTrade(order, assumptions) { return { signal_id: order.signal_id, side: order.side, state: 'WAITING_ENTRY', assumptions: { ...assumptions }, next_candle: Math.ceil(Date.parse(order.timestamp) / MINUTE) * MINUTE }; }
function pnl(t, exit) { const quantity = t.assumptions.quantity, gross = (exit - t.fill) * (t.side === 'BUY' ? 1 : -1) * quantity, fees = (t.fill + exit) * quantity * t.assumptions.fee_bps / 10000; return { gross_pnl: gross, fees, net_pnl: gross - fees }; }
export function advanceTrade(order, previous, bars, end) {
    const t = { ...previous, assumptions: { ...previous.assumptions } };
    if (t.state === 'CLOSED' || t.state === 'SKIPPED')
        return t;
    if (t.next_candle + MINUTE > end)
        return t;
    const available = bars.filter(b => b.t >= t.next_candle && b.t + MINUTE <= end);
    if (!available.length || available[0].t !== t.next_candle) {
        t.state = 'DATA_GAP';
        t.note = 'Missing one-minute history. Outcome and profit remain unverified.';
        return t;
    }
    for (const b of available) {
        if (b.t !== t.next_candle) {
            t.state = 'DATA_GAP';
            t.note = 'Missing one-minute history. Outcome and profit remain unverified.';
            return t;
        }
        const direction = order.side === 'BUY' ? 1 : -1, slip = t.assumptions.slippage_bps / 10000;
        if (t.fill === undefined) {
            t.fill = b.o * (1 + direction * slip);
            if (order.side === 'BUY' ? !(order.stop < t.fill && t.fill < order.target) : !(order.target < t.fill && t.fill < order.stop)) {
                t.state = 'SKIPPED';
                t.note = 'Next-minute fill was outside the original stop/target bracket.';
                delete t.fill;
                return t;
            }
            t.filled_at = new Date(b.t).toISOString();
        }
        t.state = 'OPEN';
        delete t.note;
        const long = order.side === 'BUY', stop = long ? b.l <= order.stop : b.h >= order.stop, target = long ? b.h >= order.target : b.l <= order.target, gapStop = long ? b.o <= order.stop : b.o >= order.stop, gapTarget = long ? b.o >= order.target : b.o <= order.target;
        let exit, reason;
        if (gapStop) {
            exit = b.o;
            reason = 'STOP_LOSS';
        }
        else if (gapTarget) {
            exit = order.target;
            reason = 'TAKE_PROFIT';
        }
        else if (stop) {
            exit = order.stop;
            reason = 'STOP_LOSS';
            t.ambiguous = target;
        }
        else if (target) {
            exit = order.target;
            reason = 'TAKE_PROFIT';
        }
        t.next_candle = b.t + MINUTE;
        t.mark = b.c;
        t.marked_at = new Date(b.t + MINUTE).toISOString();
        if (exit !== undefined) {
            t.exit = exit * (1 - direction * slip);
            t.exit_reason = reason;
            t.exit_candle_utc = new Date(b.t).toISOString();
            t.state = 'CLOSED';
            Object.assign(t, pnl(t, t.exit));
            delete t.unrealized_net;
            if (t.ambiguous)
                t.note = 'Both levels touched in this minute; stop counted first conservatively.';
            return t;
        }
        t.unrealized_net = pnl(t, b.c * (1 - direction * slip)).net_pnl;
    }
    if (t.next_candle + MINUTE <= end) {
        t.state = 'DATA_GAP';
        t.note = 'Latest completed one-minute candle is unavailable. Outcome is unverified.';
    }
    return t;
}
export function summarize(trades) { const closed = trades.filter(t => t.state === 'CLOSED'), open = trades.filter(t => t.state === 'OPEN'), wins = closed.filter(t => (t.net_pnl || 0) > 0).length; return { closed: closed.length, open: open.length, unverified: trades.filter(t => t.state === 'DATA_GAP').length, skipped: trades.filter(t => t.state === 'SKIPPED').length, wins, win_rate: closed.length ? wins / closed.length * 100 : null, gross_pnl: closed.reduce((s, t) => s + (t.gross_pnl || 0), 0), fees: closed.reduce((s, t) => s + (t.fees || 0), 0), net_pnl: closed.reduce((s, t) => s + (t.net_pnl || 0), 0), unrealized_net: open.reduce((s, t) => s + (t.unrealized_net || 0), 0) }; }
