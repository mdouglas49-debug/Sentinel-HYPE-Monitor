import { api } from 'sdk';

// Transport-only Telegram callback demo. NO proposal storage, trade execution,
// or approval authority. Production approvals need atomic, expiring state.
export default async function (query) {
  if (!query?.id) return;
  const data=query.data;
  if (data !== 'sentinel_demo_yes_v1' && data !== 'sentinel_demo_no_v1') return;
  const chat=query.message?.chat;
  if (!chat || chat.type !== 'private' || String(query.from?.id) !== String(chat.id)) {
    await api.answerCallbackQuery({callback_query_id:query.id,text:'Not authorized for this test',show_alert:true});
    return;
  }
  const choice=data === 'sentinel_demo_yes_v1' ? 'YES' : 'NO';
  await api.answerCallbackQuery({callback_query_id:query.id,text:`${choice} test received. No orders placed.`});
  if (query.message?.message_id != null) {
    await api.editMessageText({
      chat_id:chat.id,
      message_id:query.message.message_id,
      text:`SENTINEL | BUTTON TEST COMPLETE\nSelected: ${choice}\nNo trade approval created. No orders placed.`,
      reply_markup:{inline_keyboard:[]}
    });
  }
}
