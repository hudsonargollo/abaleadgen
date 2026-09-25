// Entry point for the goldplanner-crm Worker (goldplanner.clubemkt.digital/crm/*).
//
// New code (Hono) for the CRM-specific surface (leads/sales/commissions —
// migration 0009_hub_crm.sql), but auth (/crm/api/auth/*) and static asset
// serving fall through to the SAME compiled Pages Functions backend
// goldplanner-hub/goldplanner-portal already use — same reasoning as
// worker/portal-entry.js: no reason to duplicate login/signup/me, and
// rbac.js's checks already gate the delegated routes server-side regardless
// of which Worker they arrive through.
import { Hono } from "hono";
import { getSessionEmail } from "../functions/_lib/session.js";
import { getUserByEmail } from "../functions/_lib/db.js";
import { isCrmCloserOrAbove, isCrmAdmin } from "./lib/crmRbac.js";
import {
  listLeads,
  getLead,
  createLead,
  updateLead,
  deleteLead,
  logLeadEvent,
  listLeadEvents,
  createPayout,
  getPayout,
  listPayouts,
  updatePayout,
  logTouch,
  listTouches,
  findExistingLeadKeys,
  recordWebhookEvent,
  updateWebhookEvent,
  listWebhookEvents,
  logLeadQuestion,
  listLeadQuestions,
  getLeadQuestion,
  approveLeadQuestion,
} from "./lib/crmDb.js";
import { runWonAutomation } from "./lib/wonAutomation.js";
// Single source of truth for stages, transition rules and payout triggers —
// shared with the Hub UI (src/crm/*) and mobile. Wrangler's esbuild strips the
// types, so a .ts import from this .js entry is fine.
import {
  VALID_STATUSES,
  EDITABLE_FIELDS,
  SOURCE_PLATFORMS,
  PAYOUT_BY_TRIGGER,
  STAGE_TIMESTAMP_COLUMN,
  STAGE_ORDER,
  isPipelineStage,
  canTransition,
  payoutTriggerFor,
  normalizeDomain,
} from "../src/crm/abaLead.types.ts";
import { validateBatch, parseDelimited, checkEmail, normalizeState } from "../src/crm/leadValidation.ts";
import { listPlans, getPlanWithSteps, addStep, updateStep, deleteStep, approvePlan } from "./lib/onboardingService.js";
import { ask as askBusinessSpecialist, suggest as suggestBusinessSpecialist } from "./lib/businessSpecialistService.js";
import { createKbDocument, listKbDocuments, archiveKbDocument, promoteQuestionToFaq } from "./lib/crmKbService.js";
import { listWaLinks, createWaLink, updateWaLink, deleteWaLink, resolveWaLink } from "./lib/waLinksService.js";
import { listWaNumbers, createWaNumber, deleteWaNumber } from "./lib/waNumbersService.js";
import {
  sendTelegramAlert,
  formatOpenAlert,
  formatClickAlert,
  formatIntakeAlert,
  formatBookingAlert,
} from "./lib/telegramService.js";
// Loaded lazily: the compiled bundle carries a WASM import (photon) that the
// Workers runtime resolves natively but Node cannot, and the CRM test suite
// (test/crm.e2e.mjs) imports this module without ever reaching the fallback.
let pagesHandlerPromise = null;
// Literal specifier so wrangler/esbuild still bundles it into the deploy.
const loadPagesHandler = () => (pagesHandlerPromise ??= import("../dist/_worker.js/index.js").then((m) => m.default));

const app = new Hono();

const json = (c, data, status = 200) => c.json(data, status);

// Every /crm/api/leads* and /crm/api/sales* route requires crm_role
// closer-or-admin (see worker/lib/crmRbac.js — 'partner' exists in the
// ladder for later, not wired into any scoped view yet since there are no
// affiliates today).
app.use("/crm/api/leads/*", requireCrm);
app.use("/crm/api/leads", requireCrm);
app.use("/crm/api/payouts", requireCrm);
app.use("/crm/api/payouts/*", requireCrm);
app.use("/crm/api/webhooks/events", requireCrm);
app.use("/crm/api/dashboard", requireCrm);
app.use("/crm/api/kb/*", requireCrm);
app.use("/crm/api/questions/*", requireCrm);
app.use("/crm/api/wa-links", requireCrm);
app.use("/crm/api/wa-links/*", requireCrm);
app.use("/crm/api/wa-numbers", requireCrm);
app.use("/crm/api/wa-numbers/*", requireCrm);
app.use("/crm/api/settings/*", requireCrm);
app.use("/crm/api/onboarding/*", requireCrm);

