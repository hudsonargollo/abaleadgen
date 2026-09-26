-- 0029 — 30-day pilot payout tracking on top of 0028's ledger.
--
--  * lead_payouts.due_at      — when the payout is contractually due
--                                (earned_at + crm_settings.payout_net_days, default 7).
--                                The Payouts view's "due within 7 days" / "overdue"
--                                buckets read this column, never recompute it.
--  * lead_payouts.deposit_date — for closed_won: the date the client's deposit
--                                landed (the $150 clock starts here, not at the
--                                moment someone flipped the toggle).
--  * leads.deposit_date / deposit_amount_cents / no_show / show_confirmed_*
--                              — the milestone toggles' own record, denormalized
--                                for board filters.
--  * webhook_events           — every inbound booking webhook, keyed by
--                                (provider, external_id) so a redelivery is a
--                                no-op and the full payload is auditable.

ALTER TABLE lead_payouts ADD COLUMN due_at       TEXT;
ALTER TABLE lead_payouts ADD COLUMN deposit_date TEXT;

ALTER TABLE leads ADD COLUMN deposit_date          TEXT;
ALTER TABLE leads ADD COLUMN deposit_amount_cents  INTEGER;
ALTER TABLE leads ADD COLUMN no_show               INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN show_confirmed_at     TEXT;
ALTER TABLE leads ADD COLUMN show_confirmed_by     TEXT;
ALTER TABLE leads ADD COLUMN booking_provider      TEXT;   -- 'cal.com' | 'calendly' | 'generic' | 'manual'
ALTER TABLE leads ADD COLUMN booking_external_id   TEXT;   -- provider's booking uid/uri, for cancel/reschedule matching

-- 0028's UNIQUE(lead_id, trigger) made re-entry idempotent, but it also
-- blocked re-earning after a void (deposit bounced → fixed → closed again).
-- Idempotency only needs to hold among live rows.
DROP INDEX IF EXISTS uq_lead_payouts_trigger;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_payouts_live ON lead_payouts(lead_id, trigger) WHERE status <> 'voided';

CREATE INDEX IF NOT EXISTS idx_lead_payouts_due ON lead_payouts(due_at) WHERE status IN ('earned','invoiced');

CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,                -- 'cal.com' | 'calendly' | 'generic'
  event_type   TEXT NOT NULL,                -- provider's event name
  external_id  TEXT,                         -- provider booking id + event, for dedup
  lead_id      TEXT,
  result       TEXT NOT NULL,                -- 'processed' | 'rescheduled' | 'cancelled' | 'unmatched' | 'ignored' | 'duplicate' | 'error'
  detail       TEXT,
  payload      TEXT,                         -- raw JSON as received (audit)
  received_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_events_ext ON webhook_events(provider, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_events_lead ON webhook_events(lead_id);

INSERT OR IGNORE INTO crm_settings (key, value) VALUES ('payout_net_days', '7');

UPDATE lead_payouts SET due_at = datetime(earned_at, '+7 days') WHERE due_at IS NULL;
