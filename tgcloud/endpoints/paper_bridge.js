import { runBridge } from '../lib/paper-approval.js';

// Authenticated tgcloud management /run only. Published Mini App callers are denied
// inside runBridge, even if they place sentinelAutomation in their JSON input.
export default async function(input, ctx) {
  return runBridge(input,ctx);
}