async function requireCrm(c, next) {
  const email = await getSessionEmail(c.req.raw, c.env);
  const user = email ? await getUserByEmail(c.env.DB, email) : null;
  if (!user || !isCrmCloserOrAbove(user)) return json(c, { error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
}

// ── leads ────────────────────────────────────────────────────────────────
app.get("/crm/api/leads", async (c) => {
  const status = c.req.query("status") || undefined;
  const leads = await listLeads(c.env.DB, { status });
  return json(c, { leads });
});

/** Coerces a raw create/import row into the column map createLead() takes.
 *  Only whitelisted columns get through; website is normalized to the
 *  website_domain dedup key; state is upper-cased. */
function leadFieldsFromInput(body) {
  const str = (v, max = 300) => {
    if (v === undefined || v === null) return null;
    const t = String(v).trim().slice(0, max);
    return t || null;
  };
  const website = str(body.website);
  const email = str(body.verified_email ?? body.email, 200);
  const source = SOURCE_PLATFORMS.includes(body.source_platform) ? body.source_platform : "manual";
  const locations = Number(body.locations_count);
  return {
    company_name: str(body.company_name ?? body.company),
    website,
    website_domain: normalizeDomain(website),
    city: str(body.city, 120),
    state: str(body.state, 2)?.toUpperCase() || null,
    locations_count: Number.isFinite(locations) && locations > 0 ? Math.round(locations) : null,
    est_arr_bucket: str(body.est_arr_bucket, 20),
    decision_maker_name: str(body.decision_maker_name, 200),
    decision_maker_title: str(body.decision_maker_title, 200),
    decision_maker_role: str(body.decision_maker_role, 30),
    verified_email: email ? email.toLowerCase() : null,
    email_verification_status: str(body.email_verification_status, 20) || "unverified",
    linkedin_url: str(body.linkedin_url, 500),
    source_platform: source,
    source_url: str(body.source_url, 1000),
    batch_id: str(body.batch_id, 60),
    icp_fit: str(body.icp_fit, 10) || "unknown",
    notes: str(body.notes, 5000),
  };
}

app.post("/crm/api/leads", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const fields = leadFieldsFromInput(body);
  if (!fields.company_name && !fields.website) {
    return json(c, { error: "Company name or website is required." }, 400);
  }
  try {
    const lead = await createLead(c.env.DB, { ...fields, status: "sourced", stage_entered_at: new Date().toISOString() });
    await logLeadEvent(c.env.DB, lead.id, { type: "created", actorEmail: c.get("user").email });
    return json(c, { lead }, 201);
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return json(c, { error: "A lead with this website or email already exists." }, 409);
    throw e;
  }
});

// Bulk import — the sourcing step. Accepts either JSON
//   { rows: [...], batch_id?, source?, dry_run?, reject_role_emails?, require_email? }
// or a raw CSV/TSV body (Content-Type: text/csv) with the same options as
// query params. Every row goes through src/crm/leadValidation.ts (syntax,
// state normalization, role-based email flags) and then in-file + DB
// duplicate detection on website_domain / verified_email.
//
// dry_run=true returns the full report and writes NOTHING. Without it, only
// rows with status "valid" are inserted — errors and duplicates are never
// partially applied, and the report says exactly which rows landed (leadId).
// Capped at 500 rows per call (D1 write budget); the CLI chunks bigger files.
app.post("/crm/api/leads/import", async (c) => {
  const ct = c.req.header("content-type") || "";
  let rows = [];
  let opts = {};
  if (/text\/(csv|tab-separated-values|plain)/i.test(ct)) {
    const text = await c.req.text();
    rows = parseDelimited(text).rows;
    const q = (k) => c.req.query(k);
    opts = { batch_id: q("batch_id"), source: q("source"), dry_run: q("dry_run") === "1" || q("dry_run") === "true", reject_role_emails: q("reject_role_emails") === "1", require_email: q("require_email") === "1" };
  } else {
    const body = await c.req.json().catch(() => ({}));
    rows = Array.isArray(body.rows) ? body.rows : [];
    opts = body;
  }
  if (!rows.length) return json(c, { error: "No rows — send { rows: [...] } as JSON or a CSV body with a header line." }, 400);

  const existing = await findExistingLeadKeys(c.env.DB);
  const report = validateBatch(rows, {
    batchId: opts.batch_id ? String(opts.batch_id).slice(0, 60) : null,
    defaultSource: SOURCE_PLATFORMS.includes(opts.source) ? opts.source : "manual",
    existing,
    rejectRoleEmails: Boolean(opts.reject_role_emails),
    requireEmail: Boolean(opts.require_email),
    maxRows: 500,
  });
  const dryRun = Boolean(opts.dry_run);
  let created = 0;
  if (!dryRun) {
    const actor = c.get("user").email;
    const now = new Date().toISOString();
    for (const r of report.rows) {
      if (r.status !== "valid") continue;
      const lead = await createLead(c.env.DB, { ...r.lead, status: "sourced", stage_entered_at: now });
      r.leadId = lead.id;
      await logLeadEvent(c.env.DB, lead.id, {
        type: "imported",
        payload: { batch_id: r.lead.batch_id, source_platform: r.lead.source_platform, warnings: r.warnings.map((w) => w.code) },
        actorEmail: actor,
      });
      created++;
    }
  }
  return json(
    c,
    {
      dry_run: dryRun,
      batch_id: opts.batch_id || null,
      created,
      // Back-compat with the first UI cut: skipped[] = every non-imported row.
      skipped: report.rows.filter((r) => r.status !== "valid").map((r) => ({ row: r.row - 1, reason: r.errors[0]?.message || r.status, leadId: r.existingLeadId })),
      ids: report.rows.filter((r) => r.leadId).map((r) => r.leadId),
      summary: report.summary,
      rows: report.rows,
    },
    dryRun ? 200 : 201
  );
});

// Pilot batch sign-off. Body: { ids: [...], batch_id? }. Flags each lead as
// approved and moves it sourced → queued (the transition rule refuses to
// leave `sourced` without this flag). Admin-only: approval is the client's
// contractual gate, not a closer's call.
app.post("/crm/api/leads/approve", async (c) => {
  if (!isCrmAdmin(c.get("user"))) return json(c, { error: "admin only" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
  if (!ids.length) return json(c, { error: "ids[] is required" }, 400);
  const actor = c.get("user").email;
  const now = new Date().toISOString();
  let approved = 0;
  for (const id of ids) {
    const lead = await getLead(c.env.DB, id);
    if (!lead) continue;
    const fields = { approved_for_outreach: 1, approved_at: now, approved_by: actor };
    if (body.batch_id) fields.batch_id = String(body.batch_id).slice(0, 60);
    const reopening = lead.status === "lost" && lead.lost_reason === "not_icp";
    if (lead.status === "sourced" || reopening) { fields.status = "queued"; fields.stage_entered_at = now; }
    if (reopening) { fields.lost_reason = null; fields.icp_fit = "fit"; fields.exclusion_reason = null; }
    await updateLead(c.env.DB, id, fields);
    await logLeadEvent(c.env.DB, id, { type: "approved_for_outreach", payload: { batch_id: fields.batch_id || lead.batch_id, reopened: reopening }, actorEmail: actor });
    if (fields.status) await logLeadEvent(c.env.DB, id, { type: "status_changed", payload: { from: lead.status, to: "queued", forced: reopening }, actorEmail: actor });
    approved++;
  }
  return json(c, { approved });
});

// Pre-launch reject. Body: { ids: [...], reason?: exclusion_reason, note? }.
// Marks the lead unfit, records why, and parks it in `lost` (lost_reason
// not_icp) so it can never be queued by accident. Reversible: approving a
// rejected lead reopens it into `queued`. Admin-only, like approve.
app.post("/crm/api/leads/reject", async (c) => {
  if (!isCrmAdmin(c.get("user"))) return json(c, { error: "admin only" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
  if (!ids.length) return json(c, { error: "ids[] is required" }, 400);
  const reason = ["solo_practitioner", "non_owner", "pe_backed", "school", "staffing", "non_aba", "other"].includes(body.reason) ? body.reason : "other";
  const actor = c.get("user").email;
  let rejected = 0;
  for (const id of ids) {
    const lead = await getLead(c.env.DB, id);
    if (!lead) continue;
    if (isPipelineStage(lead.status) && STAGE_ORDER[lead.status] >= STAGE_ORDER.contacted) continue; // already in play — use the board
    await updateLead(c.env.DB, id, { icp_fit: "unfit", exclusion_reason: reason, approved_for_outreach: 0, approved_at: null, approved_by: null, status: "lost", lost_reason: "not_icp", stage_entered_at: new Date().toISOString() });
    await logLeadEvent(c.env.DB, id, { type: "status_changed", payload: { from: lead.status, to: "lost", lostReason: "not_icp", forced: true }, actorEmail: actor });
    await logLeadEvent(c.env.DB, id, { type: "rejected", payload: { reason, note: String(body.note || "").slice(0, 500) || null }, actorEmail: actor });
    rejected++;
  }
  return json(c, { rejected });
});

// ── Public intake (the /aba landing-page form) ───────────────────────────
// Unauthenticated by design — visitors aren't logged in. Resolution order:
//   1. attribution.lid  (the lead id carried on the outreach link)
//   2. contact.email    (forwarded link, retyped URL, organic)
//   3. otherwise a NEW inbound lead — sourced from the page itself.
// Answers + attribution are stored verbatim in leads.qualification (JSON,
// column from migration 0012) and the UTMs on the utm_* columns (0009), so
// the dashboard can split form completions by campaign/sequence step.
// The lead advances to form_completed (forced past the approval gate — a
// filled-in form IS consent to be contacted). Leads already at
// call_scheduled or later are never moved backwards.
const LOCATION_BUCKET_TO_COUNT = { "1": 1, "2-3": 2, "4-5": 4, "6+": 6 };
const INTAKE_ANSWER_KEYS = ["locations", "capacity", "priority", "timeline"];

app.post("/crm/api/public/intake", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.company_fax) return json(c, { ok: true }, 200); // honeypot — pretend success
  const contact = body.contact || {};
  const answers = {};
  for (const k of INTAKE_ANSWER_KEYS) answers[k] = String(contact[k] ?? body.answers?.[k] ?? "").slice(0, 40) || null;
  const attr = body.attribution || {};
  const ec = checkEmail(contact.email);
  if (!ec.valid) return json(c, { error: "Please enter a valid work email." }, 400);
  const name = String(contact.name || "").trim().slice(0, 200);
  const clinic = String(contact.clinic || "").trim().slice(0, 300);
  if (!name || !clinic) return json(c, { error: "Name and practice name are required." }, 400);
  const state = normalizeState(contact.state) || null;
  const website = String(contact.website || "").trim().slice(0, 500) || null;
  const domain = normalizeDomain(website);
  const phone = String(contact.phone || "").trim().slice(0, 60) || null;
  const utm = {
    utm_source: String(attr.utm_source || "").slice(0, 120) || null,
    utm_medium: String(attr.utm_medium || "").slice(0, 120) || null,
    utm_campaign: String(attr.utm_campaign || "").slice(0, 120) || null,
    referrer: String(attr.referrer || "").slice(0, 300) || null,
  };
  const qualification = JSON.stringify({
    source: "aba_intake_form",
    submitted_at: new Date().toISOString(),
    answers,
    contact: { name, clinic, email: ec.email, phone, state, website },
    attribution: {
      lid: String(attr.lid || "").slice(0, 64) || null,
      ...utm,
      utm_content: String(attr.utm_content || "").slice(0, 120) || null,
      utm_term: String(attr.utm_term || "").slice(0, 120) || null,
      landing_path: String(attr.landing_path || "").slice(0, 300) || null,
      first_seen_at: String(attr.first_seen_at || "").slice(0, 40) || null,
    },
  });

  let lead = null;
  let matched = "new";
  if (attr.lid) {
    lead = await getLead(c.env.DB, String(attr.lid).slice(0, 64));
    if (lead) matched = "lid";
  }
  if (!lead) {
    lead = await c.env.DB.prepare("SELECT * FROM leads WHERE lower(verified_email) = ?").bind(ec.email).first();
    if (lead) matched = "email";
  }
  if (!lead && domain) {
    lead = await c.env.DB.prepare("SELECT * FROM leads WHERE website_domain = ?").bind(domain).first();
    if (lead) matched = "domain";
  }

  const locations = LOCATION_BUCKET_TO_COUNT[answers.locations] ?? null;
  const now = new Date().toISOString();
  if (!lead) {
    // Inbound lead — no outbound row to attach to. Domain/email UNIQUE
    // indexes can't collide here (both lookups above came back empty).
    lead = await createLead(c.env.DB, {
      company_name: clinic,
      website,
      website_domain: domain,
      state,
      locations_count: locations,
      decision_maker_name: name,
      verified_email: ec.email,
      email_verification_status: ec.roleBased ? "risky" : "unverified",
      phone,
      source_platform: "other",
      source_url: utm.utm_source ? `aba_intake:${utm.utm_source}` : "aba_intake:organic",
      batch_id: utm.utm_campaign,
      icp_fit: answers.locations === "6+" ? "unfit" : "unknown",
      approved_for_outreach: 1, // they came to us
      approved_at: now,
      approved_by: "intake-form",
      qualification,
      ...utm,
      status: "sourced",
      stage_entered_at: now,
    });
    await logLeadEvent(c.env.DB, lead.id, { type: "created", payload: { source: "aba_intake_form", ...utm }, actorEmail: "intake-form" });
  } else {
    // Enrich the outbound row with whatever the owner told us that we
    // didn't already have — never overwrite sourced data with form data.
    const fields = { qualification, ...Object.fromEntries(Object.entries(utm).filter(([, v]) => v)) };
    if (!lead.decision_maker_name) fields.decision_maker_name = name;
    if (!lead.verified_email) fields.verified_email = ec.email;
    if (!lead.phone) fields.phone = phone;
    if (!lead.state && state) fields.state = state;
    if (!lead.locations_count && locations) fields.locations_count = locations;
    if (!lead.website_domain && domain) {
      fields.website = website;
      fields.website_domain = domain;
    }
    if (!lead.approved_for_outreach) {
      fields.approved_for_outreach = 1;
      fields.approved_at = now;
      fields.approved_by = "intake-form";
    }
    try {
      lead = await updateLead(c.env.DB, lead.id, fields);
    } catch (e) {
      if (!String(e.message).includes("UNIQUE")) throw e;
      lead = await updateLead(c.env.DB, lead.id, { qualification }); // keep the answers even if enrichment collides
    }
  }

  await logLeadEvent(c.env.DB, lead.id, { type: "form_completed", payload: { matched, answers, utm_content: attr.utm_content || null }, actorEmail: "intake-form" });
  c.executionCtx?.waitUntil?.(sendTelegramAlert(c.env, formatIntakeAlert(lead, answers), [
    [{ text: "📅 Discovery Link", url: `https://abaclinics.clubemkt.digital/aba` }]
  ]));

  // Advance — but never backwards.
  const order = STAGE_ORDER[lead.status];
  if (lead.status === "lost" || (order !== undefined && order < STAGE_ORDER.form_completed)) {
    const r = await transitionLead(c.env.DB, lead, "form_completed", { force: true, actorEmail: "intake-form" });
    if (r.ok) lead = r.lead;
  }
  return json(c, { leadId: lead.id, matched, status: lead.status }, 201);
});

// ── Booking webhook receiver ─────────────────────────────────────────────
// Mounted at BOTH /crm/api/webhooks/booking (canonical) and the older
// /crm/api/public/form-completed. Accepts:
//   - Cal.com   (triggerEvent BOOKING_CREATED | BOOKING_RESCHEDULED | BOOKING_CANCELLED,
//                payload.uid, payload.attendees[0].email, payload.startTime, payload.metadata.lead_id)
//   - Calendly  (event invitee.created | invitee.canceled, payload.uri, payload.email,
//                payload.scheduled_event.start_time, payload.tracking.utm_content = "lid:<leadId>")
//   - generic   ({ email | lead_id, scheduled_for?, external_id?, cancelled?: true })
//                — for Zapier/Make or an internal booking tool.
//
// Authentication, any ONE of:
//   - Authorization: Bearer <FORM_WEBHOOK_TOKEN>                         (generic / Zapier)
//   - x-cal-signature-256: hex HMAC-SHA256(raw body, CAL_WEBHOOK_SECRET)  (Cal.com native)
//   - calendly-webhook-signature: t=<ts>,v1=<hex HMAC-SHA256("<ts>.<raw body>", CALENDLY_WEBHOOK_SIGNING_KEY)>
// Signatures are computed over the RAW body, so the body is read as text
// first and parsed afterwards.
//
// Idempotency: (provider, external_id) is UNIQUE in webhook_events — a
// redelivered event returns 200 {duplicate:true} without touching the lead.
// Every delivery is stored with its raw payload for audit.
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function authenticateWebhook(c, rawBody) {
  const bearer = (c.req.header("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer && c.env.FORM_WEBHOOK_TOKEN && timingSafeEq(bearer, c.env.FORM_WEBHOOK_TOKEN)) return "token";
  const calSig = c.req.header("x-cal-signature-256");
  if (calSig && c.env.CAL_WEBHOOK_SECRET) {
    if (timingSafeEq(calSig.toLowerCase(), await hmacHex(c.env.CAL_WEBHOOK_SECRET, rawBody))) return "cal.com";
  }
  const calendlySig = c.req.header("calendly-webhook-signature");
  if (calendlySig && c.env.CALENDLY_WEBHOOK_SIGNING_KEY) {
    const t = calendlySig.match(/t=([^,]+)/)?.[1];
    const v1 = calendlySig.match(/v1=([a-f0-9]+)/i)?.[1];
    if (t && v1 && timingSafeEq(v1.toLowerCase(), await hmacHex(c.env.CALENDLY_WEBHOOK_SIGNING_KEY, `${t}.${rawBody}`))) {
      // Calendly recommends rejecting stale signatures (replay protection).
      if (Math.abs(Date.now() / 1000 - Number(t)) < 5 * 60) return "calendly";
    }
  }
  return null;
}

/** Normalizes the three payload shapes into one event. Returns null for
 *  event types we don't act on. */
function normalizeBookingPayload(body) {
  if (body?.triggerEvent && body.payload) {
    const p = body.payload;
    const kind = /BOOKING_CANCELLED|BOOKING_REJECTED/.test(body.triggerEvent) ? "cancelled" : /BOOKING_CREATED|BOOKING_RESCHEDULED/.test(body.triggerEvent) ? "booked" : null;
    if (!kind) return null;
    return { kind, provider: "cal.com", event_type: body.triggerEvent, external_id: p.uid || p.bookingId || null, email: p.attendees?.[0]?.email, scheduled_for: p.startTime, lead_id: p.metadata?.lead_id };
  }
  if (body?.event && body.payload) {
    const p = body.payload;
    const kind = /invitee\.canceled/.test(body.event) ? "cancelled" : /invitee\.created/.test(body.event) ? "booked" : null;
    if (!kind) return null;
    const lid = String(p.tracking?.utm_content || "").match(/^lid:(.+)$/)?.[1];
    return { kind, provider: "calendly", event_type: body.event, external_id: p.uri || p.scheduled_event?.uri || null, email: p.email, scheduled_for: p.scheduled_event?.start_time, lead_id: lid };
  }
  if (!body || typeof body !== "object") return null;
  return {
    kind: body.cancelled ? "cancelled" : "booked",
    provider: "generic",
    event_type: body.event_type || (body.cancelled ? "booking.cancelled" : body.scheduled_for ? "booking.created" : "form.completed"),
    external_id: body.external_id || null,
    email: body.email,
    scheduled_for: body.scheduled_for,
    lead_id: body.lead_id,
    answers: body.answers,
  };
}

async function handleBookingWebhook(c) {
  const rawBody = await c.req.text();
  const via = await authenticateWebhook(c, rawBody);
  if (!via) return json(c, { error: "unauthorized" }, 401);
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json(c, { error: "invalid JSON" }, 400);
  }
  const db = c.env.DB;
  const evt = normalizeBookingPayload(body);
  if (!evt) {
    await recordWebhookEvent(db, { provider: "unknown", eventType: String(body?.triggerEvent || body?.event || "unknown").slice(0, 80), result: "ignored", payload: body });
    return json(c, { ignored: true }, 200);
  }
  // Dedup key: provider + booking id + event type, so a create and a later
  // cancel of the same booking are distinct, but a redelivery is not.
  const externalId = evt.external_id ? `${evt.external_id}:${evt.event_type}` : null;
  const evId = await recordWebhookEvent(db, { provider: evt.provider, eventType: evt.event_type, externalId, result: "received", payload: body });
  if (!evId) return json(c, { duplicate: true }, 200);
  const done = async (result, detail, leadId, extra = {}, status = 200) => {
    await updateWebhookEvent(db, evId, { leadId, result, detail });
    return json(c, { via, result, ...extra }, status);
  };

  const email = String(evt.email || "").trim().toLowerCase();
  let lead = evt.lead_id ? await getLead(db, String(evt.lead_id).slice(0, 64)) : null;
  if (!lead && evt.external_id) lead = await db.prepare("SELECT * FROM leads WHERE booking_external_id = ?").bind(String(evt.external_id).slice(0, 200)).first();
  if (!lead && email) lead = await db.prepare("SELECT * FROM leads WHERE lower(verified_email) = ?").bind(email).first();
  if (!lead) return done("unmatched", email || evt.lead_id || "no identifier", null, { matched: false }, 202);

  const actor = "booking-webhook";
  if (evt.kind === "cancelled") {
    // A cancelled call is not a show. Keep the stage history honest: drop
    // back to `replied` (they did engage) unless the call already happened.
    if (STAGE_ORDER[lead.status] >= STAGE_ORDER.qualified_show) return done("ignored", "call already held", lead.id, { matched: true, moved: false });
    await updateLead(db, lead.id, { call_scheduled_for: null, booking_external_id: null });
    await logLeadEvent(db, lead.id, { type: "call_cancelled", payload: { provider: evt.provider, externalId: evt.external_id }, actorEmail: actor });
    let moved = false;
    if (lead.status === "call_scheduled") {
      const r = await transitionLead(db, { ...lead, call_scheduled_for: null }, "replied", { force: true, actorEmail: actor });
      moved = r.ok;
    }
    return done("cancelled", null, lead.id, { matched: true, moved, lead: await getLead(db, lead.id) });
  }

  const scheduledFor = evt.scheduled_for ? new Date(evt.scheduled_for).toISOString() : null;
  const bookingFields = { booking_provider: evt.provider, booking_external_id: evt.external_id ? String(evt.external_id).slice(0, 200) : lead.booking_external_id };
  if (scheduledFor && STAGE_ORDER[lead.status] >= STAGE_ORDER.call_scheduled) {
    // Reschedule: move the time, keep the stage (a held call stays held).
    await updateLead(db, lead.id, { call_scheduled_for: scheduledFor, ...bookingFields });
    await logLeadEvent(db, lead.id, { type: "call_rescheduled", payload: { scheduledFor, provider: evt.provider, externalId: evt.external_id }, actorEmail: actor });
    return done("rescheduled", scheduledFor, lead.id, { matched: true, moved: false, rescheduled: true, lead: await getLead(db, lead.id) });
  }
  const to = scheduledFor ? "call_scheduled" : "form_completed";
  const result = await transitionLead(db, lead, to, { callScheduledFor: scheduledFor, force: true, actorEmail: actor });
  if (!result.ok) return done("error", result.reason, lead.id, { matched: true, moved: false, reason: result.reason });
  await updateLead(db, lead.id, bookingFields);
  await logLeadEvent(db, lead.id, { type: to === "call_scheduled" ? "call_booked" : "form_completed", payload: { provider: evt.provider, scheduledFor, externalId: evt.external_id, answers: evt.answers || null }, actorEmail: actor });
  if (to === "call_scheduled") {
    c.executionCtx?.waitUntil?.(sendTelegramAlert(c.env, formatBookingAlert(lead, evt), [
      [{ text: "✅ Open Kanban Lead", url: `https://abaclinics.clubemkt.digital/hub` }]
    ]));
  }
  return done("processed", scheduledFor, lead.id, { matched: true, moved: true, lead: await getLead(db, lead.id) });
}

app.post("/crm/api/webhooks/booking", handleBookingWebhook);
app.post("/crm/api/public/form-completed", handleBookingWebhook); // legacy path

// ── Open Tracking Pixel (1x1 GIF) ───────────────────────────────────────────
const TRANSPARENT_1X1_GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b
]);

app.get("/crm/api/track/open", async (c) => {
  const q = c.req.query();
  const lid = q.lid || q.lead_id;
  const touch = q.touch || q.step || "1";

  if (lid) {
    const p = (async () => {
      try {
        const lead = await getLead(c.env.DB, lid);
        if (lead) {
          await logLeadEvent(c.env.DB, lid, {
            type: "email_opened",
            payload: { touch, user_agent: c.req.header("user-agent") },
            actorEmail: "tracking_pixel",
          });
          await sendTelegramAlert(c.env, formatOpenAlert(lead, touch));
        }
      } catch (e) {
        console.error("Open track error:", e);
      }
    })();
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(p);
    else await p;
  }

  return new Response(TRANSPARENT_1X1_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
    },
  });
});

