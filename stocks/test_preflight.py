import os
import unittest
from datetime import datetime,timedelta
from unittest.mock import patch
from preflight import check,summary
from scanner import UTC,iso

class FakeAlpaca:
 def __init__(self,fail=None,missing=False):self.calls=0;self.fail=fail;self.missing=missing;self.requests=[]
 def calendar(self,start,end):
  self.calls+=1
  if self.fail=='calendar':raise RuntimeError('paper-api.alpaca.markets: HTTP 401')
  return [{'date':'2026-11-20','open':'09:30','close':'16:00'}]
 def bars(self,symbols,start,end,feed):
  self.calls+=1;self.requests.append((symbols,start,end,feed))
  if self.fail==feed:raise RuntimeError('data.alpaca.markets: HTTP 403')
  return {s:[] if self.missing and s=='MSFT' else [{'t':iso(end-timedelta(minutes=1))}] for s in symbols},1

class PreflightTests(unittest.TestCase):
 def test_missing_keys_stop_before_network(self):
  with patch.dict(os.environ,{},clear=True),patch('preflight.Alpaca') as client:
   r=check();self.assertEqual(r['status'],'BLOCKED');client.assert_not_called()
   self.assertIn('APCA_API_KEY_ID',r['blockers'][0]);self.assertIn('APCA_API_SECRET_KEY',r['blockers'][0])
 def test_success_requires_calendar_and_both_feeds(self):
  now=datetime(2026,11,20,15,0,45,tzinfo=UTC);api=FakeAlpaca();r=check(api,now)
  self.assertEqual(r['status'],'AUTHENTICATED_MARKET_DATA_ACCESS_VERIFIED')
  self.assertEqual(r['api_requests'],3)
  self.assertEqual(api.requests[0][2],datetime(2026,11,20,14,44,tzinfo=UTC))
  self.assertEqual(api.requests[1][2],datetime(2026,11,20,15,0,tzinfo=UTC))
  self.assertEqual(r['mode'],'PAPER_ONLY');self.assertIn('separate checks',r['scope'])
 def test_each_feed_is_checked_after_one_fails(self):
  r=check(FakeAlpaca(fail='sip'));self.assertEqual(r['status'],'BLOCKED')
  self.assertEqual(r['feeds']['sip']['status'],'BLOCKED');self.assertEqual(r['feeds']['iex']['status'],'VERIFIED')
 def test_no_false_success_with_missing_bars_or_bad_calendar(self):
  self.assertEqual(check(FakeAlpaca(missing=True))['status'],'BLOCKED')
  self.assertEqual(check(FakeAlpaca(fail='calendar'))['status'],'BLOCKED')
 def test_report_does_not_include_input_credentials(self):
  with patch.dict(os.environ,{'APCA_API_KEY_ID':'fixture-key','APCA_API_SECRET_KEY':'fixture-secret'}):
   r=check(FakeAlpaca());text=summary(r)+str(r)
   self.assertNotIn('fixture-key',text);self.assertNotIn('fixture-secret',text)
if __name__=='__main__':unittest.main()
