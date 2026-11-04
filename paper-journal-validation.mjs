import { validateOrder } from './paper-order.mjs';
import { validateRiskLimits, validateRiskControl } from './paper-risk.mjs';
import { defaults, MINUTE } from './paper-engine.mjs';
export function sameAssumptions(a, b) { return a && b && a.quantity === b.quantity && a.fee_bps === b.fee_bps && a.slippage_bps === b.slippage_bps; }
export function validateBackgroundJournal(input) {
    if (input?.schema !== 1 || input.mode !== 'SIMULATION_ONLY' || !Array.isArray(input.orders) || input.orders.length > 500 || !Number.isFinite(Date.parse(input.updated_at)) || Date.parse(input.updated_at) > Date.now() + MINUTE)
        throw Error('Invalid background paper journal.');
    const ids = new Set();
    const orders = input.orders.map((item) => {
        const o = validateOrder(item), t = item.tracking;
        if (ids.has(o.signal_id) || !t || t.signal_id !== o.signal_id || t.side !== o.side || !['WAITING_ENTRY', 'OPEN', 'CLOSED', 'DATA_GAP', 'SKIPPED'].includes(t.state) || !Number.isSafeInteger(t.next_candle) || t.next_candle < 0 || t.next_candle % MINUTE || !sameAssumptions(t.assumptions, defaults))
            throw Error('Invalid tracked paper record.');
        for (const field of ['fill', 'exit', 'mark', 'gross_pnl', 'net_pnl', 'fees', 'unrealized_net'])
            if (t[field] !== undefined && !Number.isFinite(t[field]))
                throw Error('Invalid paper result.');
        if (t.state === 'CLOSED') {
            if (!(t.fill > 0 && t.exit > 0) || !['STOP_LOSS', 'TAKE_PROFIT', 'EMERGENCY_STOP'].includes(t.exit_reason) || !Number.isFinite(Date.parse(t.exit_candle_utc)))
                throw Error('Invalid closed paper result.');
            const gross = (t.exit - t.fill) * (o.side === 'BUY' ? 1 : -1) * defaults.quantity, fees = (t.fill + t.exit) * defaults.quantity * defaults.fee_bps / 10000;
            if ([t.gross_pnl - gross, t.fees - fees, t.net_pnl - (gross - fees)].some(v => !Number.isFinite(v) || Math.abs(v) > 1e-7))
                throw Error('Invalid paper P/L.');
        }
        if (t.state === 'OPEN' && !(t.fill > 0))
            throw Error('Invalid open paper result.');
        ids.add(o.signal_id);
        return { ...o, tracking: t };
    });
    let portfolio;
    if (input.portfolio) {
        const p = input.portfolio;
        if (!Number.isFinite(Date.parse(p.started_at)) || !Number.isFinite(Date.parse(p.updated_at)) || typeof p.halted !== 'boolean' || (p.halted && !Number.isFinite(Date.parse(p.halted_at))) || (p.locked_day !== null && !/^\d{4}-\d{2}-\d{2}$/.test(p.locked_day)))
            throw Error('Invalid controlled paper account.');
        const parsed = validateBackgroundJournal({ schema: 1, mode: 'SIMULATION_ONLY', updated_at: p.updated_at, orders: p.orders });
        portfolio = { started_at: p.started_at, updated_at: p.updated_at, limits: validateRiskLimits(p.limits), halted: p.halted, halted_at: p.halted_at, last_control: p.last_control ? validateRiskControl(p.last_control) : null, locked_day: p.locked_day, orders: parsed.orders.map((o, i) => ({ ...o, admitted: p.orders[i].admitted === true })) };
    }
    return { schema: 1, mode: 'SIMULATION_ONLY', updated_at: input.updated_at, orders, ...(portfolio ? { portfolio } : {}) };
}
