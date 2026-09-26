/**
 * ABA lead-gen domain types — mirrors migrations/0028_aba_leads.sql 1:1.
 *
 * DB rows are snake_case (D1 returns column names verbatim); the API layer
 * returns rows as-is (see crmDb.js#listLeads → `SELECT l.*`), so the row
 * type IS the wire type. No camelCase mapping layer exists in this codebase
 * and none is introduced here.
 *
 * Importable from the Vite app (src/), the Hono worker (worker/) and the
 * Expo app (mobile/) — keep this file dependency-free.
 */

// ── Enumerations ───────────────────────────────────────────────────────────

export const PIPELINE_STAGES = [
  "sourced",
  "queued",
  "contacted",
  "replied",
  "form_completed",
  "call_scheduled",
  "qualified_show",
  "closed_won",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Terminal off-ramp reachable from any stage; not part of the funnel order. */
export const TERMINAL_STAGES = ["lost"] as const;
export type TerminalStage = (typeof TERMINAL_STAGES)[number];

export type LeadStatus = PipelineStage | TerminalStage;
export const VALID_STATUSES: readonly LeadStatus[] = [...PIPELINE_STAGES, ...TERMINAL_STAGES];

export const SOURCE_PLATFORMS = [
  "aba_index",
  "google_maps",
  "linkedin_sales_nav",
  "apollo",
  "state_directory",
  "manual",
  "other",
] as const;
export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

export const DECISION_MAKER_ROLES = ["founder", "owner", "ceo", "exec_director", "other"] as const;
export type DecisionMakerRole = (typeof DECISION_MAKER_ROLES)[number];

export type EmailVerificationStatus = "unverified" | "valid" | "risky" | "invalid";
export type IcpFit = "fit" | "unfit" | "unknown";
export type ExclusionReason =
  | "solo_practitioner"
  | "non_owner"
  | "pe_backed"
  | "school"
  | "staffing"
  | "non_aba"
  | "other";
export type ArrBucket = "under_500k" | "500k_1m" | "1m_2m" | "over_2m";

export type PayoutStatus = "not_earned" | "earned" | "invoiced" | "paid" | "disputed" | "voided";
export type PayoutTrigger = Extract<PipelineStage, "qualified_show" | "closed_won">;

export type LostReason = (typeof LOST_REASONS)[number];

/** ISO-8601 string as stored by D1 (`datetime('now')` → "YYYY-MM-DD HH:MM:SS"). */
export type IsoDateTime = string;
/** USPS two-letter state code, uppercase. */
export type UsState = string;

// ── Row types (exact DB shape) ─────────────────────────────────────────────

/** Legacy Gold Traffic columns from migrations 0009/0012 — kept for schema
 *  compatibility, always NULL on ABA rows. Present so `SELECT *` types check. */
export interface LegacyLeadColumns {
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  segmento: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  referrer: string | null;
  qualification: string | null; // JSON
  score: number | null;
  tier: "hot" | "warm" | "cold" | null;
  converted_project_id: string | null;
}

export interface AbaLeadRow extends LegacyLeadColumns {
  id: string;

  // Company
  company_name: string | null;
  website: string | null;
  website_domain: string | null;
  city: string | null;
  state: UsState | null;
  locations_count: number | null;
  est_arr_bucket: ArrBucket | null;

  // Decision maker
  decision_maker_name: string | null;
  decision_maker_title: string | null;
  decision_maker_role: DecisionMakerRole | null;
  verified_email: string | null;
  email_verification_status: EmailVerificationStatus;
  email_verified_at: IsoDateTime | null;
  linkedin_url: string | null;

  // Sourcing / batch control
  source_platform: SourcePlatform | null;
  source_url: string | null;
  batch_id: string | null;
  approved_for_outreach: 0 | 1;
  approved_at: IsoDateTime | null;
  approved_by: string | null;
  icp_fit: IcpFit | null;
  exclusion_reason: ExclusionReason | null;

  // Pipeline
  status: LeadStatus;
  stage_entered_at: IsoDateTime | null;
  first_contacted_at: IsoDateTime | null;
  replied_at: IsoDateTime | null;
  call_scheduled_for: IsoDateTime | null;
  call_held_at: IsoDateTime | null;
  closed_at: IsoDateTime | null;
  sequence_step: number;
  next_touch_at: IsoDateTime | null;
  assigned_closer_email: string | null;
  lost_reason: LostReason | string | null;
  notes: string | null;

  // Payout (denormalized)
  show_payout_status: PayoutStatus;
  close_payout_status: PayoutStatus;
  payout_date: IsoDateTime | null;

  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/** Shape returned by crmDb.js#listLeads (LEFT JOIN users for the closer name). */
export interface AbaLeadListRow extends AbaLeadRow {
  closer_name: string | null;
}

export interface LeadPayoutRow {
  id: string;
  lead_id: string;
  trigger: PayoutTrigger;
  amount_cents: number;
  currency: "USD";
  status: Exclude<PayoutStatus, "not_earned">;
  earned_at: IsoDateTime;
  invoice_ref: string | null;
  invoiced_at: IsoDateTime | null;
  paid_at: IsoDateTime | null;
  paid_ref: string | null;
  voided_reason: string | null;
  actor_email: string | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export type OutreachChannel = "email" | "linkedin" | "phone";
export type ReplySentiment = "positive" | "neutral" | "negative" | "ooo" | "unsubscribe";

export interface OutreachTouchRow {
  id: string;
  lead_id: string;
  channel: OutreachChannel;
  step: number;
  direction: "outbound" | "inbound";
  sending_domain: string | null;
  provider_msg_id: string | null;
  subject: string | null;
  body_preview: string | null;
  sent_at: IsoDateTime;
  opened_at: IsoDateTime | null;
  bounced_at: IsoDateTime | null;
  replied_at: IsoDateTime | null;
  reply_sentiment: ReplySentiment | null;
}

/** Existing append-only audit table (migration 0009). `type` values used by
 *  the ABA pipeline are enumerated here; `payload` is JSON. */
export type LeadEventType =
  | "created"
  | "updated"
  | "imported"
  | "approved_for_outreach"
  | "status_changed"
  | "touch_sent"
  | "reply_received"
  | "form_completed"
  | "call_booked"
  | "call_rescheduled"
  | "payout_earned"
  | "payout_status_changed"
  | "email_verified";

export interface LeadEventRow {
  id: string;
  lead_id: string;
  type: LeadEventType;
  payload: string | null;
  actor_email: string | null;
  created_at: IsoDateTime;
}

// ── API input DTOs (what the Hono routes accept) ───────────────────────────

/** POST /crm/api/leads and bulk import rows. Everything optional except a
 *  company identifier; the route normalizes website → website_domain. */
export interface CreateAbaLeadInput {
  company_name: string;
  website?: string | null;
  city?: string | null;
  state?: UsState | null;
  locations_count?: number | null;
  est_arr_bucket?: ArrBucket | null;
  decision_maker_name?: string | null;
  decision_maker_title?: string | null;
  decision_maker_role?: DecisionMakerRole | null;
  verified_email?: string | null;
  email_verification_status?: EmailVerificationStatus;
  linkedin_url?: string | null;
  source_platform: SourcePlatform;
  source_url?: string | null;
  batch_id?: string | null;
  icp_fit?: IcpFit;
  notes?: string | null;
}

/** Runtime list of columns PATCH /crm/api/leads/:id accepts — the worker
 *  imports this so the DTO below and the route can't drift. */
export const EDITABLE_FIELDS = [
  "company_name", "website", "city", "state", "locations_count", "est_arr_bucket",
  "decision_maker_name", "decision_maker_title", "decision_maker_role",
  "verified_email", "email_verification_status", "linkedin_url",
  "source_platform", "source_url", "batch_id", "icp_fit", "exclusion_reason",
  "assigned_closer_email", "notes", "call_scheduled_for", "next_touch_at",
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const LOST_REASONS = ["bounced", "no_reply", "not_interested", "not_icp", "no_show", "unsubscribed", "other"] as const;

/** PATCH /crm/api/leads/:id — replaces EDITABLE_FIELDS in crm-entry.js. */
export type UpdateAbaLeadInput = Partial<Pick<AbaLeadRow, EditableField>>;

/** PATCH /crm/api/leads/:id/status */
export interface SetLeadStatusInput {
  status: LeadStatus;
  lostReason?: LostReason | string;
  /** Required when status = "call_scheduled". */
  callScheduledFor?: IsoDateTime;
  /** Admin-only override to move backwards in the funnel. */
  force?: boolean;
}

/** PATCH /crm/api/payouts/:id */
export interface UpdatePayoutInput {
  status: Exclude<PayoutStatus, "not_earned" | "earned">;
  invoice_ref?: string | null;
  paid_ref?: string | null;
  paid_at?: IsoDateTime | null;
  voided_reason?: string | null;
}

// ── Stage machine helpers (pure; safe to import in worker + UI) ────────────

export const STAGE_ORDER: Record<PipelineStage, number> = Object.fromEntries(
  PIPELINE_STAGES.map((s, i) => [s, i]),
) as Record<PipelineStage, number>;

export const PAYOUT_BY_TRIGGER: Record<PayoutTrigger, number> = {
  qualified_show: 5000, // $50.00
  closed_won: 15000, // $150.00
};

export function isPipelineStage(s: string): s is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(s);
}

export function isValidStatus(s: unknown): s is LeadStatus {
  return typeof s === "string" && (VALID_STATUSES as readonly string[]).includes(s);
}

/**
 * Transition rule:
 *  - any stage → `lost` (always allowed)
 *  - forward moves may skip stages (e.g. `contacted` → `call_scheduled` when a
 *    lead books directly from the first email)
 *  - backward moves require `force` (admin); `lost` → any pipeline stage
 *    requires `force` too (re-open)
 *  - leaving `sourced` requires `approved_for_outreach = 1`
 */
export function canTransition(
  lead: Pick<AbaLeadRow, "status" | "approved_for_outreach">,
  to: LeadStatus,
  opts: { force?: boolean } = {},
): { ok: true } | { ok: false; reason: string } {
  const from = lead.status;
  if (from === to) return { ok: false, reason: "already in that stage" };
  if (to === "lost") return { ok: true };
  if (from === "lost") return opts.force ? { ok: true } : { ok: false, reason: "re-opening a lost lead requires force" };
  if (!isPipelineStage(from) || !isPipelineStage(to)) return { ok: false, reason: "unknown stage" };
  if (from === "sourced" && !lead.approved_for_outreach)
    return { ok: false, reason: "lead must be approved for outreach before leaving sourced" };
  if (STAGE_ORDER[to] < STAGE_ORDER[from] && !opts.force)
    return { ok: false, reason: "backward move requires force" };
  return { ok: true };
}

/** Which payout (if any) a transition INTO `to` earns. Idempotency is enforced
 *  by uq_lead_payouts_trigger, not here. */
export function payoutTriggerFor(to: LeadStatus): PayoutTrigger | null {
  return to === "qualified_show" || to === "closed_won" ? to : null;
}

/** Timestamp column to stamp on entering a stage (besides stage_entered_at). */
export const STAGE_TIMESTAMP_COLUMN: Partial<Record<LeadStatus, keyof AbaLeadRow>> = {
  contacted: "first_contacted_at",
  replied: "replied_at",
  qualified_show: "call_held_at",
  closed_won: "closed_at",
};

// ── UI metadata (replaces LEAD_STATUSES in crmStatus.js / crmStatus.ts) ────
// Colors reference the same index.css @theme tokens the existing board uses.

export interface StageMeta {
  key: LeadStatus;
  label: string;
  color: string;
}

export const LEAD_STATUSES: readonly StageMeta[] = [
  { key: "sourced", label: "Sourced", color: "var(--color-sand)" },
  { key: "queued", label: "Queued", color: "var(--color-sand)" },
  { key: "contacted", label: "Contacted", color: "var(--color-warning)" },
  { key: "replied", label: "Replied", color: "var(--color-warning)" },
  { key: "form_completed", label: "Form completed", color: "var(--color-action)" },
  { key: "call_scheduled", label: "Call scheduled", color: "var(--color-action)" },
  { key: "qualified_show", label: "Qualified show · $50", color: "var(--color-success)" },
  { key: "closed_won", label: "Closed won · $150", color: "var(--color-success)" },
  { key: "lost", label: "Lost", color: "var(--color-danger)" },
];

export const SOURCE_LABEL: Record<SourcePlatform, string> = {
  aba_index: "The ABA Index",
  google_maps: "Google Maps",
  linkedin_sales_nav: "LinkedIn Sales Nav",
  apollo: "Apollo",
  state_directory: "State directory",
  manual: "Manual",
  other: "Other",
};

export const PRIORITY_STATES: readonly UsState[] = ["TX", "FL", "CA", "NC", "CO", "VA", "MD", "IL", "UT", "GA", "NJ"];

export const usd = (cents: number | null | undefined) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * Builds the tracked landing-page link for an outreach touch. `origin` is
 * the marketing site (same host as the Hub in production). `step` becomes
 * utm_content so form completions can be attributed to a sequence step.
 */
export function intakeLink(origin: string, lead: Pick<AbaLeadRow, "id" | "batch_id">, opts: { step?: number; medium?: "email" | "linkedin" | "phone"; source?: string } = {}): string {
  const u = new URL("/aba", origin);
  u.searchParams.set("lid", lead.id);
  u.searchParams.set("utm_source", opts.source ?? "cold_outreach");
  u.searchParams.set("utm_medium", opts.medium ?? "email");
  if (lead.batch_id) u.searchParams.set("utm_campaign", lead.batch_id);
  if (opts.step) u.searchParams.set("utm_content", `step${opts.step}`);
  return u.toString();
}

/** Normalizes a URL/domain to the dedup key stored in website_domain. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#]/)[0];
  return s || null;
}
