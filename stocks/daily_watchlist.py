"""Daily paper watchlist runner. No order or post-open execution is enabled."""
import argparse
from datetime import datetime,timedelta
import json
import os
from pathlib import Path
import time
from urllib.parse import urlencode
from scanner import Alpaca,ET,UTC,Journal,at,canonical,dashboard,digest,event,iso,request,scan,telegram,universe

ROOT=Path('stocks-state')
REPO='mdouglas49-debug/Sentinel-HYPE-Monitor'

def now_utc():return datetime.now(UTC)
def wait_until(target):
    while now_utc()<target:
        time.sleep(min(20,max(0,(target-now_utc()).total_seconds())))
    return now_utc()
def preview_enabled():
    value=os.environ.get('SENTINEL_PREVIEW','false').lower()
    if value not in ('true','false'):raise RuntimeError('Invalid preview setting')
    return value=='true'
def gate(now,preview=False):
    local=now.astimezone(ET)
    result={'schema':1,'mode':'PAPER_ONLY','session':str(local.date()),'dry_run':preview,'status':'READY_TO_PREPARE','should_run':True}
    if preview:return result
    if local.weekday()>4:result.update(status='SKIPPED_WEEKEND',should_run=False)
    elif local.hour!=9:result.update(status='SKIPPED_INACTIVE_UTC_SLOT',should_run=False)
    elif now>=at(local.date(),'09:30'):result.update(status='MISSED_PREMARKET_WINDOW',should_run=False)
    return result

def prior_claim(session):
    token=os.environ.get('GITHUB_TOKEN')
    if not token:raise RuntimeError('GitHub Actions read token required to verify prior delivery claims')
    name='sentinel-stocks-watchlist-claim-'+session
    for page in range(1,21):
        query=urlencode({'name':name,'per_page':100,'page':page})
        raw,_=request('https://api.github.com/repos/'+REPO+'/actions/artifacts?'+query,
                      {'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json'})
        data=json.loads(raw);items=data.get('artifacts')
        if not isinstance(items,list):raise RuntimeError('Could not verify prior watchlist delivery claims')
        if any(a.get('name')==name and not a.get('expired') for a in items):return True
        if len(items)<100:return False
    raise RuntimeError('Delivery claim history could not be checked completely')

def prepare(api,now,preview=False,claimed=prior_claim,load_universe=universe,scan_fn=scan,wait=wait_until):
    report=gate(now,preview)
    if not report['should_run']:return report,None
    session=report['session']
    if not preview and claimed(session):
        report.update(status='SKIPPED_ALREADY_CLAIMED',prepared=False);return report,None
    sessions=api.calendar(session,session)
    if not any(s.get('date')==session for s in sessions):
        report.update(status='SKIPPED_MARKET_HOLIDAY',prepared=False);return report,None
    if not preview:
        now=wait(at(session,'09:14')+timedelta(seconds=20))
        if now>=at(session,'09:30'):raise RuntimeError('Premarket delivery window was missed before scanning')
    before=api.calls;started=time.monotonic()
    symbols,membership=load_universe()
    e=scan_fn(api,symbols,membership,session,ROOT/'cache',now=now)
    coverage=e['coverage'];fresh=coverage['with_premarket_bars']-sum(v=='stale_premarket' for v in coverage['excluded'].values())
    if coverage['with_premarket_bars']==0 or fresh==0:raise RuntimeError('No fresh premarket data; a watchlist will not be fabricated')
    report.update(status='PREVIEW_VERIFIED' if preview else 'PREPARED',prepared=not preview,
                  id=e['id'],data_cutoff=e['cutoff'],feed=e['feed'],requested=coverage['requested'],
                  observed=coverage['with_premarket_bars'],fresh=fresh,eligible=coverage['eligible'],
                  shortlisted=len(e['candidates']),scan_seconds=round(time.monotonic()-started,3),
                  api_requests=api.calls-before,target_at=iso(at(session,'09:15')),
                  dashboard={'status':'NOT_ATTEMPTED'},telegram={'status':'NOT_ATTEMPTED'})
    return report,e

def validate_watchlist(e,now):
    if e.get('mode')!='PAPER_ONLY' or e.get('kind')!='watchlist' or e.get('test') is not False or e.get('session')!=str(now.astimezone(ET).date()):raise RuntimeError('Requires today\'s actual paper watchlist')
    if len(e.get('candidates',[]))>5:raise RuntimeError('Shortlist exceeds pilot size')
    if now>=at(e['session'],'09:30'):raise RuntimeError('Premarket delivery window was missed; no stale brief sent')

def delivery_journal(expected):
    if os.environ.get('SENTINEL_DURABLE_STATE') == 'true':
        from runtime import open_context
        w,journal,_=open_context(ROOT/'daily-journal.sqlite')
        if w!=expected:
            journal.db.close();raise RuntimeError('Delivery does not match the durable watchlist')
        return journal
    return Journal(str(ROOT/'daily-journal.sqlite'))

