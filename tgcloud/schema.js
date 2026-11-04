import { table, integer, text } from 'sdk/db';

// Additive schema: keep existing proposal columns and decisions across deployment.
// No bot tokens or account credentials are stored here.
export const paperProposals = table('sentinel_paper_proposals', {
  id: integer('id').primaryKey({autoIncrement:true}),
  fingerprint: text('fingerprint').notNull().unique(),
  chatId: text('chat_id').notNull(),
  side: text('side').notNull(),
  entry: text('entry').notNull(),
  stop: text('stop').notNull(),
  target: text('target').notNull(),
  candleUtc: text('candle_utc').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  status: text('status').notNull(),
  decidedAt: integer('decided_at'),
  ownerId: text('owner_id'),
  signalId: text('signal_id'),
  messageId: integer('telegram_message_id'),
  sendClaimedAt: integer('send_claimed_at'),
  approvedOrder: text('approved_order_json'),
  deliveredAt: integer('delivered_at'),
});

export const paperBridgeConfig = table('sentinel_paper_bridge_config', {
  id: integer('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  chatId: text('chat_id').notNull(),
  enabled: integer('enabled').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
