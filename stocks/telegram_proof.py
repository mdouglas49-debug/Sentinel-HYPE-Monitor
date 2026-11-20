"""One synthetic Telegram delivery proof, with a claim saved before sending."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
from scanner import ET, Journal, canonical, digest, event, request, telegram

ROOT=Path('stocks-state')
FIXTURE=ROOT/'paper-delivery-fixture.json'
CLAIM=ROOT/'telegram-delivery-claim.json'
REPORT=ROOT/'telegram-delivery-proof.json'


def fixture(run_id,session):
    if not re.fullmatch(r'[0-9]{1,30}',str(run_id)):raise RuntimeError('Invalid GitHub run identity')
    return event('delivery_test',session,{'test_id':'github-telegram-'+str(run_id),'cutoff':None,'feed':'NONE','candidates':[],
                 'reason':'Synthetic paper-only delivery proof; no market candidates or trade outcomes'},True)


def prepare(run_id):
    token,chat=os.environ.get('TELEGRAM_BOT_TOKEN'),os.environ.get('TELEGRAM_CHAT_ID')
    if not token or not chat:raise RuntimeError('Missing GitHub Actions Telegram secrets')
    # Validate the bot and configured destination before reserving a send.
    raw,_=request('https://api.telegram.org/bot'+token+'/getMe')
    if not json.loads(raw).get('ok'):raise RuntimeError('Telegram bot identity was not verified')
    raw,_=request('https://api.telegram.org/bot'+token+'/getChat',{'Content-Type':'application/json'},{'chat_id':chat})
    target=json.loads(raw)
    if not target.get('ok') or str(target.get('result',{}).get('id'))!=str(chat):raise RuntimeError('Telegram destination was not verified')
    e=fixture(run_id,str(datetime.now(ET).date()))
    ROOT.mkdir(parents=True,exist_ok=True)
    FIXTURE.write_text(canonical(e)+'\n',encoding='utf-8')
    CLAIM.write_text(canonical({'id':e['id'],'run_id':str(run_id),'state':'ATTEMPT_RESERVED'})+'\n',encoding='utf-8')
    return {'mode':'PAPER_ONLY','test':True,'id':e['id'],'status':'PREPARED'}


def deliver(e,run_id,path,sender=telegram):
    if e!=fixture(run_id,e.get('session','')):raise RuntimeError('Only the exact synthetic paper fixture may be sent')
    calls=[]
    def send(value):calls.append(value['id']);return sender(value)
    journal=Journal(str(path));state,receipt=journal.deliver(e,'telegram',send)
    if state!='CONFIRMED':raise RuntimeError('Previous Telegram attempt is UNKNOWN; automatic resend is disabled')
    receipt=json.loads(receipt) if isinstance(receipt,str) else receipt
    if receipt.get('payload_sha256')!=digest(e):raise RuntimeError('Telegram receipt payload mismatch')
    journal.db.close()
    restart=Journal(str(path));again,receipt2=restart.deliver(e,'telegram',send);restart.db.close()
    receipt2=json.loads(receipt2) if isinstance(receipt2,str) else receipt2
    if again!='CONFIRMED' or receipt2!=receipt or len(calls)!=1:raise RuntimeError('Telegram restart deduplication failed')
    return {'mode':'PAPER_ONLY','test':True,'id':e['id'],'status':'DELIVERED',
            'message_id':receipt['message_id'],'telegram_timestamp':receipt['date'],
            'payload_sha256':receipt['payload_sha256'],'restart_duplicate_suppressed':True}


def main():
    p=argparse.ArgumentParser();p.add_argument('phase',choices=['prepare','send']);args=p.parse_args()
    try:
        run_id=os.environ.get('GITHUB_RUN_ID','')
        if args.phase=='prepare':report=prepare(run_id)
        else:report=deliver(json.loads(FIXTURE.read_text()),run_id,ROOT/'telegram-proof.sqlite')
    except (RuntimeError,ValueError) as error:
        report={'mode':'PAPER_ONLY','test':True,'status':'BLOCKED' if args.phase=='prepare' else 'UNKNOWN',
                'reason':str(error) if isinstance(error,RuntimeError) else 'Invalid Telegram response or fixture'}
    ROOT.mkdir(parents=True,exist_ok=True);REPORT.write_text(canonical(report)+'\n',encoding='utf-8');print(canonical(report))
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as out:
            out.write('# Sentinel synthetic paper delivery\n\n'+report['status']+'\n\nNo market candidates or orders.\n')
    return 0 if report['status'] in ('PREPARED','DELIVERED') else 1
if __name__=='__main__':raise SystemExit(main())
