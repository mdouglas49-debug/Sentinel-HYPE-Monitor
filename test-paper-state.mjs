import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {restoreState, saveState} from './paper-state.mjs';
import {updateJournal} from './paper-journal.mjs';
import {summarize} from './paper-engine.mjs';
const root = mkdtempSync(join(tmpdir(),'sentinel-state-')), cwd = process.cwd();
const git = (...args) => execFileSync('git',args,{stdio:'pipe'});
try {
 process.chdir(root);
 git('init','--bare','remote.git'); git('init','work'); process.chdir(join(root,'work')); git('remote','add','origin',join(root,'remote.git'));
 assert.equal(restoreState(),false);
 let journal = updateJournal(null,null,[],600000);
 const base={mode:'SIMULATION_ONLY',status:'SIMULATED_ORDER',symbol:'HYPE',timeframe:'5m',side:'BUY',entry:100,stop:98,target:104};
 for(let i=0;i<502;i++) { const time=i*300000; const o={...base,signal_id:`HYPE-5m-${time}`,candle_utc:new Date(time).toISOString(),timestamp:new Date(time+300000).toISOString()}; journal=updateJournal(journal,o,[],time+300000); }
 assert.equal(journal.orders.length,502);
 journal=updateJournal(journal,journal.orders.at(-1),[],502*300000); assert.equal(journal.orders.length,502);
 writeFileSync('paper-journal.json',JSON.stringify(journal)); saveState();
 assert.throws(saveState,/changed since restore/);
 assert.equal(restoreState(),true);
 assert.equal(JSON.parse(readFileSync('previous-journal/paper-journal.json')).orders.length,502);
 saveState(); assert.equal(restoreState(),true);
 git('remote','set-url','origin',join(root,'missing')); assert.throws(restoreState);
 const summary=summarize([5,-8,2].map((net_pnl,i)=>({state:'CLOSED',net_pnl,signal_id:String(i),exit_candle_utc:new Date(i*60000).toISOString()})));
 assert.equal(summary.max_drawdown,8); assert.equal(summary.losses,1); assert.equal(summary.wins,2); assert.equal(summary.trade_count,3);
 console.log('Durable paper state passed: bootstrap, restart, 502 records, duplicate replay, stale writer rejection, lookup failure, realized drawdown.');
} finally { process.chdir(cwd); rmSync(root,{recursive:true,force:true}); }
