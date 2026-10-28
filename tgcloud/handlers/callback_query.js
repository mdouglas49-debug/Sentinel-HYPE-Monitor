import { api, db } from 'sdk';
import { and, eq, gt } from 'sdk/db';
import { paperProposals } from '../schema.js';

export default async function(query){
  if(!query?.id)return;
  const chat=query.message?.chat,chatId=chat?.id;
  const authorized=chat?.type==='private' && chatId!=null && String(query.from?.id)===String(chatId);
  const data=query.data||'';
  if(data==='sentinel_demo_yes_v1'||data==='sentinel_demo_no_v1'){
    if(!authorized){await api.answerCallbackQuery({callback_query_id:query.id,text:'Unauthorized',show_alert:true});return;}
    const choice=data==='sentinel_demo_yes_v1'?'YES':'NO';
    await api.answerCallbackQuery({callback_query_id:query.id,text:`${choice} test received. No orders placed.`});
    await api.editMessageText({chat_id:chatId,message_id:query.message.message_id,text:`SENTINEL | BUTTON TEST COMPLETE\nSelected: ${choice}\nNo orders placed.`,reply_markup:{inline_keyboard:[]}});return;
  }
  if(!data.startsWith('sp:'))return;
  if(!authorized){await api.answerCallbackQuery({callback_query_id:query.id,text:'Unauthorized',show_alert:true});return;}
  const match=/^sp:(yes|no):([1-9][0-9]*)$/.exec(data);
  if(!match){await api.answerCallbackQuery({callback_query_id:query.id,text:'Invalid proposal',show_alert:true});return;}
  const id=Number(match[2]);
  if(!Number.isSafeInteger(id)){await api.answerCallbackQuery({callback_query_id:query.id,text:'Invalid ID'});return;}
  const now=Date.now(),status=match[1]==='yes'?'APPROVED_PAPER':'REJECTED';
  // Atomic conditional update: only one callback may move PENDING to terminal status.
  const [updated]=await db.update(paperProposals).set({status,decidedAt:now})
    .where(and(eq(paperProposals.id,id),eq(paperProposals.chatId,String(chatId)),eq(paperProposals.status,'PENDING'),gt(paperProposals.expiresAt,now)))
    .returning().run();
  if(!updated){
    const existing=await db.select().from(paperProposals).where(and(eq(paperProposals.id,id),eq(paperProposals.chatId,String(chatId)))).get();
    if(existing?.status==='PENDING'&&existing.expiresAt<=now){
      await db.update(paperProposals).set({status:'EXPIRED',decidedAt:now})
        .where(and(eq(paperProposals.id,id),eq(paperProposals.status,'PENDING'))).run();
    }
    await api.answerCallbackQuery({callback_query_id:query.id,text:'Expired, already decided, or unknown. No orders placed.',show_alert:true});
    return;
  }
  await api.answerCallbackQuery({callback_query_id:query.id,text:status==='APPROVED_PAPER'?'YES recorded (PAPER ONLY)':'NO recorded'});
  await api.editMessageText({chat_id:chatId,message_id:query.message.message_id,
    text:`SENTINEL HYPE | PAPER DECISION\n${updated.side} HYPE 5m\nEntry: ${updated.entry}\nStop: ${updated.stop}\nTarget: ${updated.target}\nDecision: ${status}\nNo orders placed.`,
    reply_markup:{inline_keyboard:[]}});
}
