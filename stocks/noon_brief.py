"""One-off retrospective morning review and fresh noon paper watchlist."""
from collections import Counter
from datetime import datetime,timedelta
import argparse,base64,json,math,os,statistics
from pathlib import Path
from urllib.parse import urlencode
from scanner import Alpaca,ET,UTC,Journal,at,canonical,digest,event,iso,monitor_once,parse,request,scan,universe

ROOT=Path('stocks-state');REPO='mdouglas49-debug/Sentinel-HYPE-Monitor'
AAD=b'Sentinel noon paper report 2026-11-20 v1'

def completed(bars,start,end,minutes=1):
 return [b for b in bars if start<=parse(b['t']) and parse(b['t'])+timedelta(minutes=minutes)<=end]

def select(symbols,current,previous,history,cutoff):
 candidates=[];excluded={}
 for symbol in symbols:
  bars=current.get(symbol,[]);prior=previous.get(symbol,[])
  volumes=[sum(b['v'] for b in day[symbol]) for day in history if day.get(symbol)]
  reason=None
  if not bars:reason='no_regular_session_bars'
  elif cutoff-(parse(bars[-1]['t'])+timedelta(minutes=1))>timedelta(minutes=3):reason='stale_regular_session'
  elif not prior:reason='no_previous_close'
  elif len(volumes)<5 or statistics.mean(volumes)<=0:reason='insufficient_same_time_history'
  if reason:excluded[symbol]=reason;continue
  price=bars[-1]['c'];opening=bars[0]['o'];previous_close=prior[-1]['c']
  high=max(b['h'] for b in bars);trigger=math.ceil((high+.01)*100-1e-8)/100
  day_change=100*(price/previous_close-1);from_open=100*(price/opening-1)
  rvol=sum(b['v'] for b in bars)/statistics.mean(volumes);distance=100*(trigger/price-1)
  if day_change<=0 or from_open<.3 or rvol<1.5 or distance>1.5:
   excluded[symbol]='below_noon_thresholds';continue
  risk=max(trigger*.005,trigger-min(b['l'] for b in bars[-15:]))
  candidates.append({'symbol':symbol,'trigger':trigger,'stop':round(trigger-risk,2),'target':round(trigger+2*risk,2),
   'sip_price':price,'sip_bar_at':bars[-1]['t'],'day_change_pct':round(day_change,3),'from_open_pct':round(from_open,3),
   'same_time_rvol':round(rvol,3),'distance_pct':round(distance,3),'catalyst':None,
   'reason':f'{day_change:.1f}% vs prior close; +{from_open:.1f}% from open; {rvol:.1f}x same-time volume; {distance:.2f}% below session-high trigger'})
 for c in candidates:
  n=len(candidates)
  c['score']=sum(sum(x[k]<=c[k] for x in candidates)/n if k!='distance_pct' else sum(x[k]>=c[k] for x in candidates)/n for k in ('day_change_pct','from_open_pct','same_time_rvol','distance_pct'))/4
 return sorted(candidates,key=lambda c:(-c['score'],c['symbol'])),excluded

def live_filter(ranked,iex,end):
 picks=[];flagged=[]
 for original in ranked:
  c=dict(original);bars=iex.get(c['symbol'],[])
  if not bars or end-(parse(bars[-1]['t'])+timedelta(minutes=1))>timedelta(minutes=2):
   c['live_status']='IEX_FRESHNESS_UNVERIFIED';flagged.append(c);continue
  b=bars[-1];c.update(iex_price=b['c'],iex_bar_at=b['t'])
  if b['c']>=c['trigger']:c['live_status']='ALREADY_ABOVE_TRIGGER_ON_IEX';flagged.append(c);continue
  if b['c']<=c['stop']:c['live_status']='BELOW_PAPER_STOP_ON_IEX';flagged.append(c);continue
  if 100*(c['trigger']/b['c']-1)>1.5:c['live_status']='TOO_FAR_BELOW_TRIGGER_ON_IEX';flagged.append(c);continue
  c['live_status']='BELOW_TRIGGER_ON_RECENT_IEX_BAR';picks.append(c)
  if len(picks)==5:break
 return picks,flagged

def market_summary(current,previous):
 result={}
 for s in ('SPY','QQQ'):
  b=current.get(s,[]);p=previous.get(s,[])
  if not b or not p:result[s]={'status':'UNVERIFIED'};continue
  result[s]={'price':b[-1]['c'],'bar_at':b[-1]['t'],'day_change_pct':round(100*(b[-1]['c']/p[-1]['c']-1),3),
             'from_open_pct':round(100*(b[-1]['c']/b[0]['o']-1),3),'high':max(x['h'] for x in b),'low':min(x['l'] for x in b)}
 return result

