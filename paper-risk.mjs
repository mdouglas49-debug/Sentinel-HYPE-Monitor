import { advanceTrade, startTrade, defaults, MINUTE } from './paper-engine.mjs';
import { validateOrder } from './paper-order.mjs';
export const riskDefaults = { max_open: 1, max_entry_risk: 2, daily_loss: 25 };
export function validateRiskLimits(a) { if (!a || !Number.isInteger(a.max_open) || a.max_open < 1 || a.max_open > 10 || !Number.isFinite(a.max_entry_risk) || a.max_entry_risk < 0.01 || a.max_entry_risk > 1000 || !Number.isFinite(a.daily_loss) || a.daily_loss < 1 || a.daily_loss > 10000)
    throw Error('Paper risk limits require 1–10 positions, entry risk $0.01–$1,000, and daily loss $1–$10,000.'); return { max_open: a.max_open, max_entry_risk: a.max_entry_risk, daily_loss: a.daily_loss }; }
export function validateRiskControl(a) { if (!a || typeof a.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(a.id) || !Number.isFinite(Date.parse(a.requested_at)) || Date.parse(a.requested_at) > Date.now() + MINUTE || typeof a.halted !== 'boolean')
    throw Error('Invalid paper risk command.'); return { id: a.id, requested_at: a.requested_at, limits: validateRiskLimits(a.limits), halted: a.halted }; }
