// One isolated, SQLite-backed fake Telegram SDK per test process. Importing this
// file does nothing: callers explicitly create/close a runtime. No network calls.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export async function createTelegramRuntime({now=Date.now()}={}) {
 if(globalThis.__sentinelApprovalSdk)throw Error('Close the active fake Telegram runtime first.');
 const directory=mkdtempSync(join(tmpdir(),'sentinel-paper-approval-')),dbPath=join(directory,'state.sqlite');
 let sqlite=new DatabaseSync(dbPath),clock=now,messageId=100,loseSend=false,marketReads=0,disableDuringDecision=false,closed=false;
 const realNow=Date.now;Date.now=()=>clock;
 const sent=[],answers=[],edits=[];
 const sdk={
  db:{
   async get(query,params={}){return sqlite.prepare(query).get(params) || null;},
   async all(query,params={}){return sqlite.prepare(query).all(params);},
   async run(query,params={}){
    if(disableDuringDecision && query.includes('SET status = :status')){disableDuringDecision=false;sqlite.exec('UPDATE sentinel_paper_bridge_config SET enabled = 0 WHERE id = 1');}
    const statement=sqlite.prepare(query);
    if(/\bRETURNING\b/i.test(query)){const rows=statement.all(params);return {rowsAffected:rows.length,lastInsertRowid:0,rows};}
    const r=statement.run(params);return {rowsAffected:Number(r.changes),lastInsertRowid:Number(r.lastInsertRowid),rows:[]};
   },
  },
  api:{
   async getMe(){return {id:1234567890,is_bot:true,username:'SentinelHypeAI_bot'};},
   async sendMessage(payload){const result={message_id:++messageId};sent.push({...payload,...result});if(loseSend){loseSend=false;throw Error('Unconfirmed provider result');}return result;},
   async answerCallbackQuery(payload){answers.push(payload);return true;},
   async editMessageText(payload){edits.push(payload);return true;},
  },
  async fetch(url,options){
   assert.equal(url,'https://api.hyperliquid.xyz/info');assert.equal(options.method,'POST');const body=JSON.parse(options.body);assert.equal(body.type,'candleSnapshot');assert.equal(body.req.coin,'HYPE');assert.equal(body.req.interval,'5m');marketReads++;
   const end=Math.floor(clock/300000)*300000;
   return Response.json(Array.from({length:240},(_,i)=>({t:end-(240-i)*300000,h:'101',l:'99',c:'100'})));
  },
 };
 globalThis.__sentinelApprovalSdk=sdk;
 const hooks=registerHooks({resolve(specifier,context,next){return specifier==='sdk'?{url:'sentinel-sdk:fixture',shortCircuit:true}:next(specifier,context);},load(url,context,next){return url==='sentinel-sdk:fixture'?{format:'module',source:`export const api={getMe:(...a)=>globalThis.__sentinelApprovalSdk.api.getMe(...a),sendMessage:(...a)=>globalThis.__sentinelApprovalSdk.api.sendMessage(...a),answerCallbackQuery:(...a)=>globalThis.__sentinelApprovalSdk.api.answerCallbackQuery(...a),editMessageText:(...a)=>globalThis.__sentinelApprovalSdk.api.editMessageText(...a)};export const db={get:(...a)=>globalThis.__sentinelApprovalSdk.db.get(...a),all:(...a)=>globalThis.__sentinelApprovalSdk.db.all(...a),run:(...a)=>globalThis.__sentinelApprovalSdk.db.run(...a)};export const fetch=(...a)=>globalThis.__sentinelApprovalSdk.fetch(...a);`,shortCircuit:true}:next(url,context);}});
 function close(){if(closed)return;closed=true;Date.now=realNow;hooks.deregister();delete globalThis.__sentinelApprovalSdk;sqlite.close();rmSync(directory,{recursive:true,force:true});}
 try{
  sqlite.exec(`CREATE TABLE sentinel_paper_proposals (
   id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL,
   side TEXT NOT NULL, entry TEXT NOT NULL, stop TEXT NOT NULL, target TEXT NOT NULL,
   candle_utc TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
   status TEXT NOT NULL, decided_at INTEGER, owner_id TEXT, signal_id TEXT,
   telegram_message_id INTEGER, send_claimed_at INTEGER, approved_order_json TEXT, delivered_at INTEGER
  );CREATE TABLE sentinel_paper_bridge_config (id INTEGER PRIMARY KEY,owner_id TEXT NOT NULL,chat_id TEXT NOT NULL,enabled INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
  const endpoint=(await import('../tgcloud/endpoints/paper_bridge.js')).default;
  const callback=(await import('../tgcloud/handlers/callback_query.js')).default;
  const message=(await import('../tgcloud/handlers/message.js')).default;
  return {
   endpoint,callback,message,sdk,sent,answers,edits,
   bridge:(input,ctx={sentinelAutomation:true})=>endpoint(input,ctx),
   get now(){return clock;},set now(value){clock=value;},
   get sqlite(){return sqlite;},get marketReads(){return marketReads;},
   set loseNextSend(value){loseSend=value;},set disableDuringDecision(value){disableDuringDecision=value;},
   async restart(){sqlite.close();sqlite=new DatabaseSync(dbPath);},
   close,
  };
 }catch(error){close();throw error;}
}
