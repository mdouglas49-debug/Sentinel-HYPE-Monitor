import unittest,tempfile
from datetime import timedelta
from pathlib import Path
from scanner import *
S='2026-11-17'
def bar(t, o=100,h=101,l=99,c=100,v=100):return {'t':iso(at(S,t)), 'o':o,'h':h,'l':l,'c':c,'v':v}
C={'symbol':'TEST','trigger':101,'stop':99,'target':105,'reason':'fixture'}
class ScannerTests(unittest.TestCase):
 def test_union_overlap_and_class_symbols(self):
  from unittest.mock import patch
  def fake(url,*args):
   rows=['BRK-B']+[f'S{i}' for i in range(502)] if 's-and-p' in url else ['S0']+[f'N{i}' for i in range(100)]
   return ('Symbol,Name\n'+'\n'.join(s+',Fixture' for s in rows)).encode(),{}
  with patch('scanner.request',fake):
   symbols,m=universe();self.assertEqual(len(symbols),603);self.assertEqual(m['overlap'],1);self.assertIn('BRK.B',symbols)
 def test_pagination_and_incomplete_bar(self):
  api=object.__new__(Alpaca);calls=[]
  def get(path,p):
   calls.append(p.copy())
   return ({'bars':{'TEST':[bar('09:30')]},'next_page_token':'next'} if len(calls)==1 else {'bars':{'TEST':[bar('09:31')]},'next_page_token':None}),{}
  api.get=get
  rows,pages=api.bars(['TEST'],at(S,'09:30'),at(S,'09:31'),'iex')
  self.assertEqual(pages,2);self.assertEqual(len(rows['TEST']),1);self.assertEqual(calls[1]['page_token'],'next');self.assertEqual(calls[1]['feed'],'iex')
 def test_completed_candle_strong_volume(self):
  b=bar('09:30',o=100,c=102,v=200)
  self.assertEqual(confirmations(C,[b],at(S,'09:30'),{'09:30':100},S,'iex'),[])
  self.assertEqual(len(confirmations(C,[b],at(S,'09:31'),{'09:30':100},S,'iex')),1)
  self.assertEqual(confirmations(C,[b],at(S,'09:31'),{},S,'iex'),[])
  self.assertEqual(confirmations(C,[b],at(S,'09:31'),{'09:30':200},S,'iex'),[])
 def test_rank_stale_and_missing_history(self):
  current={'TEST':[bar('08:59',o=100,h=103,l=101,c=102,v=1000)]};prior={'TEST':[bar('08:59',c=100)]};hist=[{'TEST':[bar('08:59',v=100)]} for _ in range(5)]
  ranked,ex,n=rank(['TEST'],current,prior,hist,at(S,'09:00'));self.assertEqual(n,1);self.assertGreater(ranked[0]['trigger'],103);self.assertLess(ranked[0]['stop'],ranked[0]['trigger'])
  self.assertEqual(rank(['TEST'],current,prior,hist[:4],at(S,'09:00'))[1]['TEST'],'insufficient_same_time_history')
  self.assertEqual(rank(['TEST'],current,prior,hist,at(S,'09:10'))[1]['TEST'],'stale_premarket')
 def test_journal_restart_and_ambiguous_send(self):
  with tempfile.TemporaryDirectory() as d:
   filename=str(Path(d)/'journal.sqlite');j=Journal(filename);e=event('delivery_test',S,{},True);calls=[]
   def send(e): calls.append(e);return {'ok':True}
   j.deliver(e,'telegram',send);j=Journal(filename);j.deliver(e,'telegram',send);self.assertEqual(len(calls),1)
   def fail(e):raise RuntimeError('ambiguous timeout')
   with self.assertRaises(RuntimeError):j.deliver(e,'dashboard',fail)
   status,_=j.deliver(e,'dashboard',send);self.assertEqual(status,'UNKNOWN');self.assertEqual(len(calls),1)
   changed={**e,'test':False}
   with self.assertRaises(RuntimeError):j.add(changed)
 def test_one_telegram_alert_across_feeds(self):
  with tempfile.TemporaryDirectory() as d:
   j=Journal(str(Path(d)/'j.sqlite'));calls=[]
   for feed in ('iex','sip'):
    e=event('breakout',S,{'watchlist_id':'fixture','candidate':C,'feed':feed})
    j.deliver(e,'telegram',lambda e:calls.append(e) or {'event_id':e['id']})
   self.assertEqual(len(calls),1);self.assertEqual(len(j.events()),2)
 def test_paper_outcomes_no_lookahead(self):
  confirmation={'bar_at':iso(at(S,'09:30')),'close':102};window=at(S,'09:33')
  self.assertEqual(outcome(C,confirmation,[bar('09:31',h=106,l=98)],at(S,'09:32'),window)['state'],'STOP')
  self.assertEqual(outcome(C,confirmation,[bar('09:31',o=98,h=100,l=97)],at(S,'09:32'),window)['exit'],98)
  self.assertEqual(outcome(C,confirmation,[bar('09:31',h=106,l=100)],at(S,'09:31'),window)['state'],'OPEN')
  self.assertEqual(outcome(C,confirmation,[bar('09:32',h=106,l=100)],window,window)['state'],'UNVERIFIED')
  bars=[bar('09:31',h=103,l=100),bar('09:32',h=103,l=100)]
  self.assertEqual(outcome(C,confirmation,bars,window,window)['state'],'OPEN_AT_WINDOW_END')
 def test_feed_baselines_are_independent(self):
  b=bar('09:30',o=100,c=102,v=200)
  self.assertEqual(len(confirmations(C,[b],at(S,'09:31'),{'09:30':100},S,'iex')),1)
  self.assertEqual(confirmations(C,[b],at(S,'09:31'),{'09:30':1000},S,'sip'),[])
if __name__=='__main__':unittest.main(verbosity=2)
