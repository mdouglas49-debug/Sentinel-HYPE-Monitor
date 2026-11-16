import assert from 'node:assert/strict';
import {dashboardSnapshot,MAX_DASHBOARD_BYTES} from './paper-dashboard.mjs';
import {validateJournal,updateJournal} from './paper-journal.mjs';
const base={mode:'SIMULATION_ONLY',status:'SIMULATED_ORDER',symbol:'HYPE',timeframe:'5m',side:'BUY',entry:100,stop:98,target:104};
let journal=null;
for(let i=0;i<502;i++){
 const t=i*300000;
 journal=updateJournal(journal,{...base,signal_id:`HYPE-5m-${t}`,candle_utc:new Date(t).toISOString(),timestamp:new Date(t+300000).toISOString()},[],t+300000);
}
const original=JSON.stringify(journal),snapshot=dashboardSnapshot(journal);
assert.equal(journal.orders.length,502);assert.equal(snapshot.orders.length,500);
assert.equal(snapshot.orders[0].signal_id,journal.orders[0].signal_id);
assert.equal(snapshot.export.total_setups,502);assert.equal(snapshot.export.truncated,true);
assert.deepEqual(snapshot.portfolio,validateJournal(journal).portfolio);
assert.equal(JSON.stringify(journal),original);
for(const o of journal.orders)o.tracking.note='x'.repeat(5000);
const compact=dashboardSnapshot(journal);
assert(compact.orders.length<500);assert(Buffer.byteLength(JSON.stringify(compact))<=MAX_DASHBOARD_BYTES);
assert.deepEqual(compact.portfolio,validateJournal(journal).portfolio);
assert.equal(compact.summary.trade_count,compact.orders.length);
assert.throws(()=>dashboardSnapshot({...journal,portfolio:{...journal.portfolio,orders:journal.portfolio.orders.map(o=>({...o,tracking:{...o.tracking,note:'x'.repeat(5000)}}))}}),/portfolio alone exceeds/);
console.log('Dashboard export passed: 502 durable setups, newest 500 snapshot, byte bounds, accurate scope, unchanged risk state, immutable input, oversized risk state fails closed.');
