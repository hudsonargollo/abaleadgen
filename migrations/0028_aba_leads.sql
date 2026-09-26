-- 0028 — ABA lead-gen pilot: re-purposes the CRM `leads` entity (0009/0012)
-- for an outbound B2B pipeline targeting independent ABA therapy clinics.
--
-- Design decisions:
--  * Extend `leads` in place rather than adding a parallel `aba_leads` table.
--    Every consumer (crmDb.js, crm-entry.js, CrmLeads.jsx, dashboard,
--    lead_events audit trail, deleteLead cascade) keys on `leads.id`; a new
--    table would mean duplicating all of it. The Gold Traffic-specific
--    columns (segmento, utm_*, qualification/score/tier) stay — SQLite can't
--    drop columns cheaply and they're harmless when NULL.
--  * `leads.status` is KEPT as the stage column (renaming would touch every
--    query). Vocabulary changes — see STAGE_ORDER in src/crm/abaLead.types.ts.
--    SQLite has no enum; the app-level VALID_STATUSES list in crm-entry.js is
--    the real guard, exactly as today.
--  * Payout status is denormalized onto the lead row (fast board filters)
--    AND journaled in `lead_payouts` (one immutable row per trigger, the
--    audit/invoice source of truth). The existing `sales`/`commissions`
--    tables (BRL, 10% house rate) are NOT used by the pilot.
--  * Money is INTEGER cents, USD. Never REAL.

-- ── Company (the clinic) ─────────────────────────────────────────────────
ALTER TABLE leads ADD COLUMN company_name       TEXT;   -- supersedes `company` for ABA rows
ALTER TABLE leads ADD COLUMN website            TEXT;
ALTER TABLE leads ADD COLUMN website_domain     TEXT;   -- normalized (lowercase, no scheme/www/path) — dedup key
ALTER TABLE leads ADD COLUMN city               TEXT;
ALTER TABLE leads ADD COLUMN state              TEXT;   -- USPS 2-letter, uppercase
ALTER TABLE leads ADD COLUMN locations_count    INTEGER;
ALTER TABLE leads ADD COLUMN est_arr_bucket     TEXT;   -- 'under_500k' | '500k_1m' | '1m_2m' | 'over_2m' | NULL (ICP: < $2M)

-- ── Decision maker ───────────────────────────────────────────────────────
ALTER TABLE leads ADD COLUMN decision_maker_name      TEXT;
ALTER TABLE leads ADD COLUMN decision_maker_title     TEXT;   -- free text as found ("Founder & BCBA")
ALTER TABLE leads ADD COLUMN decision_maker_role      TEXT;   -- normalized: 'founder' | 'owner' | 'ceo' | 'exec_director' | 'other'
ALTER TABLE leads ADD COLUMN verified_email           TEXT;
ALTER TABLE leads ADD COLUMN email_verification_status TEXT NOT NULL DEFAULT 'unverified'; -- 'unverified' | 'valid' | 'risky' | 'invalid'
ALTER TABLE leads ADD COLUMN email_verified_at        TEXT;
ALTER TABLE leads ADD COLUMN linkedin_url             TEXT;

-- ── Sourcing / pilot batch control ───────────────────────────────────────
ALTER TABLE leads ADD COLUMN source_platform    TEXT;   -- 'aba_index' | 'google_maps' | 'linkedin_sales_nav' | 'apollo' | 'state_directory' | 'manual' | 'other'
ALTER TABLE leads ADD COLUMN source_url         TEXT;   -- the exact listing/profile URL the row was pulled from
ALTER TABLE leads ADD COLUMN batch_id           TEXT;   -- pilot batch grouping ("pilot-01"); NULL = not yet batched
ALTER TABLE leads ADD COLUMN approved_for_outreach INTEGER NOT NULL DEFAULT 0; -- client sign-off gate before `queued`
ALTER TABLE leads ADD COLUMN approved_at        TEXT;
ALTER TABLE leads ADD COLUMN approved_by        TEXT;
ALTER TABLE leads ADD COLUMN icp_fit            TEXT;   -- 'fit' | 'unfit' | 'unknown' — manual/LLM ICP screen
ALTER TABLE leads ADD COLUMN exclusion_reason   TEXT;   -- 'solo_practitioner' | 'non_owner' | 'pe_backed' | 'school' | 'staffing' | 'non_aba' | 'other'

-- ── Pipeline timing ──────────────────────────────────────────────────────
-- `status` (0009) is the stage. New vocabulary:
--   sourced | queued | contacted | replied | form_completed | call_scheduled
--   | qualified_show | closed_won | lost
ALTER TABLE leads ADD COLUMN stage_entered_at   TEXT;   -- reset on every stage change → lane aging
ALTER TABLE leads ADD COLUMN first_contacted_at TEXT;
ALTER TABLE leads ADD COLUMN replied_at         TEXT;
ALTER TABLE leads ADD COLUMN call_scheduled_for TEXT;   -- ISO datetime of the booked discovery call
ALTER TABLE leads ADD COLUMN call_held_at       TEXT;   -- set when qualified_show is confirmed
ALTER TABLE leads ADD COLUMN closed_at          TEXT;
ALTER TABLE leads ADD COLUMN sequence_step      INTEGER NOT NULL DEFAULT 0; -- last outreach touch sent (0 = none)
ALTER TABLE leads ADD COLUMN next_touch_at      TEXT;

