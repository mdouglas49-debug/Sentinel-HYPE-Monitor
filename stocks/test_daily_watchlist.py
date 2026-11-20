import json,os,tempfile,unittest
from datetime import datetime,timedelta
from pathlib import Path
from unittest.mock import patch
import daily_watchlist as daily
from scanner import ET,UTC,at,digest,event

SESSION='2026-11-23'
def clock(time):return at(SESSION,time)
def sample(now):
 return event('watchlist',SESSION,{'created_at':now.isoformat(),'cutoff':clock('08:59').isoformat(),'feed':'sip','candidates':[{'symbol':'PRIVATE_FIXTURE','trigger':101,'stop':99,'target':105,'reason':'fixture','catalyst':None}],'coverage':{'requested':2,'with_premarket_bars':2,'eligible':1,'history_sessions':20,'excluded':{'OTHER':'below_pilot_thresholds'}}})
class Api:
 calls=0
 def calendar(self,start,end):self.calls+=1;return [{'date':SESSION}]

class DailyWatchlistTests(unittest.TestCase):
 def test_eastern_dst_selects_correct_utc_slot(self):
  self.assertFalse(daily.gate(datetime(2026,11,23,13,12,tzinfo=UTC))['should_run'])
  self.assertTrue(daily.gate(datetime(2026,11,23,14,12,tzinfo=UTC))['should_run'])
  self.assertTrue(daily.gate(datetime(2026,7,20,13,12,tzinfo=UTC))['should_run'])
  self.assertFalse(daily.gate(datetime(2026,7,20,14,12,tzinfo=UTC))['should_run'])
 def test_weekends_and_open_boundary(self):
  self.assertFalse(daily.gate(datetime(2026,11,21,14,12,tzinfo=UTC))['should_run'])
  self.assertEqual(daily.gate(clock('09:30'))['status'],'MISSED_PREMARKET_WINDOW')
  self.assertTrue(daily.gate(clock('11:00'),preview=True)['should_run'])
 def test_duplicate_claim_stops_before_broker_or_scan(self):
  class Never:
   def calendar(self,*args):self.fail('Broker should not be called')
  report,e=daily.prepare(Never(),clock('09:12'),claimed=lambda s:True)
  self.assertEqual(report['status'],'SKIPPED_ALREADY_CLAIMED');self.assertIsNone(e)
 def test_holiday_stops_without_scanning_or_waiting(self):
  api=Api();api.calendar=lambda *args:[]
  def no_wait(*args):self.fail('Holiday must not wait or scan')
  report,e=daily.prepare(api,clock('09:12'),claimed=lambda s:False,wait=no_wait)
  self.assertEqual(report['status'],'SKIPPED_MARKET_HOLIDAY');self.assertIsNone(e)
 def test_preview_never_prepares_delivery_and_hides_picks(self):
  api=Api()
  def scan(*args,**kwargs):return sample(kwargs['now'])
  r,e=daily.prepare(api,clock('11:00'),preview=True,load_universe=lambda:(['TEST','OTHER'],{}),scan_fn=scan)
  self.assertEqual(r['status'],'PREVIEW_VERIFIED');self.assertFalse(r['prepared'])
  self.assertNotIn('PRIVATE_FIXTURE',json.dumps(r));self.assertEqual(r['shortlisted'],1)
 def test_live_preparation_waits_for_the_data_cutoff(self):
  waits=[];api=Api()
  def wait(t):waits.append(t);return t
  r,e=daily.prepare(api,clock('09:12'),claimed=lambda s:False,load_universe=lambda:(['TEST','OTHER'],{}),scan_fn=lambda *a,**kw:sample(kw['now']),wait=wait)
  self.assertTrue(r['prepared']);self.assertEqual(waits,[clock('09:14')+timedelta(seconds=20)])
 def test_missing_fresh_data_is_never_a_zero_signal_claim(self):
  e=sample(clock('09:14'));e['coverage']['with_premarket_bars']=0
  with self.assertRaisesRegex(RuntimeError,'No fresh'):
   daily.prepare(Api(),clock('11:00'),preview=True,load_universe=lambda:(['TEST'],{}),scan_fn=lambda *a,**kw:e)
 def test_telegram_waits_until_0915_and_confirms_receipt(self):
  calls=[];e=sample(clock('09:14'));r={'mode':'PAPER_ONLY','telegram':{}}
  def sender(value):calls.append(value);return {'message_id':1,'date':2,'payload_sha256':digest(value)}
  with tempfile.TemporaryDirectory() as directory,patch.object(daily,'ROOT',Path(directory)):
   r=daily.send_telegram(e,r,sender=sender,clock=lambda:clock('09:14'),wait=lambda t:t)
  self.assertEqual(len(calls),1);self.assertEqual(r['telegram']['status'],'CONFIRMED');self.assertEqual(r['late_seconds'],0)
 def test_no_delivery_after_open(self):
  with self.assertRaisesRegex(RuntimeError,'window'):
   daily.send_telegram(sample(clock('09:14')),{},sender=lambda e:self.fail('No late send'),clock=lambda:clock('09:30'))
 def test_dashboard_missing_key_does_not_erase_telegram_success(self):
  with patch.dict(os.environ,{},clear=True):
   r=daily.send_dashboard({}, {'status':'TELEGRAM_DELIVERED','telegram':{'status':'CONFIRMED'}})
  self.assertEqual(r['status'],'TELEGRAM_DELIVERED');self.assertEqual(r['dashboard']['status'],'PENDING_CREDENTIAL')
if __name__=='__main__':unittest.main()
