"""Wake the paper watchlist from the existing HYPE heartbeat; never send trades."""
import argparse
from datetime import datetime, timezone
import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

REPO = 'mdouglas49-debug/Sentinel-HYPE-Monitor'
API = 'https://api.github.com/repos/' + REPO + '/actions/'
ET = ZoneInfo('America/New_York')


def in_window(now):
    local = now.astimezone(ET)
    return local.weekday() < 5 and local.hour == 9 and 10 <= local.minute < 25


def github(path, token, payload=None):
    headers = {'Authorization': 'Bearer ' + token,
               'Accept': 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28',
               'User-Agent': 'Sentinel-paper-watchlist-wakeup'}
    body = None if payload is None else json.dumps(payload).encode()
    if body is not None:
        headers['Content-Type'] = 'application/json'
    try:
        with urlopen(Request(API + path, data=body, headers=headers), timeout=20) as response:
            if payload is not None:
                if response.status != 204:
                    raise RuntimeError('Dispatch did not return HTTP 204')
                return None
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError('GitHub operation failed: HTTP ' + str(error.code)) from None
    except (URLError, TimeoutError, ValueError):
        raise RuntimeError('GitHub operation could not be verified; no automatic POST retry') from None


def wake(now, token, probe=False, api=github):
    if not probe and not in_window(now):
        return {'mode': 'PAPER_ONLY', 'status': 'OUTSIDE_WAKEUP_WINDOW'}
    if not token:
        raise RuntimeError('An Actions write token is required')
    if not probe:
        name = 'sentinel-stocks-watchlist-claim-' + str(now.astimezone(ET).date())
        query = urlencode({'name': name, 'per_page': 100})
        listing = api('artifacts?' + query, token)
        items = listing.get('artifacts')
        if not isinstance(items, list):
            raise RuntimeError('Daily delivery claim check was not verified')
        if any(item.get('name') == name and not item.get('expired') for item in items):
            return {'mode': 'PAPER_ONLY', 'status': 'ALREADY_CLAIMED'}
        # A full page is ambiguous: fail closed rather than skip unseen claims.
        if len(items) >= 100:
            raise RuntimeError('Daily claim results exceeded the verified page')
    api('workflows/stocks-watchlist.yml/dispatches', token,
        {'ref': 'main', 'inputs': {'dry_run': probe}})
    return {'mode': 'PAPER_ONLY', 'status': 'DISPATCH_ACCEPTED', 'dry_run': probe,
            'delivery_confirmed': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe', action='store_true',
                        help='Dispatch a preview only; never enable delivery')
    args = parser.parse_args()
    try:
        result = wake(datetime.now(timezone.utc), os.environ.get('GITHUB_TOKEN'), args.probe)
    except RuntimeError as error:
        print(json.dumps({'mode': 'PAPER_ONLY', 'status': 'BLOCKED', 'reason': str(error)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
