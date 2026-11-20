"""Read-only Alpaca authentication check for an unattended GitHub runner."""
import argparse
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from scanner import Alpaca, ET, UTC, canonical, iso, parse


def check(api=None, now=None):
    now = now or datetime.now(UTC)
    report = {'schema': 1, 'mode': 'PAPER_ONLY', 'check': 'ALPACA_ACCESS_PREFLIGHT',
              'checked_at': iso(now), 'status': 'BLOCKED', 'calendar': None, 'feeds': {}, 'blockers': []}
    if api is None:
        missing = [name for name, aliases in [
            ('APCA_API_KEY_ID', ('APCA_API_KEY_ID', 'ALPACA_API_KEY')),
            ('APCA_API_SECRET_KEY', ('APCA_API_SECRET_KEY', 'ALPACA_SECRET_KEY')),
        ] if not any(os.environ.get(k) for k in aliases)]
        if missing:
            report['blockers'] = ['Missing runner secrets: ' + ', '.join(missing)]
            return report
        try:
            api = Alpaca()
        except RuntimeError:
            report['blockers'] = ['Alpaca client could not initialize; verify SDK installation and secret bindings']
            return report
    today = now.astimezone(ET).date()
    try:
        sessions = api.calendar(today - timedelta(days=10), today)
        if not sessions:
            raise RuntimeError('Paper calendar returned no sessions')
        report['calendar'] = {'status': 'VERIFIED', 'host': 'paper-api.alpaca.markets',
                              'last_session': sessions[-1]['date'], 'sessions_returned': len(sessions)}
    except RuntimeError as error:
        report['calendar'] = {'status': 'BLOCKED', 'reason': str(error)}
        report['blockers'].append('Paper calendar access failed')
    for feed in ('sip', 'iex'):
        end = ((now - timedelta(minutes=16)) if feed == 'sip' else now).replace(second=0, microsecond=0)
        try:
            bars, pages = api.bars(['AAPL', 'MSFT'], end - timedelta(days=7), end, feed)
            latest = {symbol: values[-1]['t'] if values else None for symbol, values in bars.items()}
            complete = all(latest.get(s) and parse(latest[s]) + timedelta(minutes=1) <= end for s in ('AAPL', 'MSFT'))
            report['feeds'][feed] = {'status': 'VERIFIED' if complete else 'BLOCKED',
                'requested_cutoff': iso(end), 'latest_bar_at': latest, 'pages': pages,
                'bar_counts': {s: len(bars.get(s, [])) for s in ('AAPL', 'MSFT')}}
            if not complete:
                report['blockers'].append(feed.upper() + ': missing or incomplete sample bars')
        except RuntimeError as error:
            report['feeds'][feed] = {'status': 'BLOCKED', 'requested_cutoff': iso(end), 'reason': str(error)}
            report['blockers'].append(feed.upper() + ' market-data access failed')
    report['api_requests'] = api.calls
    if not report['blockers']:
        report['status'] = 'AUTHENTICATED_MARKET_DATA_ACCESS_VERIFIED'
    report['scope'] = 'Two-symbol access check; full-universe coverage, scan timing, live freshness, Telegram and dashboard delivery are separate checks'
    return report


def summary(report):
    rows = ['# Sentinel Full Market — Alpaca paper access', '', '**' + report['status'] + '**', '',
            'Read-only calendar and market-data requests. No orders are submitted.', '',
            '| Check | Result |', '|---|---|']
    rows.append('| Paper calendar | ' + (report.get('calendar') or {}).get('status', 'Not attempted') + ' |')
    for feed in ('sip', 'iex'):
        item = report['feeds'].get(feed, {})
        rows.append('| ' + feed.upper() + ' | ' + item.get('status', 'Not attempted') + ' |')
    if report['blockers']:
        rows.extend(['', '## Required configuration', ''])
        rows.extend('- ' + text for text in report['blockers'])
        rows.extend(['', 'Add the paper-account keys in [repository Actions secrets](https://github.com/mdouglas49-debug/Sentinel-HYPE-Monitor/settings/secrets/actions), then rerun this check. Keys belong in the secret fields, never the issue or log.'])
    rows.extend(['', report.get('scope', 'Authentication was not attempted because required secrets are missing.'), ''])
    return '\n'.join(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='stocks-state/alpaca-preflight.json')
    args = parser.parse_args()
    report = check()
    path = Path(args.output); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical(report) + '\n', encoding='utf-8')
    print(canonical(report))
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as out:
            out.write(summary(report))
    return 0 if report['status'] == 'AUTHENTICATED_MARKET_DATA_ACCESS_VERIFIED' else 1


if __name__ == '__main__':
    raise SystemExit(main())
