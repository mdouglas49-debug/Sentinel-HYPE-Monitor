// Paper simulation only. No trading keys or order endpoints.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {advanceTrade,startTrade,parseBars,defaults,MINUTE,summarize} from './paper-engine.mjs';
import {validateOrder} from './paper-order.mjs';
import {validateBackgroundJournal as validateJournal} from './paper-journal-validation.mjs';
export {validateJournal};
export function updateJournal(previous,incoming,bars,end){
 const orders=previous?validateJournal(previous).orders.map(o=>({...o})):[];
 if(incoming){const o=validateOrder(incoming);if(!orders.some(x=>x.signal_id===o.signal_id))orders.push({...o,tracking:startTrade(o,defaults)});}
 for(const o of orders)o.tracking=advanceTrade(o,o.tracking,bars,end);
 orders.sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp));
 const retained=orders.slice(0,500);
 return {schema:1,mode:'SIMULATION_ONLY',updated_at:new Date(end).toISOString(),assumptions:defaults,orders:retained,summary:summarize(retained.map(o=>o.tracking)),retention:'Latest 500 independent paper setups; not an account equity curve.'};
}
export async function run(){
 const previous=existsSync('previous-journal/paper-journal.json')?validateJournal(JSON.parse(readFileSync('previous-journal/paper-journal.json','utf8'))):null;
 const incoming=existsSync('simulated-order.json')?validateOrder(JSON.parse(readFileSync('simulated-order.json','utf8'))):null;
 const end=Math.floor(Date.now()/MINUTE)*MINUTE;
 const nexts=(previous?.orders||[]).filter(o=>!['CLOSED','SKIPPED'].includes(o.tracking.state)).map(o=>o.tracking.next_candle);
 if(incoming)nexts.push(startTrade(incoming,defaults).next_candle);
 let bars=[];
 if(nexts.some(t=>t+MINUTE<=end)){
  const response=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin:'HYPE',interval:'1m',startTime:Math.max(Math.min(...nexts),end-4999*MINUTE),endTime:end}}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('Paper journal could not fetch market history. Previous checkpoint remains available.');
  bars=parseBars(await response.json(),end);
 }
 const journal=updateJournal(previous,incoming,bars,end);writeFileSync('paper-journal.json',JSON.stringify(journal));console.log(JSON.stringify({paper_only:true,asof:journal.updated_at,entries:journal.orders.length,...journal.summary}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await run();
