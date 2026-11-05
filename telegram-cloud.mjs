// Telegram Serverless management/run adapter, matching @tgcloud/cli 0.2.0.
// The request runs a pinned local module graph; /manage/run does not consult
// deployed modules. It does not deploy code or change the existing webhook.
import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const MODULE='endpoints/paper_bridge';
const MAX_REQUEST=1048576,MAX_RESPONSE=262144,MAX_SOURCE=131072;
const moduleName=name=>/^(schema|lib\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*|(?:handlers|endpoints)\/[A-Za-z0-9_-]+)$/.test(name);
export class TelegramBridgeError extends Error {
 constructor(code,message){super(message);this.name='TelegramBridgeError';this.code=code;}
}
const fail=(code,message)=>{throw new TelegramBridgeError(code,message);};
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));

export function loadBridgeSources(directory=fileURLToPath(new URL('./tgcloud/',import.meta.url))){
 const sources={};
 function visit(relative){
  for(const entry of readdirSync(path.join(directory,relative),{withFileTypes:true})){
   const name=path.posix.join(relative,entry.name);
   const deployable=relative===''?['schema.js','lib','handlers','endpoints'].includes(entry.name):true;
   if(!deployable)continue;
   if(entry.isSymbolicLink())fail('SOURCE','Telegram bridge source must not contain symbolic links.');
   if(entry.isDirectory()){if(relative===''||relative==='lib'||relative.startsWith('lib/'))visit(name);continue;}
   if(!entry.isFile()||!name.endsWith('.js'))continue;
   if(!moduleName(name.slice(0,-3)))fail('SOURCE','Telegram bridge source module name is invalid.');
   const content=readFileSync(path.join(directory,name),'utf8');
   if(Buffer.byteLength(content)>MAX_SOURCE)fail('SOURCE','Telegram bridge source is too large.');
   sources[name.slice(0,-3)]=content;
  }
 }
 try{visit('');}catch(error){if(error instanceof TelegramBridgeError)throw error;fail('SOURCE','Telegram bridge source could not be loaded.');}
 return sources;
}

async function responseJSON(response){
 const length=Number(response.headers.get('content-length')||0);
 if(length>MAX_RESPONSE){try{await response.body?.cancel();}catch{}fail('RESPONSE_TOO_LARGE','Telegram bridge response is too large.');}
 const reader=response.body?.getReader();
 if(!reader)fail('INVALID_RESPONSE','Telegram bridge returned an empty response.');
 const parts=[];let size=0;
 try{
  while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>MAX_RESPONSE){await reader.cancel();fail('RESPONSE_TOO_LARGE','Telegram bridge response is too large.');}parts.push(next.value);}
 }catch(error){if(error instanceof TelegramBridgeError)throw error;fail('NETWORK','Telegram bridge response was interrupted. Delivery is unconfirmed; retry the same operation.');}
 finally{reader.releaseLock();}
 const bytes=Buffer.concat(parts,size);
 try{return JSON.parse(bytes.toString('utf8'));}catch{fail('INVALID_RESPONSE','Telegram bridge returned an invalid response.');}
}

export async function runBridge(args,{app,token,fetcher=fetch,sources,timeoutMs=15000}={}){
 if(typeof token!=='string'||token.length>2048||!/^app\d{1,20}:[\x21-\x39\x3b-\x7e]+$/.test(token))fail('CONFIGURATION','Configure the Telegram Serverless CLI app credential.');
 const tokenApp=token.slice(0,token.indexOf(':'));
 if(app===undefined)app=tokenApp;
 if(typeof app!=='string'||!/^app\d{1,20}$/.test(app)||app!==tokenApp)fail('CONFIGURATION','Telegram Serverless app and CLI credential do not match.');
 if(!plain(args))fail('INVALID_ARGUMENT','Telegram bridge input must be a JSON object.');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)fail('CONFIGURATION','Telegram bridge timeout is invalid.');
 const graph=sources===undefined?loadBridgeSources():sources;
 if(!plain(graph)||!Object.hasOwn(graph,MODULE)||Object.keys(graph).length>100||Object.entries(graph).some(([name,source])=>!moduleName(name)||typeof source!=='string'||Buffer.byteLength(source)>MAX_SOURCE))fail('SOURCE','Telegram bridge module graph is invalid.');
 let body;
 try{body=JSON.stringify({module:MODULE,sources:graph,args,ctx:{sentinelAutomation:true}});}catch{fail('INVALID_ARGUMENT','Telegram bridge input must be serializable JSON.');}
 if(Buffer.byteLength(body)>MAX_REQUEST)fail('REQUEST_TOO_LARGE','Telegram bridge request is too large.');
 if(body.includes(token))fail('CREDENTIAL_BOUNDARY','Telegram credentials must stay outside bridge inputs and source.');
 let response;
 try{
  response=await fetcher(`https://cloud.telegram.org/${app}/manage/run`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
 }catch{fail('NETWORK','Telegram bridge request failed. Delivery is unconfirmed; retry the same operation.');}
 if(response.status===401||response.status===403)fail('AUTHORIZATION','Telegram bridge access was denied. Check the Serverless CLI app credential.');
 if(response.status===429)fail('RATE_LIMIT','Telegram bridge was rate limited. Retry the same operation on the next run.');
 if(!response.ok)fail('HTTP',`Telegram bridge returned HTTP ${response.status}. Delivery is unconfirmed; retry the same operation.`);
 const envelope=await responseJSON(response);
 if(!plain(envelope)||typeof envelope.ok!=='boolean')fail('INVALID_RESPONSE','Telegram bridge returned an invalid response.');
 if(!envelope.ok)fail('RUN_FAILED','Telegram bridge operation did not complete. Retry the same operation after checking its configuration.');
 if(!plain(envelope.result)||!Object.hasOwn(envelope.result,'result'))fail('INVALID_RESPONSE','Telegram bridge returned an invalid run result.');
 const result=envelope.result.result;
 if(JSON.stringify(result)?.includes(token))fail('CREDENTIAL_BOUNDARY','Telegram bridge result failed its credential boundary check.');
 return result;
}
