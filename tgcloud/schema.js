import { table, integer, text } from 'sdk/db';

// Paper-only proposals. Never store bot tokens or brokerage credentials here.
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
});
