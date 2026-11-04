// Restore only a successful main-branch checkpoint from our scanner workflow.
import {mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const api='https://api.github.com/repos/mdouglas49-debug/Sentinel-HYPE-Monitor';
const token=process.env.GITHUB_TOKEN;if(!token)throw Error('Missing read-only workflow token.');
async function read(path){const r=await fetch(api+path,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','User-Agent':'Sentinel-Paper-Journal'},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(`Checkpoint lookup failed: HTTP ${r.status}`);return r.json();}
let selected=null,foundExpired=false,sawJournal=false;
for(let page=1;page<=10&&!selected;page++){
 const listing=await read(`/actions/artifacts?per_page=100&page=${page}`);
 for(const a of listing.artifacts){
  if(!/^sentinel-journal-\d+$/.test(a.name)||String(a.workflow_run?.id)===process.env.GITHUB_RUN_ID)continue;
  sawJournal=true;
  if(a.expired){foundExpired=true;continue;}
  const run=await read(`/actions/runs/${a.workflow_run.id}`);
  if(run.path!=='.github/workflows/hype-scan.yml'||run.head_branch!=='main'||run.status!=='completed')continue;
  // The checkpoint upload may have succeeded before a later Telegram step failed.
  // Accept that checkpoint only when the journal upload step itself succeeded.
  const jobs=await read(`/actions/runs/${a.workflow_run.id}/jobs?per_page=100`);
  if(!jobs.jobs.some(j=>j.steps?.some(s=>s.name==='Save background paper journal'&&s.conclusion==='success')))continue;
  if(a.size_in_bytes>1048576)throw Error('Checkpoint archive is too large.');selected=a;break;
 }
 if(listing.artifacts.length<100)break;
}
if(!selected){if(foundExpired||sawJournal)throw Error('Prior paper checkpoint expired. Refusing to silently reset the journal.');console.log('No prior checkpoint; starting a new paper journal.');process.exit(0);}
const redirect=await fetch(`${api}/actions/artifacts/${selected.id}/zip`,{headers:{Authorization:`Bearer ${token}`,'User-Agent':'Sentinel-Paper-Journal'},redirect:'manual',signal:AbortSignal.timeout(15000)});
if(redirect.status!==302)throw Error('Checkpoint download redirect was not returned.');
const url=new URL(redirect.headers.get('location'));
if(url.protocol!=='https:'||url.username||url.password||!(url.hostname.endsWith('.blob.core.windows.net')||url.hostname.endsWith('.githubusercontent.com')||url.hostname==='github.com'||url.hostname.endsWith('.github.com')))throw Error('Unexpected checkpoint download host.');
const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Checkpoint download failed.');
const reader=response.body.getReader(),chunks=[];let size=0;while(true){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>1048576){await reader.cancel();throw Error('Checkpoint archive is too large.');}chunks.push(n.value);}
const zip=Buffer.concat(chunks);
const extracted=spawnSync('python3',['-c',`import io,sys,zipfile
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
names=z.namelist()
if names != ['paper-journal.json']: raise ValueError('Unexpected checkpoint archive')
i=z.getinfo('paper-journal.json')
if i.file_size>1000000: raise ValueError('Checkpoint is too large')
sys.stdout.buffer.write(z.read(i))`],{input:zip,maxBuffer:1048576});
if(extracted.status!==0)throw Error('Checkpoint archive could not be validated.');
const {validateJournal}=await import('./paper-journal.mjs');const journal=validateJournal(JSON.parse(extracted.stdout));
mkdirSync('previous-journal',{recursive:true});writeFileSync('previous-journal/paper-journal.json',JSON.stringify(journal));console.log(`Restored ${journal.orders.length} saved paper setups.`);