def send_telegram(e,report,sender=telegram,clock=now_utc,wait=wait_until):
    current=clock();validate_watchlist(e,current)
    current=wait(at(e['session'],'09:15'));validate_watchlist(e,current)
    journal=delivery_journal(e)
    status,receipt=journal.deliver(e,'telegram',sender);journal.db.close()
    if status!='CONFIRMED':raise RuntimeError('Telegram attempt is UNKNOWN; automatic resend is disabled')
    receipt=json.loads(receipt) if isinstance(receipt,str) else receipt
    if receipt.get('payload_sha256')!=digest(e):raise RuntimeError('Telegram receipt mismatch')
    report.update(status='TELEGRAM_DELIVERED',sent_at=iso(current),late_seconds=max(0,round((current-at(e['session'],'09:15')).total_seconds())))
    report['telegram']={'status':'CONFIRMED','message_id':receipt['message_id'],'payload_sha256':receipt['payload_sha256']}
    return report

def send_dashboard(e,report):
    if not os.environ.get('SENTINEL_SITES_TOKEN'):
        report['dashboard']={'status':'PENDING_CREDENTIAL','reason':'GitHub Actions secret SENTINEL_SITES_TOKEN is missing'};return report
    journal=delivery_journal(e)
    status,receipt=journal.deliver(e,'dashboard',dashboard);journal.db.close()
    if status!='CONFIRMED':raise RuntimeError('Dashboard attempt is UNKNOWN; reconcile before retrying')
    receipt=json.loads(receipt) if isinstance(receipt,str) else receipt
    report['dashboard']={'status':'CONFIRMED','id':receipt['id'],'payload_sha256':receipt['payload_sha256']}
    if report.get('telegram',{}).get('status')=='CONFIRMED':report['status']='BOTH_CHANNELS_DELIVERED'
    return report

def write_report(report):
    ROOT.mkdir(parents=True,exist_ok=True);(ROOT/'daily-watchlist-report.json').write_text(canonical(report)+'\n',encoding='utf-8')
    print(canonical(report))
def read_report():
    p=ROOT/'daily-watchlist-report.json'
    return json.loads(p.read_text()) if p.exists() else {'mode':'PAPER_ONLY','status':'NOT_STARTED'}
def output(**values):
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'],'a',encoding='utf-8') as out:
            for key,value in values.items():out.write(key+'='+str(value).lower()+'\n')

def main():
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['gate','prepare','telegram','dashboard','summary']);args=p.parse_args()
    report=read_report();failed=False
    try:
        preview=preview_enabled()
        if args.phase=='gate':
            report=gate(now_utc(),preview);output(should_run=report['should_run'],session=report['session'])
            failed=report['status']=='MISSED_PREMARKET_WINDOW'
        elif args.phase=='prepare':
            report,e=prepare(Alpaca(),now_utc(),preview)
            if e is not None:
                ROOT.mkdir(parents=True,exist_ok=True);(ROOT/'daily-watchlist.json').write_text(canonical(e)+'\n',encoding='utf-8')
            output(prepared=report.get('prepared',False),session=report['session'])
            if report.get('prepared'):
                (ROOT/'daily-watchlist-claim.json').write_text(canonical({'schema':1,'mode':'PAPER_ONLY','session':report['session'],'id':report['id'],'state':'ATTEMPT_RESERVED'})+'\n',encoding='utf-8')
        elif args.phase in ('telegram','dashboard'):
            if preview:raise RuntimeError('Preview mode cannot send messages or write the dashboard')
            e=json.loads((ROOT/'daily-watchlist.json').read_text())
            if args.phase=='telegram':report=send_telegram(e,report)
            else:report=send_dashboard(e,report)
        elif args.phase=='summary':
            if report.get('status')=='PREPARED':report.update(status='STOPPED_BEFORE_DELIVERY',reason='No confirmed Telegram delivery; inspect the claim and sender steps')
            if os.environ.get('GITHUB_STEP_SUMMARY'):
                rows=['# Sentinel daily paper watchlist','',report.get('status','UNKNOWN'),'']
                for key in ('session','data_cutoff','requested','observed','fresh','eligible','shortlisted','scan_seconds','sent_at','late_seconds'): 
                    if key in report:rows.append('- '+key+': '+str(report[key]))
                rows.extend(['','Telegram: '+report.get('telegram',{}).get('status','Not attempted'),'Dashboard: '+report.get('dashboard',{}).get('status','Not attempted'),'','No picks, prices, chat IDs or credentials are exported in this report.',''])
                with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as out:out.write('\n'.join(rows))
    except RuntimeError as error:
        report.update(status='BLOCKED' if args.phase in ('gate','prepare') else 'UNKNOWN',reason=str(error));failed=True
        if args.phase=='prepare':output(prepared=False)
        if args.phase in ('telegram','dashboard'):report[args.phase]={'status':'UNKNOWN','reason':str(error)}
    except Exception:
        report.update(status='BLOCKED',reason='Watchlist operation could not be verified; no provider credentials or response text is logged');failed=True
        if args.phase=='prepare':output(prepared=False)
        if args.phase in ('telegram','dashboard'):report[args.phase]={'status':'UNKNOWN'}
    write_report(report)
    return 1 if failed else 0

if __name__=='__main__':raise SystemExit(main())
