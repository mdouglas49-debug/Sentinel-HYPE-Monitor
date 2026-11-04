import { handleApprovalCallback } from '../lib/paper-approval.js';

export default async function(query) {
  return handleApprovalCallback(query);
}