-- ── Payout tracking (denormalized; ledger below is the audit) ────────────
ALTER TABLE leads ADD COLUMN show_payout_status  TEXT NOT NULL DEFAULT 'not_earned'; -- 'not_earned' | 'earned' | 'invoiced' | 'paid' | 'disputed' | 'voided'
ALTER TABLE leads ADD COLUMN close_payout_status TEXT NOT NULL DEFAULT 'not_earned';
ALTER TABLE leads ADD COLUMN payout_date         TEXT;   -- date the most recent payout for this lead was PAID

-- ── Indexes ──────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_website_domain ON leads(website_domain) WHERE website_domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_verified_email ON leads(verified_email) WHERE verified_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_state           ON leads(state);
CREATE INDEX IF NOT EXISTS idx_leads_source_platform ON leads(source_platform);
CREATE INDEX IF NOT EXISTS idx_leads_batch           ON leads(batch_id);
CREATE INDEX IF NOT EXISTS idx_leads_next_touch      ON leads(next_touch_at) WHERE next_touch_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_show_payout     ON leads(show_payout_status);
CREATE INDEX IF NOT EXISTS idx_leads_close_payout    ON leads(close_payout_status);

-- ── Payout ledger (append-only; one row per trigger event) ───────────────
-- Written exactly once per (lead_id, trigger) by the status-transition route
-- when a lead ENTERS qualified_show ($50) or closed_won ($150). The UNIQUE
-- index is what makes a re-drag / retry idempotent — the INSERT fails, the
-- transition still succeeds.
CREATE TABLE IF NOT EXISTS lead_payouts (
  id            TEXT PRIMARY KEY,
  lead_id       TEXT NOT NULL,
  trigger       TEXT NOT NULL,                 -- 'qualified_show' | 'closed_won'
  amount_cents  INTEGER NOT NULL,              -- 5000 | 15000
  currency      TEXT NOT NULL DEFAULT 'USD',
  status        TEXT NOT NULL DEFAULT 'earned',-- 'earned' | 'invoiced' | 'paid' | 'disputed' | 'voided'
  earned_at     TEXT NOT NULL DEFAULT (datetime('now')),
  invoice_ref   TEXT,
  invoiced_at   TEXT,
  paid_at       TEXT,
  paid_ref      TEXT,                          -- Stripe/PayPal/wire reference
  voided_reason TEXT,
  actor_email   TEXT,                          -- who moved the lead into the trigger stage
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_payouts_trigger ON lead_payouts(lead_id, trigger);
CREATE INDEX IF NOT EXISTS idx_lead_payouts_status ON lead_payouts(status);

-- ── Outreach touch log (optional but cheap; needed for reply-rate reporting)
CREATE TABLE IF NOT EXISTS outreach_touches (
  id            TEXT PRIMARY KEY,
  lead_id       TEXT NOT NULL,
  channel       TEXT NOT NULL,                 -- 'email' | 'linkedin' | 'phone'
  step          INTEGER NOT NULL,              -- sequence step number
  direction     TEXT NOT NULL DEFAULT 'outbound', -- 'outbound' | 'inbound'
  sending_domain TEXT,                         -- which pre-approved domain sent it
  provider_msg_id TEXT,                        -- Instantly/Smartlead/etc. id for webhook reconciliation
  subject       TEXT,
  body_preview  TEXT,
  sent_at       TEXT NOT NULL DEFAULT (datetime('now')),
  opened_at     TEXT,
  bounced_at    TEXT,
  replied_at    TEXT,
  reply_sentiment TEXT                         -- 'positive' | 'neutral' | 'negative' | 'ooo' | 'unsubscribe'
);
CREATE INDEX IF NOT EXISTS idx_outreach_lead ON outreach_touches(lead_id, step);
CREATE INDEX IF NOT EXISTS idx_outreach_provider ON outreach_touches(provider_msg_id);

-- ── Pilot settings (reuses crm_settings k/v from 0020) ───────────────────
INSERT OR IGNORE INTO crm_settings (key, value) VALUES
  ('payout_show_cents',  '5000'),
  ('payout_close_cents', '15000'),
  ('payout_currency',    'USD'),
  ('pilot_started_at',   NULL),
  ('priority_states',    '["TX","FL","CA","NC","CO","VA","MD","IL","UT","GA","NJ"]');

-- ── Data migration for any legacy Gold Traffic rows (no-op on a fresh DB) ─
UPDATE leads SET status = 'sourced'   WHERE status IN ('new', 'incomplete');
UPDATE leads SET status = 'contacted' WHERE status = 'contacted';
UPDATE leads SET status = 'call_scheduled' WHERE status = 'qualified';
UPDATE leads SET status = 'closed_won', closed_at = updated_at WHERE status = 'won';
UPDATE leads SET stage_entered_at = COALESCE(stage_entered_at, updated_at);
UPDATE leads SET company_name = company WHERE company_name IS NULL AND company IS NOT NULL;
