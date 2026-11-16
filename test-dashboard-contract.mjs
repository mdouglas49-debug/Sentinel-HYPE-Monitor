// Optional integration check against an available private dashboard checkout.
// No private source, credentials, or production requests are copied into this repo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {deflateRawSync} from 'node:zlib';
import {dashboardSnapshot} from './paper-dashboard.mjs';
import {updateJournal} from './paper-journal.mjs';
const root=process.env.SENTINEL_DASHBOARD_CHECKOUT;
if(!root)throw Error('Set SENTINEL_DASHBOARD_CHECKOUT to the private dashboard checkout.');
const require=createRequire(path.resolve(root,'package.json')),ts=require('typescript'),cache=new Map();
function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);new Function('require','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts')):require(id),exports);return exports;}
const {parseJournalArtifact}=load(path.join(root,'app/paper/core.ts'));
function zip(value){const data=Buffer.from(JSON.stringify(value)),body=deflateRawSync(data),name=Buffer.from('paper-journal.json'),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(8,8);local.writeUInt32LE(body.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(8,10);central.writeUInt32LE(body.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+body.length,16);return Buffer.concat([local,name,body,central,name,end]);}
let journal=null;
for(let i=0;i<502;i++){const t=i*300000;journal=updateJournal(journal,{mode:'SIMULATION_ONLY',status:'SIMULATED_ORDER',symbol:'HYPE',timeframe:'5m',side:'BUY',entry:100,stop:98,target:104,signal_id:`HYPE-5m-${t}`,candle_utc:new Date(t).toISOString(),timestamp:new Date(t+300000).toISOString()},[],t+300000);}
assert.throws(()=>parseJournalArtifact(zip(journal)));
for(const oversized of [false,true]){
 if(oversized)for(const o of journal.orders)o.tracking.note='x'.repeat(5000);
 const snapshot=dashboardSnapshot(journal),parsed=parseJournalArtifact(zip(snapshot));
 assert.equal(parsed.orders.length,snapshot.orders.length);
 assert.deepEqual(parsed.orders.map(o=>o.signal_id),snapshot.orders.map(o=>o.signal_id));
 assert.deepEqual(parsed.portfolio,snapshot.portfolio);
 assert.equal(journal.orders.length,502);
}
console.log('Private dashboard contract passed: full 502-record journal stays durable; bounded and byte-trimmed ZIPs parse through the actual unchanged importer.');
