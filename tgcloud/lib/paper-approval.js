import { api, db } from 'sdk';

export const APPROVAL_TTL_MS = 90_000;
const SEND_LEASE_MS = 30_000;
const SIGNAL_AGE_MS = 10 * 60_000;
const proposalTable = 'sentinel_paper_proposals';
const configTable = 'sentinel_paper_bridge_config';
const signalPattern = /^HYPE-5m-[0-9]+$/;

function telegramId(value) {
  const id = String(value ?? '');
  if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw Error('Invalid private Telegram ID.');
  return id;
}
function normalizeSignal(signal, now) {
  if (signal?.status !== 'SIGNAL_PREVIEW_ONLY' || signal.symbol !== 'HYPE' || signal.timeframe !== '5m' || !['BUY','SELL'].includes(signal.side)) throw Error('Unsupported paper signal.');
  const {entry,stop,target} = signal;
  if (![entry,stop,target].every(x => typeof x === 'number' && Number.isFinite(x) && x > 0)) throw Error('Invalid paper prices.');
  if (signal.side === 'BUY' ? !(stop < entry && entry < target) : !(target < entry && entry < stop)) throw Error('Invalid protective bracket.');
  const rr = Math.abs(target-entry) / Math.abs(entry-stop), candle = Date.parse(signal.candle_utc);
  if (!Number.isFinite(rr) || rr < 1.5) throw Error('Insufficient paper reward/risk.');
  if (!Number.isFinite(candle) || candle+300_000 > now || now-candle > SIGNAL_AGE_MS) throw Error('Paper signal is stale or incomplete.');
  return {signal_id:`HYPE-5m-${candle}`,side:signal.side,entry,stop,target,candle_utc:new Date(candle).toISOString(),reward_to_risk:rr};
}
function orderFor(row, decidedAt) {
  const signal = normalizeSignal({status:'SIGNAL_PREVIEW_ONLY',symbol:'HYPE',timeframe:'5m',side:row.side,entry:Number(row.entry),stop:Number(row.stop),target:Number(row.target),candle_utc:row.candle_utc}, row.created_at);
  if (signal.signal_id !== row.signal_id || !Number.isSafeInteger(decidedAt) || decidedAt < row.created_at || decidedAt >= row.expires_at) throw Error('Invalid paper decision.');
  // Keep the existing simulated-order.json contract. Entry timing starts at YES.
  return {mode:'SIMULATION_ONLY',signal_id:signal.signal_id,symbol:'HYPE',timeframe:'5m',side:signal.side,entry:signal.entry,stop:signal.stop,target:signal.target,reward_to_risk:Number(signal.reward_to_risk.toFixed(2)),status:'SIMULATED_ORDER',candle_utc:signal.candle_utc,timestamp:new Date(decidedAt).toISOString()};
}
export async function bridgeConfiguration() {
  const row = await db.get(`SELECT * FROM ${configTable} WHERE id = 1`);
  if (!row || row.owner_id !== row.chat_id || ![0,1].includes(row.enabled)) return null;
  try { telegramId(row.owner_id); telegramId(row.chat_id); } catch { return null; }
  return row;
}
export function ownerMessage(message, config) {
  return !!config && message?.chat?.type === 'private' && String(message.chat.id) === config.chat_id && String(message.from?.id) === config.owner_id;
}
function brief(row, status) {
  return {status,signal_id:row.signal_id,proposal_id:row.id,expires_at:row.expires_at,message_id:row.telegram_message_id ?? null};
}
async function storedProposal(id, config) {
  return db.get(`SELECT * FROM ${proposalTable} WHERE id = :id AND owner_id = :owner AND chat_id = :chat`,{':id':id,':owner':config.owner_id,':chat':config.chat_id});
}
export async function proposeSignal(signal) {
  const config = await bridgeConfiguration();
  if (!config?.enabled) return {status:'DISABLED'};
  const now = Date.now(), s = normalizeSignal(signal,now), fingerprint = `${config.owner_id}:${s.signal_id}`;
  await db.run(`INSERT INTO ${proposalTable} (fingerprint,owner_id,chat_id,signal_id,side,entry,stop,target,candle_utc,created_at,expires_at,status) VALUES (:fingerprint,:owner,:chat,:signal,:side,:entry,:stop,:target,:candle,:created,:expires,'PENDING') ON CONFLICT(fingerprint) DO NOTHING`,{':fingerprint':fingerprint,':owner':config.owner_id,':chat':config.chat_id,':signal':s.signal_id,':side':s.side,':entry':String(s.entry),':stop':String(s.stop),':target':String(s.target),':candle':s.candle_utc,':created':now,':expires':now+APPROVAL_TTL_MS});
  let row = await db.get(`SELECT * FROM ${proposalTable} WHERE fingerprint = :fingerprint`,{':fingerprint':fingerprint});
  if (!row || row.owner_id !== config.owner_id || row.chat_id !== config.chat_id) throw Error('Paper proposal could not be loaded.');
  if (row.status !== 'PENDING') return brief(row,'DUPLICATE');
  if (row.expires_at <= now) {
    await db.run(`UPDATE ${proposalTable} SET status = 'EXPIRED', decided_at = :now WHERE id = :id AND status = 'PENDING' AND expires_at <= :now`,{':now':now,':id':row.id});
    return brief(row,'EXPIRED');
  }
  if (row.telegram_message_id != null) return brief(row,'DUPLICATE');
  const claimed = await db.run(`UPDATE ${proposalTable} SET send_claimed_at = :now WHERE id = :id AND status = 'PENDING' AND expires_at > :now AND telegram_message_id IS NULL AND (send_claimed_at IS NULL OR send_claimed_at <= :old) RETURNING *`,{':now':now,':old':now-SEND_LEASE_MS,':id':row.id});
  row = claimed.rows?.[0];
  if (!row) return {status:'DELIVERY_PENDING',signal_id:s.signal_id};
  try {
    const remaining = Math.max(0,Math.ceil((row.expires_at-Date.now())/1000));
    const text = ['SENTINEL HYPE | PAPER APPROVAL',`${row.side} HYPE 5m`,`Entry: ${row.entry}`,`Stop: ${row.stop}`,`Target: ${row.target}`,`Expires in ${remaining} seconds. YES queues a paper simulation.`,`NO rejects this setup. No live order can be placed.`].join('\n');
    const sent = await api.sendMessage({chat_id:config.chat_id,text,reply_markup:{inline_keyboard:[[{text:'YES · PAPER',callback_data:`sp:yes:${row.id}`},{text:'NO',callback_data:`sp:no:${row.id}`}]]}});
    if (!Number.isSafeInteger(sent?.message_id) || sent.message_id <= 0) throw Error('Telegram did not confirm a proposal message.');
    const saved = await db.run(`UPDATE ${proposalTable} SET telegram_message_id = :message, send_claimed_at = NULL WHERE id = :id AND status = 'PENDING' AND send_claimed_at = :claim RETURNING *`,{':message':sent.message_id,':id':row.id,':claim':now});
    if (saved.rows?.length) return brief(saved.rows[0],'SENT');
    // A slow send can lose its lease to another attempt. Never report delivery
    // until a message is actually bound, or the proposal is already terminal.
    const current = await storedProposal(row.id,config);
    if (!current) throw Error('Paper proposal could not be loaded.');
    return brief(current,current.telegram_message_id != null || current.status !== 'PENDING' ? 'DUPLICATE' : 'DELIVERY_PENDING');
  } catch {
    // An unconfirmed send may have reached Telegram. Retry the SAME proposal,
    // with its original expiry and immutable payload; only the saved message binds.
    await db.run(`UPDATE ${proposalTable} SET send_claimed_at = NULL WHERE id = :id AND status = 'PENDING' AND send_claimed_at = :claim`,{':id':row.id,':claim':now});
    throw Error('Paper proposal delivery was not confirmed. Retry the same signal before its original expiry.');
  }
}
async function answer(query, text, alert=false) {
  await api.answerCallbackQuery({callback_query_id:query.id,text,show_alert:alert});
}
export async function handleApprovalCallback(query) {
  if (!query?.id) return {status:'IGNORED'};
  const data = query.data || '';
  if (!data.startsWith('sp:') && data !== 'sentinel_demo_yes_v1' && data !== 'sentinel_demo_no_v1') return {status:'IGNORED'};
  const config = await bridgeConfiguration();
  if (!config?.enabled || !ownerMessage({chat:query.message?.chat,from:query.from},config)) {
    await answer(query,'Paper approvals are unavailable for this user or chat.',true); return {status:'UNAUTHORIZED'};
  }
  if (data === 'sentinel_demo_yes_v1' || data === 'sentinel_demo_no_v1') {
    const choice = data === 'sentinel_demo_yes_v1' ? 'YES' : 'NO';
    await answer(query,`${choice} test received. No paper entry queued.`);
    await api.editMessageText({chat_id:config.chat_id,message_id:query.message.message_id,text:`SENTINEL | BUTTON TEST COMPLETE\nSelected: ${choice}\nNo paper or live orders placed.`,reply_markup:{inline_keyboard:[]}});
    return {status:'TEST_ONLY'};
  }
  const match = /^sp:(yes|no):([1-9][0-9]*)$/.exec(data), id = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(id)) { await answer(query,'Invalid paper proposal.',true); return {status:'INVALID'}; }
  let row = await storedProposal(id,config);
  if (!row || !Number.isSafeInteger(query.message?.message_id) || row.telegram_message_id !== query.message.message_id) {
    await answer(query,'This message is not bound to the paper proposal.',true); return {status:'UNBOUND'};
  }
  const now = Date.now(), choice = match[1], nextStatus = choice === 'yes' ? 'APPROVED_PAPER' : 'REJECTED';
  if (row.status === 'PENDING' && row.expires_at <= now) {
    await db.run(`UPDATE ${proposalTable} SET status = 'EXPIRED', decided_at = :now WHERE id = :id AND status = 'PENDING' AND owner_id = :owner AND chat_id = :chat AND expires_at <= :now`,{':now':now,':id':id,':owner':config.owner_id,':chat':config.chat_id});
  } else if (row.status === 'PENDING') {
    const approved = choice === 'yes' ? JSON.stringify(orderFor(row,now)) : null;
    // The decision and exportable order become durable in ONE conditional write.
    // Concurrent/replayed YES and NO cannot both win, even across isolate restarts.
    await db.run(`UPDATE ${proposalTable} SET status = :status, decided_at = :now, approved_order_json = :approved WHERE id = :id AND owner_id = :owner AND chat_id = :chat AND telegram_message_id = :message AND status = 'PENDING' AND expires_at > :now AND EXISTS (SELECT 1 FROM ${configTable} WHERE id = 1 AND owner_id = :owner AND chat_id = :chat AND enabled = 1) RETURNING *`,{':status':nextStatus,':now':now,':approved':approved,':id':id,':owner':config.owner_id,':chat':config.chat_id,':message':query.message.message_id});
  }
  row = await storedProposal(id,config);
  const text = row.status === 'APPROVED_PAPER' ? 'YES recorded. Paper simulation queued; no live order.' : row.status === 'REJECTED' ? 'NO recorded. No paper entry queued.' : row.status === 'EXPIRED' ? 'Proposal expired. No paper entry queued.' : 'Paper approvals are unavailable. No decision recorded.';
  await answer(query,text);
  await api.editMessageText({chat_id:config.chat_id,message_id:query.message.message_id,text:`SENTINEL HYPE | PAPER DECISION\n${row.side} HYPE 5m\nEntry: ${row.entry}\nStop: ${row.stop}\nTarget: ${row.target}\nDecision: ${row.status}\n${row.status === 'APPROVED_PAPER' ? 'Paper simulation queued. No live order.' : 'No paper entry queued.'}`,reply_markup:{inline_keyboard:[]}});
  return {status:row.status,signal_id:row.signal_id};
}
function managementContext(ctx) {
  if (ctx?.sentinelAutomation !== true || ctx.initData !== undefined) throw Error('The paper bridge requires authenticated management access.');
}
async function pendingCount(config) {
  const row = await db.get(`SELECT count(*) AS count FROM ${proposalTable} WHERE owner_id = :owner AND chat_id = :chat AND status = 'APPROVED_PAPER' AND approved_order_json IS NOT NULL AND delivered_at IS NULL`,{':owner':config.owner_id,':chat':config.chat_id});
  return Number(row?.count || 0);
}
export async function runBridge(input, ctx) {
  managementContext(ctx);
  if (!input || typeof input !== 'object') throw Error('A bridge operation is required.');
  if (input.operation === 'configure') {
    const owner = telegramId(input.ownerId), chat = telegramId(input.chatId);
    if (owner !== chat || typeof input.enabled !== 'boolean') throw Error('Configure one private owner chat and an explicit enabled flag.');
    await db.run(`INSERT INTO ${configTable} (id,owner_id,chat_id,enabled,updated_at) VALUES (1,:owner,:chat,:enabled,:now) ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, chat_id = excluded.chat_id, enabled = excluded.enabled, updated_at = excluded.updated_at`,{':owner':owner,':chat':chat,':enabled':input.enabled ? 1 : 0,':now':Date.now()});
    return runBridge({operation:'status'},ctx);
  }
  const config = await bridgeConfiguration();
  if (input.operation === 'status') {
    // Bind the management credential to the expected bot before the scanner
    // sends proposals, exports approvals, or acknowledges delivered records.
    const bot = await api.getMe();
    return {configured:!!config,enabled:!!config?.enabled,ownerId:config?.owner_id || null,chatId:config?.chat_id || null,bot_username:typeof bot?.username === 'string' ? bot.username : null,pending:config ? await pendingCount(config) : 0};
  }
  if (!config?.enabled) return input.operation === 'drain' ? {status:'DISABLED',orders:[],signal_ids:[],pending:0} : {status:'DISABLED'};
  if (input.operation === 'propose') return proposeSignal(input.signal);
  if (input.operation === 'drain') {
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('Drain limit must be 1–50.');
    const rows = await db.all(`SELECT * FROM ${proposalTable} WHERE owner_id = :owner AND chat_id = :chat AND status = 'APPROVED_PAPER' AND approved_order_json IS NOT NULL AND delivered_at IS NULL ORDER BY decided_at ASC, id ASC LIMIT :limit`,{':owner':config.owner_id,':chat':config.chat_id,':limit':limit});
    const orders = rows.map(row => {
      const expected = orderFor(row,row.decided_at), saved = JSON.parse(row.approved_order_json);
      if (JSON.stringify(saved) !== JSON.stringify(expected)) throw Error('A saved paper decision failed validation.');
      return saved;
    });
    return {orders,signal_ids:orders.map(o => o.signal_id),pending:await pendingCount(config)};
  }
  if (input.operation === 'acknowledge') {
    if (!Array.isArray(input.signal_ids) || input.signal_ids.length > 50 || input.signal_ids.some(id => typeof id !== 'string' || !signalPattern.test(id))) throw Error('Acknowledgement requires at most 50 Sentinel signal IDs.');
    const ids = [...new Set(input.signal_ids)], confirmed = []; let acknowledged = 0;
    for (const id of ids) {
      const row = await db.get(`SELECT id FROM ${proposalTable} WHERE owner_id = :owner AND chat_id = :chat AND signal_id = :signal AND status = 'APPROVED_PAPER' AND approved_order_json IS NOT NULL`,{':owner':config.owner_id,':chat':config.chat_id,':signal':id});
      if (!row) continue;
      confirmed.push(id);
      const result = await db.run(`UPDATE ${proposalTable} SET delivered_at = :now WHERE owner_id = :owner AND chat_id = :chat AND signal_id = :signal AND status = 'APPROVED_PAPER' AND approved_order_json IS NOT NULL AND delivered_at IS NULL`,{':now':Date.now(),':owner':config.owner_id,':chat':config.chat_id,':signal':id});
      acknowledged += result.rowsAffected || 0;
    }
    return {acknowledged,signal_ids:confirmed};
  }
  throw Error('Unknown paper bridge operation.');
}