// ── Tracked Click Redirector ─────────────────────────────────────────────────
app.get("/crm/api/track/click", async (c) => {
  const q = c.req.query();
  const lid = q.lid || q.lead_id;
  const touch = q.touch || q.step || "1";
  const rawTarget = q.url || `https://abaclinics.clubemkt.digital/aba?lid=${encodeURIComponent(lid || "")}&utm_source=cold_email&utm_campaign=pilot-2026-09-25&utm_content=touch_${encodeURIComponent(touch)}`;

  if (lid) {
    const p = (async () => {
      try {
        const lead = await getLead(c.env.DB, lid);
        if (lead) {
          await logLeadEvent(c.env.DB, lid, {
            type: "link_clicked",
            payload: { touch, target: rawTarget, user_agent: c.req.header("user-agent") },
            actorEmail: "link_tracker",
          });
          await sendTelegramAlert(c.env, formatClickAlert(lead, touch, rawTarget));
        }
      } catch (e) {
        console.error("Click track error:", e);
      }
    })();
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(p);
    else await p;
  }

  return c.redirect(rawTarget, 302);
});

// ── Telegram Bot Webhook & Live Kanban Commands ─────────────────────────────
app.post("/crm/api/telegram/webhook", async (c) => {
  const update = await c.req.json().catch(() => ({}));
  const msg = update.message;
  const callback = update.callback_query;

  if (msg?.text) {
    const text = msg.text.trim();
    const chatId = msg.chat?.id;

    if (text === "/start" || text === "/help") {
      await sendTelegramAlert(
        c.env,
        `🤖 *ABA LEADGEN Command Center (by hdsnrgll)*\n\n` +
        `Available Commands:\n` +
        `📊 /stats or /dashboard — Live Funnel KPIs\n` +
        `👥 /leads — View recent pipeline leads\n` +
        `💰 /payouts — View earned bounty ledger\n` +
        `🌐 /pipeline — Open Web App Kanban Board`
      );
    } else if (text === "/stats" || text === "/dashboard") {
      try {
        const [kpis, counts] = await Promise.all([
          c.env.DB.prepare(`
            SELECT 
              count(*) as total,
              sum(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) as contacted,
              sum(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) as replied,
              sum(CASE WHEN status = 'form_completed' THEN 1 ELSE 0 END) as form_completed,
              sum(CASE WHEN status = 'call_scheduled' THEN 1 ELSE 0 END) as call_scheduled,
              sum(CASE WHEN status = 'qualified_show' THEN 1 ELSE 0 END) as qualified_show,
              sum(CASE WHEN status = 'closed_won' THEN 1 ELSE 0 END) as closed_won
            FROM leads
          `).first(),
          c.env.DB.prepare(`
            SELECT count(*) as total_events FROM lead_events WHERE type IN ('email_opened', 'link_clicked')
          `).first()
        ]);

        const total = kpis?.total || 0;
        const contacted = kpis?.contacted || 0;
        const forms = kpis?.form_completed || 0;
        const booked = kpis?.call_scheduled || 0;
        const shows = kpis?.qualified_show || 0;
        const won = kpis?.closed_won || 0;
        const earned = (shows * 50) + (won * 150);

        const reply = `📊 *ABA LEADGEN LIVE STATS*\n\n` +
                      `🏢 Total Leads in DB: *${total}*\n` +
                      `✉️ Contacted: *${contacted}*\n` +
                      `📋 Forms Completed: *${forms}*\n` +
                      `📅 Calls Scheduled: *${booked}*\n` +
                      `✅ Qualified Shows: *${shows}* ($${shows * 50})\n` +
                      `💰 Closed Won: *${won}* ($${won * 150})\n\n` +
                      `💵 *Total Bounty Earned: $${earned} USD*`;

        await sendTelegramAlert(c.env, reply, [
          [{ text: "🌐 Open Kanban Board", url: "https://abaclinics.clubemkt.digital/hub" }]
        ]);
      } catch (e) {
        await sendTelegramAlert(c.env, `⚠️ Error loading stats: ${e.message}`);
      }
    } else if (text === "/payouts") {
      try {
        const payouts = await listPayouts(c.env.DB, { limit: 10 });
        const totalEarned = payouts.reduce((sum, p) => sum + (p.amount_cents || 0), 0) / 100;
        const reply = `💰 *PAYOUT LEDGER*\n\n` +
                      `💵 Total Earned: *$${totalEarned} USD*\n` +
                      `📝 Active Items: *${payouts.length}*\n` +
                      `⏱️ Terms: *Net 7 Days*\n\n` +
                      payouts.slice(0, 5).map(p => `• $${p.amount_cents/100} (${p.trigger.replace('_', ' ')}) — ${p.status}`).join('\n');
        await sendTelegramAlert(c.env, reply);
      } catch (e) {
        await sendTelegramAlert(c.env, `⚠️ Error loading payouts: ${e.message}`);
      }
    }
  }

  return json(c, { ok: true });
});