def build(api,now):
 session=str(now.astimezone(ET).date())
 if session!='2026-11-20':raise RuntimeError('This one-off noon report is scoped to November 20, 2026')
 cutoff=min(at(session,'11:45'),(now-timedelta(minutes=15,seconds=5)).replace(second=0,microsecond=0))
 if cutoff<=at(session,'10:00'):raise RuntimeError('Insufficient completed regular-session history for the noon report')
 symbols,membership=universe();sessions=api.calendar(now.astimezone(ET).date()-timedelta(days=40),session)
 if not sessions or sessions[-1]['date']!=session:raise RuntimeError('No verified trading session today')
 past=sessions[:-1][-10:];previous_day=past[-1]['date']
 current,_=api.bars(symbols+['SPY','QQQ'],at(session,'09:30'),cutoff)
 previous,_=api.bars(symbols+['SPY','QQQ'],at(previous_day,'00:00'),at(previous_day,'23:59'),timeframe='1Day')
 history=[]
 for d in past:
  day=d['date'];end=at(day,cutoff.astimezone(ET).strftime('%H:%M'))
  bars,_=api.bars(symbols,at(day,'09:30'),end,timeframe='5Min')
  history.append({s:completed(bars.get(s,[]),at(day,'09:30'),end,5) for s in symbols})
 ranked,excluded=select(symbols,current,previous,history,cutoff)
 shortlist=ranked[:30];iex_end=(datetime.now(UTC)-timedelta(seconds=5)).replace(second=0,microsecond=0)
 iex,_=api.bars([c['symbol'] for c in shortlist],iex_end-timedelta(minutes=10),iex_end,'iex') if shortlist else ({},0)
 picks,flagged=live_filter(shortlist,iex,iex_end)
 for c in picks:
  try:
   data,_=api.get('/v1beta1/news',{'symbols':c['symbol'],'start':iso(at(session,'04:00')),'end':iso(datetime.now(UTC)),'sort':'desc','limit':10})
   articles=[n for n in data.get('news',[]) if c['symbol'] in n.get('symbols',[]) and n.get('url','').startswith('https://') and n.get('source') and n.get('headline') and parse(n['created_at'])<=datetime.now(UTC)]
   if articles:c['catalyst']={k:articles[0][k] for k in ('headline','source','url','created_at')}
  except RuntimeError:pass
 # Reconstruct 09:00 data with news no later than the original brief target.
 morning=scan(api,symbols,membership,session,ROOT/'noon-cache',now=at(session,'09:15')+timedelta(seconds=5))
 journal=Journal(str(ROOT/'noon-replay.sqlite'));journal.add(morning)
 monitor_once(api,morning,journal,ROOT/'noon-cache',now=datetime.now(UTC),window=cutoff.astimezone(ET).strftime('%H:%M'))
 events=journal.events();recap=[]
 for c in morning['candidates']:
  row={'candidate':c,'feeds':{}}
  for feed in ('iex','sip'):
   hit=next((e for e in events if e['kind']=='breakout' and e['candidate']['symbol']==c['symbol'] and e['feed']==feed),None)
   outcomes=[e for e in events if e['kind']=='outcome' and e['symbol']==c['symbol'] and e['feed']==feed]
   row['feeds'][feed]={'confirmation':hit['confirmation'] if hit else None,'outcome':outcomes[-1]['outcome'] if outcomes else {'state':'UNVERIFIED'}}
  recap.append(row)
 journal.db.close()
 return {'schema':1,'mode':'PAPER_ONLY','kind':'noon_review','session':session,'generated_at':iso(datetime.now(UTC)),
  'sip_cutoff':iso(cutoff),'iex_cutoff':iso(iex_end),'membership':membership,'market':market_summary(current,previous),
  'coverage':{'requested':len(symbols),'observed':sum(bool(current.get(s)) for s in symbols),'eligible':len(ranked),'shortlisted':len(picks),'history_sessions':len(history),'exclusions':dict(Counter(excluded.values()))},
  'watchlist':picks,'flagged':flagged[:10],'morning_reconstruction':recap,'api_requests':api.calls,
  'limitations':['Morning setups are reconstructed, not alerts delivered at 09:15. No live monitor was running.',
   'Paper outcomes use a confirming-close entry and subsequent completed bars; fees, slippage and real execution are excluded.',
   'SIP is delayed; IEX is one venue and can differ from consolidated moves and volume.',
   'News references verify publisher association, not a causal explanation. Official current index membership remains unverified.']}

