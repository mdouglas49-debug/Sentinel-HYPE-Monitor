"""Cold/warm full-universe measurements. Does not publish watchlists or alerts."""
import argparse
from collections import Counter
from datetime import datetime
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import time
from scanner import Alpaca, ET, UTC, canonical, iso, scan, universe


def measure(api, session, load_universe=universe, scan_fn=scan, now=None):
    now = now or datetime.now(UTC)
    report = {'schema':1,'mode':'PAPER_ONLY','check':'FULL_UNIVERSE_BENCHMARK',
              'session':session,'checked_at':iso(now),'status':'BLOCKED','runs':{},
              'scope':'Retrospective timing and data coverage only; no watchlist, alert, order or outcome is published'}
    started=time.monotonic()
    try:
        symbols,membership=load_universe()
        report['universe_seconds']=round(time.monotonic()-started,3)
        report['membership']=membership
        # Each invocation gets a genuinely empty history cache; warm reuses only
        # that invocation's completed cold pull and identical constituent set.
        with TemporaryDirectory(prefix='sentinel-benchmark-') as cache:
            for label in ('cold','warm'):
                before=api.calls; clock=time.monotonic()
                e=scan_fn(api,symbols,membership,session,cache,now=now)
                coverage=e['coverage']
                report['runs'][label]={
                    'seconds':round(time.monotonic()-clock,3),'api_requests':api.calls-before,
                    'data_cutoff':e['cutoff'],'requested':coverage['requested'],
                    'with_premarket_bars':coverage['with_premarket_bars'],
                    'eligible':coverage['eligible'],'shortlisted':len(e['candidates']),
                    'history_sessions':coverage['history_sessions'],
                    'exclusion_counts':dict(Counter(coverage['excluded'].values())),
                    'latest_bar_min':e.get('latest_bar_min'),'latest_bar_max':e.get('latest_bar_max')}
        report['status']='TIMING_AND_COVERAGE_MEASURED'
    except RuntimeError as error:
        report['reason']=str(error)
    report['total_seconds']=round(time.monotonic()-started,3)
    return report


def main():
    p=argparse.ArgumentParser();p.add_argument('--session',default=str(datetime.now(ET).date()))
    p.add_argument('--output',default='stocks-state/full-market-benchmark.json');args=p.parse_args()
    try:
        report=measure(Alpaca(),args.session)
    except RuntimeError:
        report={'schema':1,'mode':'PAPER_ONLY','check':'FULL_UNIVERSE_BENCHMARK','status':'BLOCKED','reason':'Alpaca client configuration is unavailable'}
    path=Path(args.output);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(canonical(report)+'\n',encoding='utf-8')
    print(canonical(report))
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        rows=['# Sentinel Full Market — cold/warm benchmark','', '**'+report['status']+'**','',
              '| Run | Seconds | HTTP attempts | Premarket coverage | Eligible |','|---|---:|---:|---:|---:|']
        for name,r in report.get('runs',{}).items():rows.append(f"| {name} | {r['seconds']} | {r['api_requests']} | {r['with_premarket_bars']} / {r['requested']} | {r['eligible']} |")
        if report.get('reason'):rows.extend(['',report['reason']])
        rows.extend(['',report.get('scope',''),'','Constituent sources are community lists; official current membership remains unverified.',''])
        with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as output:output.write('\n'.join(rows))
    return 0 if report['status']=='TIMING_AND_COVERAGE_MEASURED' else 1

if __name__=='__main__':raise SystemExit(main())
