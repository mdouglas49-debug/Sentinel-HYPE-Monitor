import assert from 'node:assert/strict';
import worker, { dispatchScan } from './worker.mjs';
const env = { SCHEDULER_ENABLED: 'true', GITHUB_DISPATCH_TOKEN: 'github_pat_' + 'x'.repeat(40) };
const when = Date.parse('2026-10-24T12:01:00Z');
let posts = 0;
const mock = async (url, options) => {
  assert(url.startsWith('https://api.github.com/repos/mdouglas49-debug/Sentinel-HYPE-Monitor/'));
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_DISPATCH_TOKEN}`);
  if (options.method === 'POST') { posts++; assert.deepEqual(JSON.parse(options.body), { ref: 'main' }); return new Response(null, { status: 204 }); }
  return Response.json({ workflow_runs: [] });
};
assert.equal((await dispatchScan({}, when, () => assert.fail('disabled timer must not call GitHub'))).status, 'disabled');
await assert.rejects(() => dispatchScan({ SCHEDULER_ENABLED: 'true' }, when, mock), /dedicated/);
assert.equal((await dispatchScan(env, when, mock)).status, 'dispatch_accepted');
assert.equal(posts, 1);
assert.equal((await dispatchScan(env, when, async () => Response.json({ workflow_runs: [{ head_branch: 'main', created_at: '2026-10-24T12:00:15Z' }] }))).status, 'already_requested');
await assert.rejects(() => dispatchScan(env, when, async () => new Response(null, { status: 403 })), /run check failed/);
let attempts = 0;
await assert.rejects(() => dispatchScan(env, when, async (url, options) => {
  if (options.method === 'POST') { attempts++; throw Error('network failure'); }
  return Response.json({ workflow_runs: [] });
}), /network failure/);
assert.equal(attempts, 1);
assert(!(await worker.fetch().text()).includes(env.GITHUB_DISPATCH_TOKEN));
console.log('Cloud timer tests passed: disabled gate, token requirement, fixed target, dispatch acceptance, duplicate suppression, failure reporting, no uncertain POST retries, and no public trigger.');
