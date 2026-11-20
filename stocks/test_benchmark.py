import unittest
from pathlib import Path
from benchmark import measure

class BenchmarkTests(unittest.TestCase):
 def test_cold_then_warm_and_summary_excludes_private_watchlist(self):
  class Api:calls=0
  api=Api();paths=[]
  def fake(api,symbols,membership,session,cache,now):
   marker=Path(cache)/'cached';self.assertEqual(marker.exists(),bool(paths));marker.write_text('fixture')
   paths.append(cache);api.calls+=2 if len(paths)==1 else 1
   return {'cutoff':'2026-11-20T14:00:00Z','coverage':{'requested':2,'with_premarket_bars':1,'eligible':1,'history_sessions':20,'excluded':{'TEST2':'no_premarket_bars'}},'candidates':[{'symbol':'PRIVATE_WATCHLIST','trigger':123}], 'latest_bar_min':'2026-11-20T13:59:00Z','latest_bar_max':'2026-11-20T13:59:00Z'}
  r=measure(api,'2026-11-20',lambda:(['TEST','TEST2'],{'unique':2}),fake)
  self.assertEqual(r['status'],'TIMING_AND_COVERAGE_MEASURED');self.assertEqual(paths[0],paths[1])
  self.assertEqual(r['runs']['cold']['api_requests'],2);self.assertEqual(r['runs']['warm']['api_requests'],1)
  self.assertEqual(r['runs']['cold']['shortlisted'],1);self.assertNotIn('PRIVATE_WATCHLIST',str(r));self.assertFalse(Path(paths[0]).exists())
 def test_failure_keeps_completed_measurements_and_never_reports_success(self):
  class Api:calls=0
  def fail(*args,**kwargs):raise RuntimeError('data.alpaca.markets: HTTP 403')
  r=measure(Api(),'2026-11-20',lambda:(['TEST'],{'unique':1}),fail)
  self.assertEqual(r['status'],'BLOCKED');self.assertEqual(r['runs'],{})
if __name__=='__main__':unittest.main()