// Admin: recent webhook deliveries (audit / debugging a provider setup).
app.get("/crm/api/webhooks/events", async (c) => {
  if (!isCrmAdmin(c.get("user"))) return json(c, { error: "admin only" }, 403);
  return json(c, { events: await listWebhookEvents(c.env.DB, { limit: Math.min(500, Number(c.req.query("limit")) || 100) }) });
});

app.get("/crm/api/leads/:id", async (c) => {
  const lead = await getLead(c.env.DB, c.req.param("id"));
  if (!lead) return json(c, { error: "not found" }, 404);
  const [events, payouts, touches] = await Promise.all([
    listLeadEvents(c.env.DB, lead.id),
    listPayouts(c.env.DB, { leadId: lead.id }),
    listTouches(c.env.DB, lead.id),
  ]);
  return json(c, { lead, events, payouts, touches });
});

app.patch("/crm/api/leads/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await getLead(c.env.DB, id);
  if (!existing) return json(c, { error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const fields = {};
  for (const f of EDITABLE_FIELDS) if (f in body) fields[f] = body[f] === "" ? null : body[f];
  if ("website" in fields) fields.website_domain = normalizeDomain(fields.website);
  if (fields.state) fields.state = String(fields.state).toUpperCase().slice(0, 2);
  if (fields.verified_email) fields.verified_email = String(fields.verified_email).toLowerCase();
  if (body.email_verification_status === "valid" && existing.email_verification_status !== "valid") {
    fields.email_verified_at = new Date().toISOString();
  }
  try {
    const lead = await updateLead(c.env.DB, id, fields);
    await logLeadEvent(c.env.DB, id, { type: "updated", payload: fields, actorEmail: c.get("user").email });
    return json(c, { lead });
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return json(c, { error: "Another lead already has this website or email." }, 409);
    throw e;
  }
});

/**
 * The one place a lead's stage changes. Validates with canTransition(),
 * stamps stage_entered_at + the per-stage timestamp column, writes the
 * audit event, and — on entering qualified_show / closed_won — inserts the
 * payout ledger row and flips the denormalized payout status on the lead.
 * The ledger's UNIQUE(lead_id, trigger) makes the payout side idempotent:
 * moving a lead out and back into a trigger stage never earns twice.
 */
async function payoutNetDays(db) {
  const row = await db.prepare("SELECT value FROM crm_settings WHERE key = 'payout_net_days'").first();
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

async function transitionLead(db, existing, to, { lostReason, callScheduledFor, force, actorEmail, depositDate }) {
  const check = canTransition(existing, to, { force });
  if (!check.ok) return check;
  const now = new Date().toISOString();
  const fields = { status: to, stage_entered_at: now };
  // Stage timestamps drive the funnel metrics, so only a FORWARD move stamps
  // one — a forced step back (cancelled call, unmarked milestone) is a
  // correction, not a new occurrence.
  const forward = !isPipelineStage(existing.status) || (isPipelineStage(to) && STAGE_ORDER[to] > STAGE_ORDER[existing.status]);
  const tsCol = STAGE_TIMESTAMP_COLUMN[to];
  if (tsCol && forward && !existing[tsCol]) fields[tsCol] = now;
  if (to === "lost") fields.lost_reason = lostReason || null;
  if (to === "call_scheduled") {
    if (!callScheduledFor) return { ok: false, reason: "callScheduledFor is required for call_scheduled" };
    fields.call_scheduled_for = callScheduledFor;
  }
  const trigger = payoutTriggerFor(to);
  let payout = null;
  if (trigger) {
    const settingKey = trigger === "qualified_show" ? "payout_show_cents" : "payout_close_cents";
    const row = await db.prepare("SELECT value FROM crm_settings WHERE key = ?").bind(settingKey).first();
    const amountCents = Number(row?.value) || PAYOUT_BY_TRIGGER[trigger];
    // The $150 clock starts on the deposit date (contract terms), the $50
    // clock when the show is confirmed. Due = earned + net days (default 7).
    const earnedAt = trigger === "closed_won" && depositDate ? new Date(depositDate).toISOString() : now;
    const dueAt = new Date(new Date(earnedAt).getTime() + (await payoutNetDays(db)) * 86400000).toISOString();
    payout = await createPayout(db, { leadId: existing.id, trigger, amountCents, actorEmail, earnedAt, dueAt, depositDate: trigger === "closed_won" ? depositDate || null : null });
    const col = trigger === "qualified_show" ? "show_payout_status" : "close_payout_status";
    if (payout) fields[col] = "earned";
  }
  const lead = await updateLead(db, existing.id, fields);
  await logLeadEvent(db, existing.id, {
    type: "status_changed",
    payload: { from: existing.status, to, lostReason: fields.lost_reason, callScheduledFor: fields.call_scheduled_for, forced: Boolean(force) },
    actorEmail,
  });
  if (payout) {
    await logLeadEvent(db, existing.id, { type: "payout_earned", payload: { payoutId: payout.id, trigger, amountCents: payout.amount_cents, dueAt: payout.due_at, depositDate: payout.deposit_date }, actorEmail });
  }
  return { ok: true, lead, payout };
}

app.patch("/crm/api/leads/:id/status", async (c) => {
  const id = c.req.param("id");
  const existing = await getLead(c.env.DB, id);
  if (!existing) return json(c, { error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (!VALID_STATUSES.includes(body.status)) return json(c, { error: "invalid status" }, 400);
  const user = c.get("user");
  const force = Boolean(body.force) && isCrmAdmin(user);
  const result = await transitionLead(c.env.DB, existing, body.status, {
    lostReason: body.lostReason,
    callScheduledFor: body.callScheduledFor,
    force,
    actorEmail: user.email,
  });
  if (!result.ok) return json(c, { error: result.reason }, 409);
  let { lead } = result;
  // Gold Traffic's post-sale hand-off (projects row + customer portal invite)
  // is opt-in for this pipeline — flip WON_AUTOMATION="1" in wrangler.crm.toml
  // [vars] if a closed ABA client should get a portal project.
  let automation = null;
  if (body.status === "closed_won" && c.env.WON_AUTOMATION === "1") {
    automation = await runWonAutomation(c.env.DB, lead, user.email, { projectType: body.projectType || null, brief: body.brief || null, env: c.env });
    lead = await getLead(c.env.DB, id);
  }
  return json(c, { lead, payout: result.payout, automation });
});

// Outreach touch log — one row per send/reply. Called by the sending tool's
// webhook adapter or manually from the lead detail view.
app.post("/crm/api/leads/:id/touches", async (c) => {
  const id = c.req.param("id");
  const existing = await getLead(c.env.DB, id);
  if (!existing) return json(c, { error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (!["email", "linkedin", "phone"].includes(body.channel)) return json(c, { error: "channel must be email|linkedin|phone" }, 400);
  const step = Number(body.step) || existing.sequence_step + 1;
  const touch = await logTouch(c.env.DB, id, { ...body, step });
  const fields = {};
  if (body.direction === "inbound") {
    fields.replied_at = existing.replied_at || touch.sent_at;
  } else {
    fields.sequence_step = Math.max(existing.sequence_step, step);
    if (!existing.first_contacted_at) fields.first_contacted_at = touch.sent_at;
    if (body.next_touch_at !== undefined) fields.next_touch_at = body.next_touch_at || null;
  }
  if (Object.keys(fields).length) await updateLead(c.env.DB, id, fields);
  await logLeadEvent(c.env.DB, id, { type: body.direction === "inbound" ? "reply_received" : "touch_sent", payload: { touchId: touch.id, channel: body.channel, step }, actorEmail: c.get("user").email });
  // Auto-advance: first outbound touch → contacted; first inbound → replied.
  let lead = await getLead(c.env.DB, id);
  const autoTo = body.direction === "inbound" ? "replied" : "contacted";
  if (body.autoAdvance !== false) {
    const r = await transitionLead(c.env.DB, lead, autoTo, { actorEmail: c.get("user").email });
    if (r.ok) lead = r.lead;
  }
  return json(c, { touch, lead }, 201);
});

// Hard-delete a lead. Restricted to a single operator (not any crm_role
// tier, including CRM admins) — deleting a lead wipes its whole history
// (events, payouts, touches), so this deliberately isn't a role anyone
// can be promoted into; it's one hardcoded email.
const LEAD_DELETE_ALLOWED_EMAILS = ["hudson@tektone.com.br", "hudsonargollo2@gmail.com"];

app.delete("/crm/api/leads/:id", async (c) => {
  if (!LEAD_DELETE_ALLOWED_EMAILS.includes(String(c.get("user").email || "").toLowerCase())) {
    return json(c, { error: "unauthorized" }, 403);
  }
  const id = c.req.param("id");
  const existing = await getLead(c.env.DB, id);
  if (!existing) return json(c, { error: "not found" }, 404);
  await deleteLead(c.env.DB, id);
  return json(c, { ok: true });
});

// ── Pilot milestones (the two toggles) ───────────────────────────────────
// POST /crm/api/leads/:id/milestone
//   { milestone: "qualified_show", on: true }                      → $50 earned, due in net days
//   { milestone: "qualified_show", on: false, reason? }           → no-show: void the $50, back to call_scheduled
//   { milestone: "closed_won", on: true, deposit_date, deposit_amount_cents? } → $150 earned, clock from deposit_date
//   { milestone: "closed_won", on: false, reason? }               → void the $150, back to qualified_show
// Turning a milestone ON is closer-or-above; turning one OFF (voiding money
// already in the ledger) is admin-only. Both write to lead_events; the ledger
// row itself is never deleted, only voided — that's the audit trail.
app.post("/crm/api/leads/:id/milestone", async (c) => {
  const id = c.req.param("id");
  const lead = await getLead(c.env.DB, id);
  if (!lead) return json(c, { error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const user = c.get("user");
  const milestone = body.milestone;
  if (milestone !== "qualified_show" && milestone !== "closed_won") return json(c, { error: "milestone must be qualified_show or closed_won" }, 400);
  const on = body.on !== false;
  const now = new Date().toISOString();
  const db = c.env.DB;

  if (on) {
    if (STAGE_ORDER[lead.status] >= STAGE_ORDER[milestone] && lead[milestone === "qualified_show" ? "show_payout_status" : "close_payout_status"] !== "not_earned") {
      return json(c, { error: "milestone already recorded" }, 409);
    }
    let depositDate = null;
    const fields = {};
    if (milestone === "closed_won") {
      // The $150 presupposes the $50: a close without a recorded show is an
      // admin decision (e.g. a deal that closed over email), not a closer's.
      if (lead.show_payout_status === "not_earned" && !isCrmAdmin(user)) return json(c, { error: "record the qualified show first (or ask an admin)" }, 409);
      depositDate = body.deposit_date ? new Date(body.deposit_date) : null;
      if (!depositDate || Number.isNaN(depositDate.getTime())) return json(c, { error: "deposit_date is required to mark closed won" }, 400);
      if (depositDate.getTime() > Date.now() + 86400000) return json(c, { error: "deposit_date cannot be in the future" }, 400);
      depositDate = depositDate.toISOString();
      fields.deposit_date = depositDate;
      const amt = Number(body.deposit_amount_cents);
      if (Number.isFinite(amt) && amt >= 0) fields.deposit_amount_cents = Math.round(amt);
    } else {
      fields.show_confirmed_at = now;
      fields.show_confirmed_by = user.email;
      fields.no_show = 0;
    }
    // Admin may promote from anywhere (e.g. a closed deal that skipped the
    // board); closers must be at the preceding stage or later.
    const r = await transitionLead(db, lead, milestone, { force: isCrmAdmin(user), actorEmail: user.email, depositDate });
    if (!r.ok) return json(c, { error: r.reason }, 409);
    const updated = await updateLead(db, id, fields);
    await logLeadEvent(db, id, { type: "milestone_marked", payload: { milestone, ...fields, payoutId: r.payout?.id || null }, actorEmail: user.email });
    return json(c, { lead: updated, payout: r.payout });
  }

  // OFF: void the payout and step back one stage.
  if (!isCrmAdmin(user)) return json(c, { error: "admin only — unmarking voids a payout" }, 403);
  const payouts = await listPayouts(db, { leadId: id });
  const p = payouts.find((x) => x.trigger === milestone && x.status !== "voided");
  if (p) {
    if (p.status === "paid") return json(c, { error: "payout already paid — dispute it from the Payouts tab instead" }, 409);
    await updatePayout(db, p.id, { status: "voided", voided_reason: body.reason || `${milestone} unmarked` });
    await logLeadEvent(db, id, { type: "payout_status_changed", payload: { payoutId: p.id, from: p.status, to: "voided", reason: body.reason || null }, actorEmail: user.email });
  }
  const col = milestone === "qualified_show" ? "show_payout_status" : "close_payout_status";
  const fields = { [col]: "not_earned" };
  if (milestone === "qualified_show") { fields.no_show = 1; fields.call_held_at = null; fields.show_confirmed_at = null; fields.show_confirmed_by = null; }
  else { fields.deposit_date = null; fields.deposit_amount_cents = null; fields.closed_at = null; }
  await updateLead(db, id, fields);
  const back = milestone === "qualified_show" ? "call_scheduled" : "qualified_show";
  const fresh = await getLead(db, id);
  let moved = false;
  if (fresh.status === milestone) {
    const r = await transitionLead(db, fresh, back, { force: true, actorEmail: user.email, callScheduledFor: fresh.call_scheduled_for || now });
    moved = r.ok;
  }
  await logLeadEvent(db, id, { type: "milestone_unmarked", payload: { milestone, reason: body.reason || null, voidedPayoutId: p?.id || null, movedTo: moved ? back : null }, actorEmail: user.email });
  return json(c, { lead: await getLead(db, id), voidedPayoutId: p?.id || null });
});

// ── payouts ledger ───────────────────────────────────────────────────────
function payoutBuckets(payouts, netDays) {
  const nowMs = Date.now();
  const soonMs = nowMs + netDays * 86400000;
  const b = { dueSoonCents: 0, dueSoonCount: 0, overdueCents: 0, overdueCount: 0 };
  for (const p of payouts) {
    if (p.status !== "earned" && p.status !== "invoiced") continue;
    const due = p.due_at ? new Date(p.due_at).getTime() : null;
    if (due === null) continue;
    if (due < nowMs) { b.overdueCents += p.amount_cents; b.overdueCount++; }
    else if (due <= soonMs) { b.dueSoonCents += p.amount_cents; b.dueSoonCount++; }
  }
  return b;
}

app.get("/crm/api/payouts", async (c) => {
  const status = c.req.query("status") || undefined;
  const view = c.req.query("view"); // 'due_soon' | 'overdue' | undefined
  const netDays = await payoutNetDays(c.env.DB);
  const all = await listPayouts(c.env.DB);
  const totals = { earned: 0, invoiced: 0, paid: 0, disputed: 0, voided: 0 };
  for (const p of all) totals[p.status] = (totals[p.status] || 0) + p.amount_cents;
  const buckets = payoutBuckets(all, netDays);
  let payouts = all;
  if (view === "due_soon") payouts = await listPayouts(c.env.DB, { dueWithinDays: netDays });
  else if (view === "overdue") payouts = await listPayouts(c.env.DB, { overdue: true });
  else if (status) payouts = all.filter((p) => p.status === status);
  return json(c, { payouts, totals, netDays, ...buckets });
});

// Everything due within N days (default: the pilot's net terms) — the
// invoice-prep list. Plain array, oldest due first.
app.get("/crm/api/payouts/due", async (c) => {
  const days = Number(c.req.query("days"));
  const netDays = Number.isFinite(days) ? days : await payoutNetDays(c.env.DB);
  const payouts = await listPayouts(c.env.DB, { dueWithinDays: netDays });
  return json(c, { days: netDays, count: payouts.length, totalCents: payouts.reduce((s, p) => s + p.amount_cents, 0), payouts });
});

// CSV for the client invoice / bookkeeping. ?view=due_soon|overdue|all (default all non-voided).
app.get("/crm/api/payouts/export.csv", async (c) => {
  const view = c.req.query("view") || "all";
  const netDays = await payoutNetDays(c.env.DB);
  let rows = view === "due_soon" ? await listPayouts(c.env.DB, { dueWithinDays: netDays }) : view === "overdue" ? await listPayouts(c.env.DB, { overdue: true }) : (await listPayouts(c.env.DB)).filter((p) => p.status !== "voided");
  const esc = (v) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const header = ["payout_id", "lead_id", "clinic", "state", "decision_maker", "trigger", "amount_usd", "status", "earned_at", "deposit_date", "due_at", "invoice_ref", "invoiced_at", "paid_at", "paid_ref"];
  const lines = [header.join(",")];
  for (const p of rows) {
    lines.push([p.id, p.lead_id, p.company_name, p.state, p.decision_maker_name, p.trigger, (p.amount_cents / 100).toFixed(2), p.status, p.earned_at, p.deposit_date, p.due_at, p.invoice_ref, p.invoiced_at, p.paid_at, p.paid_ref].map(esc).join(","));
  }
  return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="payouts-${view}-${new Date().toISOString().slice(0, 10)}.csv"` } });
});

const PAYOUT_NEXT = { earned: ["invoiced", "disputed", "voided"], invoiced: ["paid", "disputed", "voided"], disputed: ["earned", "voided", "paid"], paid: [], voided: [] };

// Admin-only bookkeeping on a ledger row. Keeps the lead's denormalized
// show/close_payout_status + payout_date in sync.
app.patch("/crm/api/payouts/:id", async (c) => {
  if (!isCrmAdmin(c.get("user"))) return json(c, { error: "admin only" }, 403);
  const existing = await getPayout(c.env.DB, c.req.param("id"));
  if (!existing) return json(c, { error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const to = body.status;
  if (!PAYOUT_NEXT[existing.status]?.includes(to)) return json(c, { error: `cannot move ${existing.status} → ${to}` }, 409);
  const now = new Date().toISOString();
  const fields = { status: to };
  if (to === "invoiced") { fields.invoiced_at = now; fields.invoice_ref = body.invoice_ref || existing.invoice_ref || null; }
  if (to === "paid") { fields.paid_at = body.paid_at || now; fields.paid_ref = body.paid_ref || null; }
  if (to === "voided") fields.voided_reason = body.voided_reason || null;
  const payout = await updatePayout(c.env.DB, existing.id, fields);
  const col = existing.trigger === "qualified_show" ? "show_payout_status" : "close_payout_status";
  const leadFields = { [col]: to };
  if (to === "paid") leadFields.payout_date = fields.paid_at;
  await updateLead(c.env.DB, existing.lead_id, leadFields);
  await logLeadEvent(c.env.DB, existing.lead_id, { type: "payout_status_changed", payload: { payoutId: payout.id, from: existing.status, to }, actorEmail: c.get("user").email });
  return json(c, { payout });
});

// ── onboarding review queue (Phase 2 — AI-generated plans awaiting a human;
//    see worker/lib/onboardingService.js and
//    ~/.claude/plans/goldplanner-adaptive-onboarding.md) ───────────────────────
app.get("/crm/api/onboarding/plans", async (c) => {
  const plans = await listPlans(c.env.DB, { status: c.req.query("status") || undefined });
  return json(c, { plans });
});

app.get("/crm/api/onboarding/plans/:id", async (c) => {
  const found = await getPlanWithSteps(c.env.DB, c.req.param("id"));
  if (!found) return json(c, { error: "not found" }, 404);
  return json(c, found);
});

app.post("/crm/api/onboarding/plans/:id/steps", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || "").trim();
  if (!title) return json(c, { error: "title is required" }, 400);
  const step = await addStep(c.env.DB, c.req.param("id"), { ...body, title });
  if (!step) return json(c, { error: "plan not found" }, 404);
  return json(c, { step }, 201);
});

app.patch("/crm/api/onboarding/plans/:id/steps/:stepId", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const step = await updateStep(c.env.DB, c.req.param("id"), c.req.param("stepId"), body);
  if (!step) return json(c, { error: "not found" }, 404);
  return json(c, { step });
});

app.delete("/crm/api/onboarding/plans/:id/steps/:stepId", async (c) => {
  await deleteStep(c.env.DB, c.req.param("id"), c.req.param("stepId"));
  return json(c, { ok: true });
});

app.post("/crm/api/onboarding/plans/:id/approve", async (c) => {
  const result = await approvePlan(c.env.DB, c.req.param("id"), c.get("user").email);
  if (!result) return json(c, { error: "not found" }, 404);
  return json(c, result);
});

// ── sales ────────────────────────────────────────────────────────────────
// ── Business Specialist Copilot ─────────────────────────────────────────
app.post("/crm/api/leads/:id/ask", async (c) => {
  const leadId = c.req.param("id");
  const lead = await getLead(c.env.DB, leadId);
  if (!lead) return json(c, { error: "not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const questionText = String(body.questionText || "").trim();
  if (!questionText) return json(c, { error: "questionText is required" }, 400);
  const answer = await askBusinessSpecialist(c.env, { lead, questionText });
  const question = await logLeadQuestion(c.env.DB, { leadId, askedByEmail: c.get("user").email, questionText, answer });
  return json(c, { question });
});

app.post("/crm/api/leads/:id/suggest", async (c) => {
  const leadId = c.req.param("id");
  const lead = await getLead(c.env.DB, leadId);
  if (!lead) return json(c, { error: "not found" }, 404);
  const answer = await suggestBusinessSpecialist(c.env, { lead });
  const question = await logLeadQuestion(c.env.DB, { leadId, askedByEmail: c.get("user").email, questionText: null, answer });
  return json(c, { question });
});

app.get("/crm/api/leads/:id/questions", async (c) => {
  const questions = await listLeadQuestions(c.env.DB, c.req.param("id"));
  return json(c, { questions });
});

app.post("/crm/api/questions/:id/approve", async (c) => {
  const question = await getLeadQuestion(c.env.DB, c.req.param("id"));
  if (!question) return json(c, { error: "not found" }, 404);
  await approveLeadQuestion(c.env.DB, question.id);
  await promoteQuestionToFaq(c.env.DB, question);
  return json(c, { ok: true });
});

// ── knowledge base ───────────────────────────────────────────────────────
app.get("/crm/api/kb/documents", async (c) => {
  const documents = await listKbDocuments(c.env.DB);
  return json(c, { documents });
});

app.post("/crm/api/kb/documents", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || "").trim();
  if (!title) return json(c, { error: "title is required" }, 400);
  const document = await createKbDocument(c.env.DB, {
    tier: ["source_of_truth", "case_study", "faq"].includes(body.tier) ? body.tier : "source_of_truth",
    topic: body.topic || null,
    title,
    content: body.content || null,
    createdBy: c.get("user").email,
  });
  return json(c, { document }, 201);
});

app.post("/crm/api/kb/documents/:id/archive", async (c) => {
  await archiveKbDocument(c.env.DB, c.req.param("id"));
  return json(c, { ok: true });
});

// ── wa-links (WhatsApp/URL short-link manager) ──────────────────────────
app.get("/crm/api/wa-links", async (c) => json(c, { links: await listWaLinks(c.env.DB) }));

app.post("/crm/api/wa-links", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const link = await createWaLink(c.env.DB, { ...body, actor: c.get("user").email });
    return json(c, { link }, 201);
  } catch (e) {
    return json(c, { error: e.message }, 400);
  }
});

app.patch("/crm/api/wa-links/:slug", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const link = await updateWaLink(c.env.DB, c.req.param("slug"), body);
    return json(c, { link });
  } catch (e) {
    return json(c, { error: e.message }, 400);
  }
});

app.delete("/crm/api/wa-links/:slug", async (c) => json(c, await deleteWaLink(c.env.DB, c.req.param("slug"))));

// Public, unauthenticated resolve — called by the go.goldplanner.clubemkt.digital
// redirector Worker for every visit. Deliberately outside the
// /crm/api/wa-links* prefix (see requireCrm registrations above) so it
// isn't gated behind a session, same pattern as /crm/api/public/leads.
app.get("/crm/api/public/wa-links/resolve/:slug", async (c) => {
  const link = await resolveWaLink(c.env.DB, c.req.param("slug"));
  if (!link) return json(c, { error: "not found" }, 404);
  return json(c, link);
});

// ── wa-numbers (saved quick-pick numbers for the link creator) ─────────
app.get("/crm/api/wa-numbers", async (c) => json(c, { numbers: await listWaNumbers(c.env.DB) }));

app.post("/crm/api/wa-numbers", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const number = await createWaNumber(c.env.DB, body);
    return json(c, { number }, 201);
  } catch (e) {
    return json(c, { error: e.message }, 400);
  }
});

app.delete("/crm/api/wa-numbers/:id", async (c) => json(c, await deleteWaNumber(c.env.DB, c.req.param("id"))));

// ── settings (admin-editable, currently just the revenue goal) ─────────
app.get("/crm/api/settings/revenue-goal", async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM crm_settings WHERE key = 'revenue_goal'").first();
  return json(c, { revenueGoal: row ? Number(row.value) || 0 : 0 });
});

app.put("/crm/api/settings/revenue-goal", async (c) => {
  if (!isCrmAdmin(c.get("user"))) return json(c, { error: "Admins only." }, 403);
  const body = await c.req.json().catch(() => ({}));
  const value = String(Number(body.revenueGoal) || 0);
  await c.env.DB.prepare(
    `INSERT INTO crm_settings (key, value, updated_by) VALUES ('revenue_goal', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`
  )
    .bind(value, c.get("user").email)
    .run();
  return json(c, { revenueGoal: Number(value) });
});

// ── dashboard ────────────────────────────────────────────────────────────
app.get("/crm/api/dashboard", async (c) => {
  const db = c.env.DB;
  const [leads, payouts, startedRow, emailStats, recentEmailEvents, touchesList] = await Promise.all([
    listLeads(db),
    listPayouts(db),
    db.prepare("SELECT value FROM crm_settings WHERE key = 'pilot_started_at'").first(),
    db.prepare(`
      SELECT 
        COUNT(*) as total_sent,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as total_opened,
        SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) as total_bounced
      FROM outreach_touches
    `).first().catch(() => ({ total_sent: 0, total_opened: 0, total_bounced: 0 })),
    db.prepare(`
      SELECT le.*, l.company_name, l.verified_email 
      FROM lead_events le 
      LEFT JOIN leads l ON l.id = le.lead_id 
      WHERE le.type IN ('email_opened', 'link_clicked', 'email_bounced', 'email_sent') 
      ORDER BY le.created_at DESC LIMIT 15
    `).all().catch(() => ({ results: [] })),
    db.prepare(`
      SELECT 
        SUM(CASE WHEN channel='email' AND direction='outbound' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
        SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) as bounced
      FROM outreach_touches
    `).first().catch(() => ({ sent: 0, opened: 0, bounced: 0 }))
  ]);

  const emailMetrics = {
    sent: emailStats?.total_sent || touchesList?.sent || 0,
    opened: emailStats?.total_opened || touchesList?.opened || 0,
    bounced: emailStats?.total_bounced || touchesList?.bounced || 0,
    openRatePct: (emailStats?.total_sent || touchesList?.sent || 0) > 0 
      ? Math.round(((emailStats?.total_opened || touchesList?.opened || 0) / (emailStats?.total_sent || touchesList?.sent || 1)) * 1000) / 10 
      : 0,
    recentEvents: recentEmailEvents?.results || []
  };

  const byStatus = {};
  for (const s of VALID_STATUSES) byStatus[s] = 0;
  for (const l of leads) byStatus[l.status] = (byStatus[l.status] || 0) + 1;

  // Funnel counts are cumulative "reached at least this stage", read from
  // the per-stage timestamps rather than the current status, so a lead that
  // moved on (or was lost after replying) still counts where it got to.
  const count = (pred) => leads.filter(pred).length;
  const funnel = {
    sourced: leads.length,
    approved: count((l) => l.approved_for_outreach),
    contacted: count((l) => l.first_contacted_at),
    replied: count((l) => l.replied_at),
    call_scheduled: count((l) => l.call_scheduled_for),
    qualified_show: count((l) => l.call_held_at),
    closed_won: count((l) => l.closed_at),
    lost: byStatus.lost,
  };
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

  const totals = { earned: 0, invoiced: 0, paid: 0, disputed: 0, voided: 0 };
  for (const p of payouts) totals[p.status] = (totals[p.status] || 0) + p.amount_cents;
  const outstandingCents = totals.earned + totals.invoiced;
  const buckets = payoutBuckets(payouts, await payoutNetDays(db));

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const kpi = {
    totalLeads: leads.length,
    loaded: leads.length,
    pendingReview: count((l) => l.status === "sourced" && !l.approved_for_outreach),
    rejected: count((l) => l.status === "lost" && l.lost_reason === "not_icp"),
    booked: funnel.call_scheduled,
    approved: funnel.approved,
    contacted: funnel.contacted,
    replyRatePct: pct(funnel.replied, funnel.contacted),
    bookRatePct: pct(funnel.call_scheduled, funnel.contacted),
    showRatePct: pct(funnel.qualified_show, funnel.call_scheduled),
    closeRatePct: pct(funnel.closed_won, funnel.qualified_show),
    shows: funnel.qualified_show,
    closes: funnel.closed_won,
    leadsLast30d: count((l) => l.created_at >= thirtyDaysAgo),
    earnedCents: totals.earned + totals.invoiced + totals.paid,
    paidCents: totals.paid,
    outstandingCents,
    ...buckets,
  };

  const tally = (keyFn) => {
    const m = {};
    for (const l of leads) { const k = keyFn(l) || "unknown"; m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const bySource = tally((l) => l.source_platform).map(([source, count]) => ({ source, count }));
  const byState = tally((l) => l.state).map(([state, count]) => {
    const rows = leads.filter((l) => (l.state || "unknown") === state);
    return {
      state,
      count,
      approved: rows.filter((l) => l.approved_for_outreach).length,
      contacted: rows.filter((l) => l.first_contacted_at).length,
      replied: rows.filter((l) => l.replied_at).length,
      booked: rows.filter((l) => l.call_scheduled_for || l.call_held_at).length,
      shows: rows.filter((l) => l.call_held_at).length,
      closes: rows.filter((l) => l.closed_at).length,
      rejected: rows.filter((l) => l.status === "lost" && l.lost_reason === "not_icp").length,
    };
  });
  const byBatch = tally((l) => l.batch_id).map(([batch, count]) => ({ batch, count }));

  const closerStats = {};
  const bump = (name) => (closerStats[name] ??= { closer: name, leads: 0, shows: 0, closes: 0 });
  for (const l of leads) {
    const stat = bump(l.closer_name || l.assigned_closer_email || "Unassigned");
    stat.leads++;
    if (l.call_held_at) stat.shows++;
    if (l.closed_at) stat.closes++;
  }
  const byCloser = Object.values(closerStats).sort((a, b) => b.leads - a.leads).slice(0, 8);

  const upcomingCalls = leads
    .filter((l) => l.status === "call_scheduled" && l.call_scheduled_for)
    .sort((a, b) => a.call_scheduled_for.localeCompare(b.call_scheduled_for))
    .slice(0, 10)
    .map((l) => ({ id: l.id, company_name: l.company_name, decision_maker_name: l.decision_maker_name, state: l.state, call_scheduled_for: l.call_scheduled_for }));

  return json(c, {
    pilotStartedAt: startedRow?.value || null,
    kpi,
    funnel,
    leadsByStatus: byStatus,
    payoutTotals: totals,
    bySource,
    byState,
    byBatch,
    byCloser,
    upcomingCalls,
    totalLeads: leads.length,
    emailMetrics,
  });
});

// ── everything else (auth API, static assets, SPA shell) — same compiled
// backend as goldplanner-hub/goldplanner-portal, prefix stripped the same way.
//
// The CRM no longer has its own full-page frontend — Dashboard/Pipeline/
// Vendas live inside the Hub as CrmPanel, and Links as its own Hub panel
// (see src/App.jsx). This Worker + all the /crm/api/* routes above stay
// alive since those panels still call crmApi.js, which is hardcoded to hit
// /crm/api/*. A direct page visit to /crm (or any of its old sub-routes)
// now just bounces to /hub instead of serving the retired standalone SPA.
app.all("*", async (c) => {
  const url = new URL(c.req.url);
  const isApi = url.pathname === "/crm/api" || url.pathname.startsWith("/crm/api/");
  if (!isApi && c.req.method === "GET") {
    return Response.redirect(new URL("/hub", url).toString(), 302);
  }
  if (url.pathname === "/crm" || url.pathname.startsWith("/crm/")) {
    url.pathname = url.pathname.slice("/crm".length) || "/";
  }
  const pagesHandler = await loadPagesHandler();
  return pagesHandler.fetch(new Request(url, c.req.raw), c.env, c.executionCtx);
});

export default app;