def encrypt(report):
 from cryptography.hazmat.primitives import hashes,serialization
 from cryptography.hazmat.primitives.asymmetric import padding
 from cryptography.hazmat.primitives.ciphers.aead import AESGCM
 key=os.urandom(32);nonce=os.urandom(12)
 public=serialization.load_pem_public_key(Path('stocks/noon-report-public.pem').read_bytes())
 wrapped=public.encrypt(key,padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None))
 cipher=AESGCM(key).encrypt(nonce,canonical(report).encode(),AAD)
 return {'encrypted_report':True,'algorithm':'RSA-OAEP-SHA256+AES-256-GCM','key':base64.b64encode(wrapped).decode(),'nonce':base64.b64encode(nonce).decode(),'ciphertext':base64.b64encode(cipher).decode()}

def messages(report):
 lines=['SENTINEL AI | NOON PAPER WATCHLIST | '+report['session'],
  'Generated '+parse(report['generated_at']).astimezone(ET).strftime('%I:%M %p %Z'),
  'SIP cutoff '+parse(report['sip_cutoff']).astimezone(ET).strftime('%I:%M %p %Z')+' | IEX check '+parse(report['iex_cutoff']).astimezone(ET).strftime('%I:%M %p %Z'),
  f"Coverage {report['coverage']['observed']}/{report['coverage']['requested']}; {report['coverage']['eligible']} eligible."]
 for c in report['watchlist']:
  lines.extend([f"\n{c['symbol']} | trigger ${c['trigger']:.2f} | paper stop ${c['stop']:.2f} | target ${c['target']:.2f}",c['reason'],f"IEX ${c['iex_price']:.2f} at {parse(c['iex_bar_at']).astimezone(ET).strftime('%I:%M %p')} (one venue)"])
  if c.get('catalyst'):lines.append('News: '+c['catalyst']['headline'][:95]+' — '+c['catalyst']['source'])
 if not report['watchlist']:lines.append('No fresh setups met the noon rules and IEX check. No picks are forced.')
 lines.append('\nPaper observation only. Wait for a completed 1m trigger close on strong volume; no trade is placed.')
 recap=['SENTINEL AI | MORNING REVIEW | PAPER RECONSTRUCTION',
        'These are reconstructed setups, not alerts delivered this morning.']
 for symbol,m in report['market'].items():
  if m.get('status')!='UNVERIFIED':recap.append(f"{symbol} ${m['price']:.2f} | {m['day_change_pct']:+.2f}% vs prior close | {m['from_open_pct']:+.2f}% from open")
 for row in report['morning_reconstruction']:
  c=row['candidate'];s=row['feeds']['sip'];i=row['feeds']['iex']
  recap.append(f"{c['symbol']} | SIP: {s['outcome']['state']} | IEX: {i['outcome']['state']} | original trigger ${c['trigger']:.2f}")
 recap.append('Modeled outcomes exclude fees/slippage; missing bars stay UNVERIFIED. SIP cutoff '+parse(report['sip_cutoff']).astimezone(ET).strftime('%I:%M %p %Z'))
 return ['\n'.join(lines),'\n'.join(recap)]

def send(report):
 token,chat=os.environ.get('TELEGRAM_BOT_TOKEN'),os.environ.get('TELEGRAM_CHAT_ID')
 if not token or not chat:raise RuntimeError('Missing Telegram Actions credentials')
 receipts=[]
 for text in messages(report):
  if len(text)>4096:raise RuntimeError('Noon message exceeds Telegram limit')
  raw,_=request('https://api.telegram.org/bot'+token+'/sendMessage',{'Content-Type':'application/json'},{'chat_id':chat,'text':text,'disable_web_page_preview':True})
  result=json.loads(raw)
  if not result.get('ok') or result['result'].get('text')!=text:raise RuntimeError('Noon Telegram receipt was not verified')
  receipts.append({'message_id':result['result']['message_id'],'timestamp':result['result']['date']})
 return receipts

def main():
 p=argparse.ArgumentParser();p.add_argument('phase',choices=['build','send']);args=p.parse_args();ROOT.mkdir(parents=True,exist_ok=True)
 if args.phase=='build':
  report=build(Alpaca(),datetime.now(UTC));(ROOT/'private-noon-report.json').write_text(canonical(report))
  print(canonical(encrypt(report)))
  (ROOT/'noon-claim.json').write_text(canonical({'mode':'PAPER_ONLY','session':report['session'],'state':'ATTEMPT_RESERVED'}))
  print(canonical({'mode':'PAPER_ONLY','phase':'NOON_REPORT_BUILT','cutoff':report['sip_cutoff'],'coverage':report['coverage'],'generated_at':report['generated_at']}))
 else:
  report=json.loads((ROOT/'private-noon-report.json').read_text());receipts=send(report)
  print(canonical({'mode':'PAPER_ONLY','phase':'NOON_TELEGRAM_DELIVERED','receipts':receipts}))
if __name__=='__main__':
 try:main()
 except (RuntimeError,ValueError) as error:print('BLOCKED:',str(error));raise SystemExit(1)
