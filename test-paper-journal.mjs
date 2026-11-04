import assert from 'node:assert/strict';
import {updateJournal,validateJournal} from './paper-journal.mjs';
const o={mode:'SIMULATION_ONLY',status:'SIMULATED_ORDER',symbol:'HYPE',timeframe:'5m',side:'BUY',signal_id:'HYPE-5m-0',candle_utc:new Date(0).toISOString(),timestamp:new Date(60001).toISOString(),entry:100,stop:98,target:104};
let j=updateJournal(null,o,[{t:120000,o:100,h:101,l:99,c:100}],180000);assert.equal(j.summary.open,1);
j=updateJournal(JSON.parse(JSON.stringify(j)),o,[{t:180000,o:100,h:105,l:99,c:104}],240000);assert.equal(j.orders.length,1);assert.equal(j.summary.closed,1);assert(j.summary.net_pnl>0);assert(j.summary.fees>0);
const frozen=JSON.stringify(j.orders);j=updateJournal(j,{...o,entry:101,target:108},[],300000);assert.equal(JSON.stringify(j.orders),frozen);
const gap=updateJournal(null,o,[{t:180000,o:100,h:105,l:99,c:104}],240000);assert.equal(gap.summary.unverified,1);assert.equal(gap.summary.closed,0);
assert.throws(()=>validateJournal({...j,mode:'LIVE'}));assert.throws(()=>validateJournal({...j,orders:[j.orders[0],j.orders[0]]}));
console.log('Background journal passed: checkpoint resume, fill, target exit, fees, duplicates, immutable results, and missing-history exclusion.');
