import { readFileSync } from 'node:fs';
const token=process.env.TELEGRAM_BOT_TOKEN, chatId=process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) throw new Error('Missing Telegram secrets');
const text=readFileSync('signal-message.txt','utf8');
const response=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({chat_id:chatId,text}),signal:AbortSignal.timeout(20000)
});
if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
const result=await response.json();
if (!result.ok) throw new Error('Telegram rejected message');
console.log('Telegram qualifying preview delivered.');
