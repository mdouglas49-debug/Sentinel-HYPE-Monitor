const API = 'https://api.github.com/repos/mdouglas49-debug/Sentinel-HYPE-Monitor/actions/workflows/hype-scan.yml';

export async function dispatchScan(env, scheduledTime, fetcher = fetch) {
  if (env.SCHEDULER_ENABLED !== 'true') return { status: 'disabled' };
  if (!/^github_pat_[A-Za-z0-9_]{20,240}$/.test(env.GITHUB_DISPATCH_TOKEN || '')) {
    throw new Error('Configure the dedicated GitHub Actions dispatch token.');
  }
  const headers = {
    Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Sentinel-HYPE-Cloud-Timer',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const slot = Math.floor(scheduledTime / 300000) * 300000;
  const runs = await fetcher(`${API}/runs?event=workflow_dispatch&per_page=5`, {
    headers, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!runs.ok) throw new Error(`GitHub run check failed: HTTP ${runs.status}`);
  const listing = await runs.json();
  if (!Array.isArray(listing.workflow_runs)) throw new Error('Unexpected GitHub run response.');
  if (listing.workflow_runs.some(r => r.head_branch === 'main' && Date.parse(r.created_at) >= slot)) {
    return { status: 'already_requested', slot: new Date(slot).toISOString() };
  }
  // Do not retry a POST with an uncertain result: it may already have started a run.
  const response = await fetcher(`${API}/dispatches`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main' }), redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (response.status !== 204) throw new Error(`GitHub dispatch failed: HTTP ${response.status}`);
  return { status: 'dispatch_accepted', slot: new Date(slot).toISOString() };
}

export default {
  async scheduled(controller, env) {
    const result = await dispatchScan(env, controller.scheduledTime);
    console.log(JSON.stringify(result));
  },
  fetch() {
    return new Response('Sentinel HYPE cloud timer. Scans are started by the scheduled trigger only.', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};
