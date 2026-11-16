// Compatibility export only. The full journal is persisted before this runs.
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {validateJournal} from './paper-journal.mjs';
import {summarize} from './paper-engine.mjs';
export const MAX_DASHBOARD_BYTES = 900000;
export function dashboardSnapshot(input) {
  const journal=validateJournal(input);
  const recent=[...journal.orders].sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp));
  const snapshot={...journal,orders:recent.slice(0,500),summary:null,
    retention:'Dashboard compatibility snapshot; complete history is on the paper-state Git branch.',
    export:{total_setups:recent.length,included_setups:0,truncated:false}};
  // The controlled account has its own 500-record contract. Never silently
  // truncate its risk/control state to make an export fit.
  if((snapshot.portfolio?.orders.length||0)>500)throw Error('Controlled portfolio exceeds dashboard capacity.');
  for(;;){
    snapshot.summary=summarize(snapshot.orders.map(o=>o.tracking));
    snapshot.export.included_setups=snapshot.orders.length;
    snapshot.export.truncated=snapshot.orders.length<recent.length;
    if(Buffer.byteLength(JSON.stringify(snapshot))<=MAX_DASHBOARD_BYTES)return snapshot;
    if(!snapshot.orders.length)throw Error('Controlled portfolio alone exceeds dashboard byte limit.');
    snapshot.orders.pop();
  }
}
export function exportDashboard() {
  const snapshot=dashboardSnapshot(JSON.parse(readFileSync('paper-journal.json','utf8')));
  writeFileSync('paper-dashboard/paper-journal.json',JSON.stringify(snapshot));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const {mkdirSync}=await import('node:fs');mkdirSync('paper-dashboard',{recursive:true});exportDashboard();
}
