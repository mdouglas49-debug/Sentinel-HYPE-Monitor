import unittest
from datetime import timedelta
from noon_brief import completed,live_filter,select
from scanner import at,iso
S='2026-11-20'
def bar(t,c=102,v=100,h=103,l=101):return {'t':iso(at(S,t)),'o':100,'h':h,'l':l,'c':c,'v':v}
class NoonBriefTests(unittest.TestCase):
 def test_excludes_incomplete_five_minute_history(self):
  self.assertEqual(len(completed([bar('11:40'),bar('11:45')],at(S,'09:30'),at(S,'11:45'),5)),1)
 def test_noon_candidate_requires_matching_clock_volume_and_proximity(self):
  current={'TEST':[bar('11:44',v=1000)]};prior={'TEST':[bar('09:30',c=100)]};history=[{'TEST':[bar('11:40',v=100)]} for _ in range(5)]
  picks,excluded=select(['TEST'],current,prior,history,at(S,'11:45'))
  self.assertEqual(len(picks),1);self.assertGreater(picks[0]['trigger'],103);self.assertLess(picks[0]['stop'],picks[0]['trigger'])
  self.assertEqual(select(['TEST'],current,prior,history[:4],at(S,'11:45'))[1]['TEST'],'insufficient_same_time_history')
 def test_already_broken_or_stale_iex_is_not_fresh_entry(self):
  c={'symbol':'TEST','trigger':103.01,'stop':101,'target':107}
  self.assertEqual(live_filter([c],{'TEST':[bar('12:00',c=104)]},at(S,'12:01'))[1][0]['live_status'],'ALREADY_ABOVE_TRIGGER_ON_IEX')
  self.assertEqual(live_filter([c],{'TEST':[bar('11:55',c=103)]},at(S,'12:01'))[1][0]['live_status'],'IEX_FRESHNESS_UNVERIFIED')
  self.assertEqual(len(live_filter([c],{'TEST':[bar('12:00',c=103)]},at(S,'12:01'))[0]),1)
if __name__=='__main__':unittest.main()