const active = (o) => !['CLOSED', 'SKIPPED'].includes(o.tracking.state);
export const riskDay = (time) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
export function portfolioStats(p, asof = Date.parse(p.updated_at)) {
    const day = riskDay(asof), realized = p.orders.filter(o => o.tracking.state === 'CLOSED' && Date.parse(o.tracking.exit_candle_utc) + MINUTE <= asof && riskDay(Date.parse(o.tracking.exit_candle_utc) + MINUTE) === day).reduce((n, o) => n + (o.tracking.net_pnl || 0), 0);
    const exposure = p.orders.filter(o => active(o) && (o.admitted || o.tracking.fill !== undefined));
    const openLoss = exposure.reduce((n, o) => n + Math.min(0, o.tracking.unrealized_net || 0), 0);
    return { day, realized, open_loss: openLoss, loss_used: Math.max(0, -realized - openLoss), open: exposure.length, unverified: exposure.filter(o => o.tracking.state === 'DATA_GAP').length, daily_locked: p.locked_day === day };
}
function skip(o, note) { o.tracking = { ...o.tracking, state: 'SKIPPED', note }; }
function stopAtOpen(t, b) { const direction = t.side === 'BUY' ? 1 : -1, exit = b.o * (1 - direction * t.assumptions.slippage_bps / 10000), gross = (exit - t.fill) * direction * t.assumptions.quantity, fees = (t.fill + exit) * t.assumptions.quantity * t.assumptions.fee_bps / 10000; return { ...t, state: 'CLOSED', exit, exit_reason: 'EMERGENCY_STOP', exit_candle_utc: new Date(b.t).toISOString(), next_candle: b.t + MINUTE, mark: b.o, marked_at: new Date(b.t).toISOString(), gross_pnl: gross, fees, net_pnl: gross - fees, unrealized_net: undefined, note: 'Paper emergency stop filled at the next available full-minute open after the command. Not an exchange order.' }; }
export function updatePortfolio(previous, incoming, bars, end, command) {
    const priorLimits = previous?.limits || riskDefaults;
    let commandTime = -Infinity;
    const p = previous ? JSON.parse(JSON.stringify(previous)) : { started_at: new Date(end).toISOString(), limits: { ...riskDefaults }, halted: false, halted_at: null, last_control: null, locked_day: null, updated_at: new Date(end).toISOString(), orders: [] };
    if (command) {
        const c = validateRiskControl(command);
        if (c.id !== p.last_control?.id && (!p.last_control || Date.parse(c.requested_at) > Date.parse(p.last_control.requested_at))) {
            if (!c.halted && p.halted && p.orders.some(active))
                throw Error('Stopped paper positions must be closed before resuming.');
            p.limits = c.limits;
            p.halted = c.halted;
            p.halted_at = c.halted ? (p.halted_at || c.requested_at) : null;
            p.last_control = c;
            commandTime = Math.ceil(Date.parse(c.requested_at) / MINUTE) * MINUTE;
        }
    }
    if (incoming) {
        const o = validateOrder(incoming);
        if (Date.parse(o.timestamp) >= Date.parse(p.started_at) && !p.orders.some(x => x.signal_id === o.signal_id))
            p.orders.push({ ...o, tracking: startTrade(o, defaults) });
    }
    p.orders.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.signal_id.localeCompare(b.signal_id));
    if (p.halted)
        for (const o of p.orders)
            if (active(o) && o.tracking.fill === undefined && o.tracking.next_candle >= Math.ceil(Date.parse(p.halted_at) / MINUTE) * MINUTE)
                skip(o, 'Paper emergency stop is active. New entries are blocked.');
    const ordered = [...bars].filter(b => b.t + MINUTE <= end).sort((a, b) => a.t - b.t);
    for (const b of ordered) {
        // Only prior completed bars inform admission. Exits later in this bar do not free a slot at its open.
        const limits = b.t < commandTime ? priorLimits : p.limits;
        const stoppedNow = p.halted && b.t >= Math.ceil(Date.parse(p.halted_at) / MINUTE) * MINUTE;
        const stats = portfolioStats(p, b.t);
        if (stats.loss_used >= limits.daily_loss)
            p.locked_day = stats.day;
        for (const o of p.orders) {
            if (!active(o) || o.admitted || o.tracking.fill !== undefined || o.tracking.next_candle > b.t)
                continue;
            if (o.tracking.next_candle !== b.t) {
                skip(o, 'The modeled entry candle is missing. Late paper entry blocked.');
                continue;
            }
            const exposure = p.orders.filter(x => x !== o && active(x) && (x.admitted || x.tracking.fill !== undefined));
            const direction = o.side === 'BUY' ? 1 : -1, fill = b.o * (1 + direction * defaults.slippage_bps / 10000), stop = o.stop * (1 - direction * defaults.slippage_bps / 10000), risk = Math.max(0, (fill - stop) * direction) + (fill + stop) * defaults.fee_bps / 10000;
            const reason = stoppedNow ? 'Paper emergency stop is active.' : p.locked_day === stats.day ? 'Daily paper loss cutoff reached.' : exposure.some(x => x.tracking.state === 'DATA_GAP') ? 'Unverified position history blocks new paper entries.' : exposure.length >= limits.max_open ? 'Maximum open paper positions reached.' : risk > limits.max_entry_risk ? 'Modeled entry-to-stop loss exceeds the paper risk limit.' : p.orders.filter(active).length > 500 ? 'Paper journal capacity reached.' : null;
            if (reason)
                skip(o, reason);
            else
                o.admitted = true;
        }
        for (const o of p.orders) {
            const t = o.tracking;
            if (!active(o) || (!o.admitted && t.fill === undefined) || t.next_candle > b.t)
                continue;
            const haltMinute = p.halted_at ? Math.ceil(Date.parse(p.halted_at) / MINUTE) * MINUTE : Infinity;
            o.tracking = p.halted && t.fill !== undefined && t.next_candle === b.t && b.t >= haltMinute ? stopAtOpen(t, b) : advanceTrade(o, t, [b], b.t + MINUTE);
        }
        const after = portfolioStats(p, b.t + MINUTE);
        if (after.loss_used >= limits.daily_loss)
            p.locked_day = after.day;
    }
    for (const o of p.orders)
        if (active(o) && o.tracking.next_candle + MINUTE <= end) {
            if (!o.admitted && o.tracking.fill === undefined)
                skip(o, 'The modeled entry candle is missing. Late paper entry blocked.');
            else
                o.tracking = advanceTrade(o, o.tracking, [], end);
        }
    // Never evict open or unverified positions to make a checkpoint fit.
    const unfinished = p.orders.filter(active), finished = p.orders.filter(o => !active(o)).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    if (unfinished.length > 500)
        throw Error('Paper journal capacity reached.');
    p.orders = [...unfinished, ...finished.slice(0, 500 - unfinished.length)];
    p.updated_at = new Date(end).toISOString();
    return p;
}
