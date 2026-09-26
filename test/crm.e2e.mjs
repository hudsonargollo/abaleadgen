// End-to-end exercise of the ABA pipeline routes: real Hono app, real SQL
// (better-sqlite3 behind a minimal D1 shim), all 28 migrations, a real
// signed session. Run: npm run test:crm (needs: npm i -D better-sqlite3)
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { signSession } from "../functions/_lib/session.js";
import app from "../worker/crm-entry.js";

// ── D1 shim ──────────────────────────────────────────────────────────────
const sqlite = new Database(":memory:");
for (const f of readdirSync("migrations").sort()) sqlite.exec(readFileSync(`migrations/${f}`, "utf8"));
function stmt(sql, params = []) {
  const s = sqlite.prepare(sql);
  const isRead = /^\s*(select|pragma|with)/i.test(sql);
  return {
    bind: (...p) => stmt(sql, p),
    first: async () => s.get(...params) ?? null,
    all: async () => ({ results: s.all(...params) }),
    run: async () => {
      if (isRead) return { results: s.all(...params), meta: {} };
      const r = s.run(...params);
      return { meta: { changes: r.changes } };
    },
  };
}
const DB = { prepare: (sql) => stmt(sql), batch: async (stmts) => Promise.all(stmts.map((x) => x.run())) };

const SECRET = "test-secret";
const env = { DB, SESSION_SECRET: SECRET, FORM_WEBHOOK_TOKEN: "hook-token", CAL_WEBHOOK_SECRET: "cal-secret", CALENDLY_WEBHOOK_SIGNING_KEY: "cly-key" };
sqlite.prepare("INSERT INTO users (email, name, access_role, crm_role) VALUES (?, ?, 'STAFF', 'admin')").run("admin@test.io", "Admin");
sqlite.prepare("INSERT INTO users (email, name, access_role, crm_role) VALUES (?, ?, 'STAFF', 'closer')").run("closer@test.io", "Closer");
const adminTok = await signSession(SECRET, "admin@test.io");
const closerTok = await signSession(SECRET, "closer@test.io");

async function call(method, path, body, { as = "admin", headers = {} } = {}) {
  const tok = as === "admin" ? adminTok : as === "closer" ? closerTok : null;
  const res = await app.fetch(
    new Request(`https://x.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...(tok ? { cookie: `tk_session=${tok}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    { waitUntil() {}, passThroughOnException() {} }
  );
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

let n = 0;
const ok = (name) => console.log(`  ✓ ${++n} ${name}`);

// ── 1. auth gate
assert.equal((await call("GET", "/crm/api/leads", null, { as: null })).status, 401);
ok("unauthenticated → 401");

// ── 2. dry run writes nothing, reports everything
const rows = [
  { company_name: "Bright Path ABA", website: "https://www.BrightPathABA.com/about", city: "Austin", state: "Texas", decision_maker_name: "Jane Doe", decision_maker_title: "Founder", verified_email: "Jane@BrightPathABA.com", source_platform: "aba_index", locations_count: "2" },
  { company_name: "Dup Domain", website: "brightpathaba.com" },
  { company_name: "Dup Email", website: "other.com", verified_email: "jane@brightpathaba.com" },
  { company_name: "Sunrise Behavior", website: "sunrisebehavior.org", state: "FL", verified_email: "owner@sunrisebehavior.org", source_platform: "google_maps" },
  { website: "" },
  { company_name: "Role Mail", website: "rolemail.com", state: "ca", verified_email: "info@rolemail.com" },
  { company_name: "Bad State", website: "badstate.com", state: "Ontario" },
];
let dry = await call("POST", "/crm/api/leads/import", { batch_id: "pilot-01", rows, dry_run: true });
assert.equal(dry.status, 200);
assert.equal(dry.json.dry_run, true);
assert.equal(dry.json.created, 0);
assert.deepEqual([dry.json.summary.total, dry.json.summary.valid, dry.json.summary.errors, dry.json.summary.duplicates], [7, 3, 2, 2]);
assert.equal(sqlite.prepare("SELECT count(*) c FROM leads").get().c, 0, "dry run must not write");
assert.ok(dry.json.rows[5].warnings.some((w) => w.code === "role_based_email"));
assert.equal(dry.json.rows[5].lead.email_verification_status, "risky");
assert.ok(dry.json.rows[6].errors.some((e) => e.code === "invalid_state"));
ok("import dry_run: full report, zero writes, role-email + bad-state flagged");

// ── 2b. commit imports only the valid rows
const imp = await call("POST", "/crm/api/leads/import", { batch_id: "pilot-01", rows });
assert.equal(imp.status, 201);
assert.equal(imp.json.created, 3);
assert.equal(imp.json.skipped.length, 4);
assert.equal(imp.json.rows.filter((r) => r.leadId).length, 3);
ok("import commit: 3 created (incl. risky role email), dup domain/email + empty + bad state skipped");

// ── 2c. re-running the same file is a no-op (DB dedup), and CSV bodies work
const again = await call("POST", "/crm/api/leads/import", { batch_id: "pilot-01", rows, dry_run: true });
assert.equal(again.json.summary.valid, 0);
assert.equal(again.json.summary.duplicates, 5);
assert.ok(again.json.rows[0].errors.some((e) => e.code === "duplicate_domain_in_db"));
const csvRes = await app.fetch(
  new Request("https://x.test/crm/api/leads/import?batch_id=pilot-02&source=apollo&dry_run=1", {
    method: "POST",
    headers: { "content-type": "text/csv", cookie: `tk_session=${adminTok}` },
    body: 'Company,Website,State,Email\n"Acme ABA, LLC",acmeaba.com,"NC",jo@acmeaba.com\nBright Path,brightpathaba.com,TX,\n',
  }),
  env,
  {}
);
const csvJson = await csvRes.json();
assert.equal(csvJson.summary.valid, 1);
assert.equal(csvJson.summary.duplicates, 1);
assert.equal(csvJson.rows[0].lead.source_platform, "apollo");
assert.equal(csvJson.rows[0].lead.batch_id, "pilot-02");
// reject_role_emails turns the warning into an error
const strict = await call("POST", "/crm/api/leads/import", { rows: [{ company_name: "R", website: "r-clinic.com", verified_email: "support@r-clinic.com" }], dry_run: true, reject_role_emails: true });
assert.equal(strict.json.summary.errors, 1);
ok("re-import is a no-op via DB dedup; text/csv body + query opts; reject_role_emails");

const [id1, id2, id3] = imp.json.ids;
let lead = (await call("GET", `/crm/api/leads/${id1}`)).json.lead;
assert.equal(lead.status, "sourced");
assert.equal(lead.website_domain, "brightpathaba.com");
assert.equal(lead.state, "TX");
assert.equal(lead.verified_email, "jane@brightpathaba.com");
assert.equal(lead.locations_count, 2);
assert.equal(lead.batch_id, "pilot-01");
ok("normalization: domain/state/email/locations/batch");

// ── 3. transition guard: cannot leave sourced before approval
let r = await call("PATCH", `/crm/api/leads/${id1}/status`, { status: "contacted" });
assert.equal(r.status, 409);
assert.match(r.json.error, /approved/);
ok("sourced → contacted refused before approval");

// ── 4. approval is admin-only, moves to queued
r = await call("POST", "/crm/api/leads/approve", { ids: [id1, id2] }, { as: "closer" });
assert.equal(r.status, 403);
r = await call("POST", "/crm/api/leads/approve", { ids: [id1, id2], batch_id: "pilot-01" });
assert.equal(r.json.approved, 2);
lead = (await call("GET", `/crm/api/leads/${id1}`)).json.lead;
assert.equal(lead.status, "queued");
assert.equal(lead.approved_for_outreach, 1);
ok("approve: closer 403, admin moves sourced → queued");

// ── 5. touch log auto-advances queued → contacted, reply → replied
r = await call("POST", `/crm/api/leads/${id1}/touches`, { channel: "email", subject: "Intro", sending_domain: "mail.acme.co" }, { as: "closer" });
assert.equal(r.status, 201);
assert.equal(r.json.lead.status, "contacted");
assert.equal(r.json.lead.sequence_step, 1);
assert.ok(r.json.lead.first_contacted_at);
r = await call("POST", `/crm/api/leads/${id1}/touches`, { channel: "email", direction: "inbound", subject: "Re: Intro", reply_sentiment: "positive" }, { as: "closer" });
assert.equal(r.json.lead.status, "replied");
assert.ok(r.json.lead.replied_at);
ok("touches: outbound → contacted (step 1), inbound → replied");

// ── 6. call_scheduled requires a datetime; forward skip allowed
r = await call("PATCH", `/crm/api/leads/${id1}/status`, { status: "call_scheduled" });
assert.equal(r.status, 409);
r = await call("PATCH", `/crm/api/leads/${id1}/status`, { status: "call_scheduled", callScheduledFor: "2026-09-10T15:00:00.000Z" });
assert.equal(r.status, 200);
assert.equal(r.json.lead.call_scheduled_for, "2026-09-10T15:00:00.000Z");
ok("call_scheduled: datetime required; replied → call_scheduled (skipping form_completed) allowed");

// ── 7. backward move: closer refused, admin needs force
r = await call("PATCH", `/crm/api/leads/${id1}/status`, { status: "contacted" }, { as: "closer" });
assert.equal(r.status, 409);
r = await call("PATCH", `/crm/api/leads/${id1}/status`, { status: "contacted", force: true }, { as: "closer" });
assert.equal(r.status, 409, "closer cannot force");
r = await call("PATCH", `/crm/api/leads/${id1}/status`, { status: "contacted", force: true });
assert.equal(r.status, 200);
r = await call("PATCH", `/crm/api/leads/${id1}/status`, { status: "call_scheduled", callScheduledFor: "2026-09-10T15:00:00.000Z" });
ok("backward move: refused for closer (even with force), admin force works");

// ── 8. qualified_show earns $50 exactly once
r = await call("PATCH", `/crm/api/leads/${id1}/status`, { status: "qualified_show" }, { as: "closer" });
assert.equal(r.status, 200);
assert.equal(r.json.payout.amount_cents, 5000);
assert.equal(r.json.lead.show_payout_status, "earned");
assert.ok(r.json.lead.call_held_at);
// admin drags back and forward again → no second payout
await call("PATCH", `/crm/api/leads/${id1}/status`, { status: "call_scheduled", force: true, callScheduledFor: "2026-09-10T15:00:00.000Z" });
r = await call("PATCH", `/crm/api/leads/${id1}/status`, { status: "qualified_show" });
assert.equal(r.json.payout, null);
let pay = (await call("GET", "/crm/api/payouts")).json;
assert.equal(pay.payouts.length, 1);
assert.equal(pay.totals.earned, 5000);
ok("qualified_show: $50 earned once, re-entry idempotent");

// ── 9. closed_won earns $150, ledger totals
r = await call("PATCH", `/crm/api/leads/${id1}/status`, { status: "closed_won" });
assert.equal(r.json.payout.amount_cents, 15000);
assert.equal(r.json.lead.close_payout_status, "earned");
assert.equal(r.json.automation, null, "won automation stays off unless WON_AUTOMATION=1");
pay = (await call("GET", "/crm/api/payouts")).json;
assert.equal(pay.totals.earned, 20000);
ok("closed_won: $150 earned, totals $200, won-automation off");

// ── 10. payout bookkeeping syncs the lead row
const showPayout = pay.payouts.find((p) => p.trigger === "qualified_show");
r = await call("PATCH", `/crm/api/payouts/${showPayout.id}`, { status: "paid" }, { as: "closer" });
assert.equal(r.status, 403);
r = await call("PATCH", `/crm/api/payouts/${showPayout.id}`, { status: "paid" });
assert.equal(r.status, 409, "earned → paid must go through invoiced");
r = await call("PATCH", `/crm/api/payouts/${showPayout.id}`, { status: "invoiced", invoice_ref: "INV-7" });
assert.equal(r.json.payout.invoice_ref, "INV-7");
r = await call("PATCH", `/crm/api/payouts/${showPayout.id}`, { status: "paid", paid_ref: "stripe_123" });
assert.equal(r.json.payout.status, "paid");
lead = (await call("GET", `/crm/api/leads/${id1}`)).json.lead;
assert.equal(lead.show_payout_status, "paid");
assert.ok(lead.payout_date);
assert.equal(lead.close_payout_status, "earned");
ok("payout: admin-only, earned→invoiced→paid enforced, lead row synced");

// ── 11. lost from anywhere; reopen needs force
r = await call("PATCH", `/crm/api/leads/${id2}/status`, { status: "lost", lostReason: "bounced" }, { as: "closer" });
assert.equal(r.json.lead.status, "lost");
assert.equal(r.json.lead.lost_reason, "bounced");
r = await call("PATCH", `/crm/api/leads/${id2}/status`, { status: "queued" }, { as: "closer" });
assert.equal(r.status, 409);
r = await call("PATCH", `/crm/api/leads/${id2}/status`, { status: "queued", force: true });
assert.equal(r.status, 200);
ok("lost: any stage → lost; reopen requires admin force");

// ── 12. public form webhook
r = await call("POST", "/crm/api/public/form-completed", { email: "owner@sunrisebehavior.org" }, { as: null });
assert.equal(r.status, 401);
r = await call("POST", "/crm/api/public/form-completed", { email: "nobody@x.com" }, { as: null, headers: { authorization: "Bearer hook-token" } });
assert.equal(r.status, 202);
assert.equal(r.json.matched, false);
r = await call("POST", "/crm/api/public/form-completed", { email: "owner@sunrisebehavior.org", answers: { q1: "yes" } }, { as: null, headers: { authorization: "Bearer hook-token" } });
assert.equal(r.json.moved, true);
assert.equal(r.json.lead.status, "form_completed");
ok("form webhook: token gate, unmatched 202, matched → form_completed");

// ── 12b. public intake form (/aba) — lid match, email match, new inbound, guards
r = await call("POST", "/crm/api/public/intake", {
  answers: { locations: "2-3", capacity: "full_waitlist", priority: "commercial_private", timeline: "30_days" },
  contact: { name: "Rae Mail", clinic: "Role Mail Clinic", email: "rae@rolemail.com", phone: "555-0100", state: "california", website: "rolemail.com" },
  attribution: { lid: id3, utm_source: "cold_email", utm_medium: "email", utm_campaign: "pilot-01", utm_content: "step2", landing_path: "/aba?lid=x" },
}, { as: null });
assert.equal(r.status, 201);
assert.equal(r.json.matched, "lid");
assert.equal(r.json.status, "form_completed", "forced past the sourced/approval gate");
lead = (await call("GET", `/crm/api/leads/${id3}`)).json.lead;
assert.equal(lead.approved_for_outreach, 1);
assert.equal(lead.utm_campaign, "pilot-01");
assert.equal(lead.verified_email, "info@rolemail.com", "sourced email is never overwritten by form data");
assert.equal(lead.decision_maker_name, "Rae Mail", "empty fields are enriched");
assert.equal(lead.locations_count, 2);
const q = JSON.parse(lead.qualification);
assert.equal(q.source, "aba_intake_form");
assert.equal(q.answers.priority, "commercial_private");
assert.equal(q.attribution.utm_content, "step2");
assert.equal(q.attribution.lid, id3);
ok("intake: lid match → form_completed, approval forced, answers+UTMs stored, sourced data preserved");

r = await call("POST", "/crm/api/public/intake", {
  answers: { locations: "1", capacity: "open_now", priority: "fill_waitlist", timeline: "exploring" },
  contact: { name: "New Owner", clinic: "Fresh Start ABA", email: "owner@freshstartaba.com", state: "GA" },
  attribution: { utm_source: "linkedin", utm_campaign: "pilot-02" },
}, { as: null });
assert.equal(r.json.matched, "new");
const inbound = (await call("GET", `/crm/api/leads/${r.json.leadId}`)).json.lead;
assert.equal(inbound.status, "form_completed");
assert.equal(inbound.company_name, "Fresh Start ABA");
assert.equal(inbound.state, "GA");
assert.equal(inbound.batch_id, "pilot-02");
assert.equal(inbound.source_platform, "other");
assert.equal(inbound.email_verification_status, "risky", "owner@ is role-based → risky");
assert.equal(inbound.approved_for_outreach, 1);
ok("intake: unknown visitor → inbound lead created at form_completed with campaign as batch");

r = await call("POST", "/crm/api/public/intake", { contact: { name: "X", clinic: "Y", email: "not-an-email" }, answers: {} }, { as: null });
assert.equal(r.status, 400);
r = await call("POST", "/crm/api/public/intake", { company_fax: "bot", contact: { name: "X", clinic: "Y", email: "bot@x.com" } }, { as: null });
assert.equal(r.status, 200);
assert.equal(sqlite.prepare("SELECT count(*) c FROM leads WHERE verified_email='bot@x.com'").get().c, 0);
ok("intake: invalid email 400; honeypot swallowed without a write");

// ── 12c. booking webhook — Cal.com shape (metadata.lead_id), Calendly shape (utm_content lid:), reschedule
r = await call("POST", "/crm/api/public/form-completed", {
  triggerEvent: "BOOKING_CREATED",
  payload: { attendees: [{ email: "rae@rolemail.com" }], startTime: "2026-09-15T16:00:00Z", metadata: { lead_id: id3 } },
}, { as: null, headers: { authorization: "Bearer hook-token" } });
assert.equal(r.json.moved, true);
assert.equal(r.json.lead.status, "call_scheduled");
assert.equal(r.json.lead.call_scheduled_for, "2026-09-15T16:00:00.000Z");
r = await call("POST", "/crm/api/public/form-completed", {
  triggerEvent: "BOOKING_RESCHEDULED",
  payload: { attendees: [{ email: "rae@rolemail.com" }], startTime: "2026-09-16T16:00:00Z", metadata: { lead_id: id3 } },
}, { as: null, headers: { authorization: "Bearer hook-token" } });
assert.equal(r.json.rescheduled, true);
assert.equal(r.json.lead.call_scheduled_for, "2026-09-16T16:00:00.000Z");
assert.equal(r.json.lead.status, "call_scheduled");
r = await call("POST", "/crm/api/public/form-completed", {
  event: "invitee.created",
  payload: { email: "someone-else@x.com", scheduled_event: { start_time: "2026-09-20T15:00:00Z" }, tracking: { utm_content: `lid:${inbound.id}` } },
}, { as: null, headers: { authorization: "Bearer hook-token" } });
assert.equal(r.json.moved, true);
assert.equal(r.json.lead.id, inbound.id, "Calendly: matched by lid in utm_content even when the booking email differs");
assert.equal(r.json.lead.status, "call_scheduled");
r = await call("POST", "/crm/api/public/form-completed", { triggerEvent: "MEETING_ENDED", payload: {} }, { as: null, headers: { authorization: "Bearer hook-token" } });
assert.equal(r.json.ignored, true);
ok("booking webhook: Cal.com create + reschedule, Calendly lid match, non-booking events ignored");

// ── 12d. pilot: signed webhooks, idempotency, cancellation
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const rawHook = async (body, headers) => {
  const raw = JSON.stringify(body);
  const res = await app.fetch(new Request("https://x.test/crm/api/webhooks/booking", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw }), env, {});
  return { status: res.status, json: await res.json().catch(() => null) };
};
// fresh lead for the pilot flow
const pilot = (await call("POST", "/crm/api/leads", { company_name: "Pilot Clinic", website: "pilotclinic.com", state: "TX", verified_email: "dr@pilotclinic.com" })).json.lead;
await call("POST", "/crm/api/leads/approve", { ids: [pilot.id], batch_id: "pilot-01" });
const calBody = { triggerEvent: "BOOKING_CREATED", payload: { uid: "cal_abc", attendees: [{ email: "dr@pilotclinic.com" }], startTime: "2026-09-12T15:00:00Z", metadata: { lead_id: pilot.id } } };
r = await rawHook(calBody, { "x-cal-signature-256": "deadbeef" });
assert.equal(r.status, 401, "bad Cal.com signature rejected");
r = await rawHook(calBody, {});
assert.equal(r.status, 401, "no auth rejected");
r = await rawHook(calBody, { "x-cal-signature-256": await hmacHex("cal-secret", JSON.stringify(calBody)) });
assert.equal(r.status, 200);
assert.equal(r.json.via, "cal.com");
assert.equal(r.json.result, "processed");
assert.equal(r.json.lead.status, "call_scheduled");
assert.equal(r.json.lead.booking_provider, "cal.com");
assert.equal(r.json.lead.booking_external_id, "cal_abc");
ok("Cal.com HMAC: forged/missing rejected, valid → call_scheduled (auto-advance)");

r = await rawHook(calBody, { "x-cal-signature-256": await hmacHex("cal-secret", JSON.stringify(calBody)) });
assert.equal(r.json.duplicate, true, "redelivery is a no-op");
const evCountBefore = sqlite.prepare("SELECT count(*) c FROM lead_events WHERE lead_id = ? AND type = 'call_booked'").get(pilot.id).c;
assert.equal(evCountBefore, 1);
ok("idempotency: same (provider, uid, event) delivered twice → one booking event");

const ts = Math.floor(Date.now() / 1000);
const clyBody = { event: "invitee.canceled", payload: { uri: "https://api.calendly.com/scheduled_events/E1/invitees/I1", email: "dr@pilotclinic.com", scheduled_event: { uri: "https://api.calendly.com/scheduled_events/E1" } } };
r = await rawHook(clyBody, { "calendly-webhook-signature": `t=${ts},v1=${await hmacHex("cly-key", `${ts}.${JSON.stringify(clyBody)}`)}` });
assert.equal(r.json.via, "calendly");
assert.equal(r.json.result, "cancelled");
assert.equal(r.json.lead.status, "replied", "cancelled call drops back to replied");
assert.equal(r.json.lead.call_scheduled_for, null);
assert.equal(sqlite.prepare("SELECT count(*) c FROM lead_events WHERE lead_id = ? AND type = 'call_cancelled'").get(pilot.id).c, 1);
r = await rawHook(clyBody, { "calendly-webhook-signature": `t=${ts - 3600},v1=${await hmacHex("cly-key", `${ts - 3600}.${JSON.stringify(clyBody)}`)}` });
assert.equal(r.status, 401, "stale Calendly signature (replay) rejected");
ok("Calendly signature + cancellation → replied, replay window enforced");

// rebook via generic/internal booking with external id, then test milestones
r = await call("POST", "/crm/api/webhooks/booking", { lead_id: pilot.id, scheduled_for: "2026-09-14T15:00:00Z", external_id: "internal-77" }, { as: null, headers: { authorization: "Bearer hook-token" } });
assert.equal(r.json.result, "processed");
assert.equal(r.json.lead.status, "call_scheduled");
const evs = (await call("GET", "/crm/api/webhooks/events")).json.events;
assert.ok(evs.length >= 4);
assert.ok(evs.some((e) => e.result === "duplicate" || e.result === "cancelled"));
ok("generic/internal booking with external_id; webhook audit log readable by admin");

// ── 12e. milestone toggles + net-7 due dates
r = await call("POST", `/crm/api/leads/${pilot.id}/milestone`, { milestone: "closed_won", on: true, deposit_date: "2026-09-15" }, { as: "closer" });
assert.equal(r.status, 409, "closer cannot skip the show milestone");
r = await call("POST", `/crm/api/leads/${pilot.id}/milestone`, { milestone: "qualified_show", on: true }, { as: "closer" });
assert.equal(r.status, 200);
assert.equal(r.json.payout.amount_cents, 5000);
assert.equal(r.json.lead.status, "qualified_show");
assert.ok(r.json.lead.show_confirmed_at);
assert.equal(r.json.lead.show_confirmed_by, "closer@test.io");
const showDue = new Date(r.json.payout.due_at).getTime() - new Date(r.json.payout.earned_at).getTime();
assert.equal(Math.round(showDue / 86400000), 7, "$50 due 7 days after the show is confirmed");
r = await call("POST", `/crm/api/leads/${pilot.id}/milestone`, { milestone: "qualified_show", on: true }, { as: "closer" });
assert.equal(r.status, 409, "already recorded");
ok("qualified show toggle: $50 earned once, due_at = +7d, confirmed_by stamped");

r = await call("POST", `/crm/api/leads/${pilot.id}/milestone`, { milestone: "closed_won", on: true }, { as: "closer" });
assert.equal(r.status, 400, "deposit_date required");
r = await call("POST", `/crm/api/leads/${pilot.id}/milestone`, { milestone: "closed_won", on: true, deposit_date: "2026-09-05", deposit_amount_cents: 250000 }, { as: "closer" });
assert.equal(r.status, 200);
assert.equal(r.json.payout.amount_cents, 15000);
assert.equal(r.json.payout.deposit_date.slice(0, 10), "2026-09-05");
assert.equal(r.json.payout.earned_at.slice(0, 10), "2026-09-05", "$150 clock starts on deposit date");
assert.equal(r.json.payout.due_at.slice(0, 10), "2026-09-12");
assert.equal(r.json.lead.deposit_amount_cents, 250000);
assert.equal(r.json.lead.status, "closed_won");
ok("closed won toggle: deposit date logged, $150 earned from deposit date, due +7d");

// due / overdue buckets (today is 2026-09-07 in the sandbox clock: the $150 due 09-12 is 'due soon'; make it overdue by backdating)
pay = (await call("GET", "/crm/api/payouts")).json;
assert.equal(pay.netDays, 7);
assert.ok(pay.dueSoonCount >= 1);
let due = (await call("GET", "/crm/api/payouts/due")).json;
assert.ok(due.payouts.some((p) => p.trigger === "closed_won" && p.lead_id === pilot.id));
sqlite.prepare("UPDATE lead_payouts SET due_at = '2026-09-01T00:00:00.000Z' WHERE lead_id = ? AND trigger = 'closed_won'").run(pilot.id);
pay = (await call("GET", "/crm/api/payouts?view=overdue")).json;
assert.equal(pay.overdueCount, 1);
assert.equal(pay.payouts.length, 1);
assert.equal(pay.payouts[0].trigger, "closed_won");
const csv = await app.fetch(new Request("https://x.test/crm/api/payouts/export.csv?view=overdue", { headers: { cookie: `tk_session=${adminTok}` } }), env, {});
assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
const csvText = await csv.text();
assert.match(csvText, /^payout_id,lead_id,clinic/);
assert.match(csvText, /Pilot Clinic,TX,.*,closed_won,150\.00,earned/);
ok("payout views: due within 7 days, overdue bucket, CSV export");

// unmark = void (admin only), never delete
r = await call("POST", `/crm/api/leads/${pilot.id}/milestone`, { milestone: "closed_won", on: false, reason: "deposit bounced" }, { as: "closer" });
assert.equal(r.status, 403);
r = await call("POST", `/crm/api/leads/${pilot.id}/milestone`, { milestone: "closed_won", on: false, reason: "deposit bounced" });
assert.equal(r.status, 200);
assert.equal(r.json.lead.status, "qualified_show");
assert.equal(r.json.lead.close_payout_status, "not_earned");
assert.equal(r.json.lead.deposit_date, null);
const voided = sqlite.prepare("SELECT status, voided_reason FROM lead_payouts WHERE id = ?").get(r.json.voidedPayoutId);
assert.equal(voided.status, "voided");
assert.equal(voided.voided_reason, "deposit bounced");
assert.equal(sqlite.prepare("SELECT count(*) c FROM lead_payouts WHERE lead_id = ?").get(pilot.id).c, 2, "ledger rows are never deleted");
// re-marking after a void creates a NEW ledger row (the voided one stays for audit)
r = await call("POST", `/crm/api/leads/${pilot.id}/milestone`, { milestone: "closed_won", on: true, deposit_date: "2026-09-06" });
assert.equal(r.status, 200);
assert.equal(r.json.payout?.amount_cents, 15000, "re-earn after void");
assert.equal(sqlite.prepare("SELECT count(*) c FROM lead_payouts WHERE lead_id = ?").get(pilot.id).c, 3);
ok("unmark: admin-only, voids the ledger row with reason, steps back a stage, audit rows preserved");

const dash = (await call("GET", "/crm/api/dashboard")).json;
assert.ok("dueSoonCents" in dash.kpi && "overdueCents" in dash.kpi);
ok("dashboard exposes due-soon / overdue payout buckets");

// ── 12f. pre-launch review: reject → parked, reopen via approve, in-play leads untouched
const rev = (await call("POST", "/crm/api/leads/import", { batch_id: "pilot-03", rows: [
  { company_name: "Review A", website: "review-a.com", state: "NJ" },
  { company_name: "Review B", website: "review-b.com", state: "OH" },
] })).json.ids;
r = await call("POST", "/crm/api/leads/reject", { ids: rev, reason: "pe_backed", note: "part of a rollup" }, { as: "closer" });
assert.equal(r.status, 403);
r = await call("POST", "/crm/api/leads/reject", { ids: [rev[0], id1 || rev[1]], reason: "pe_backed" });
assert.equal(r.json.rejected, 1, "in-play lead skipped");
lead = (await call("GET", `/crm/api/leads/${rev[0]}`)).json.lead;
assert.equal(lead.status, "lost");
assert.equal(lead.lost_reason, "not_icp");
assert.equal(lead.icp_fit, "unfit");
assert.equal(lead.exclusion_reason, "pe_backed");
assert.equal(lead.approved_for_outreach, 0);
assert.equal(sqlite.prepare("SELECT count(*) c FROM lead_events WHERE lead_id = ? AND type = 'rejected'").get(rev[0]).c, 1);
r = await call("POST", "/crm/api/leads/approve", { ids: [rev[0]] });
lead = (await call("GET", `/crm/api/leads/${rev[0]}`)).json.lead;
assert.equal(lead.status, "queued", "approve reopens a rejected lead");
assert.equal(lead.icp_fit, "fit");
assert.equal(lead.lost_reason, null);
ok("review: reject (admin) parks as lost/not_icp with reason + event; approve reopens; contacted leads immune");

const d2 = (await call("GET", "/crm/api/dashboard")).json;
const nj = d2.byState.find((x) => x.state === "NJ");
assert.ok(nj && "booked" in nj && "shows" in nj && "closes" in nj && "rejected" in nj);
assert.equal(d2.kpi.loaded, d2.totalLeads);
assert.ok("pendingReview" in d2.kpi && "booked" in d2.kpi);
ok("dashboard: per-state funnel columns + loaded/pendingReview/booked KPIs");

// intake after a call is booked never moves the lead backwards
r = await call("POST", "/crm/api/public/intake", {
  answers: { locations: "2-3" }, contact: { name: "Rae", clinic: "Role Mail Clinic", email: "rae@rolemail.com" }, attribution: { lid: id3 },
}, { as: null });
assert.equal(r.json.status, "call_scheduled");
ok("intake: re-submission after booking keeps call_scheduled");

// ── 13. PATCH lead: editable fields, website renormalized, unique conflict → 409
r = await call("PATCH", `/crm/api/leads/${id2}`, { website: "https://SunriseBehavior.org/", email_verification_status: "valid", state: "fl", notes: "hi", status: "closed_won" });
assert.equal(r.json.lead.website_domain, "sunrisebehavior.org");
assert.equal(r.json.lead.state, "FL");
assert.ok(r.json.lead.email_verified_at);
assert.equal(r.json.lead.status, "form_completed", "status is not patchable here");
r = await call("PATCH", `/crm/api/leads/${id2}`, { website: "brightpathaba.com" });
assert.equal(r.status, 409);
ok("PATCH lead: whitelist, normalization, verified_at stamp, 409 on dup domain");

// ── 14. dashboard
const d = (await call("GET", "/crm/api/dashboard")).json;
assert.equal(d.totalLeads, 7);
assert.equal(d.funnel.qualified_show, 2);
assert.equal(d.funnel.closed_won, 2);
assert.equal(d.kpi.paidCents, 5000);
assert.equal(d.kpi.outstandingCents, 15000 + 5000 + 15000, "lead1 $150 + pilot $50 + pilot re-earned $150");
assert.equal(d.kpi.replyRatePct, 100);
assert.equal(d.byState.find((x) => x.state === "TX")?.count, 2);
assert.equal(d.leadsByStatus.closed_won, 2);
assert.ok(d.bySource.find((s) => s.source === "aba_index"));
ok("dashboard: funnel/kpi/payout totals");

// ── 15. delete cascades payouts + touches (gated email)
r = await call("DELETE", `/crm/api/leads/${id1}`);
assert.equal(r.status, 403, "admin@test.io is not the delete-allowed operator");
sqlite.prepare("INSERT INTO users (email, name, access_role, crm_role) VALUES (?, ?, 'ADMIN', 'admin')").run("hudsonargollo2@gmail.com", "H");
const hTok = await signSession(SECRET, "hudsonargollo2@gmail.com");
const res = await app.fetch(new Request(`https://x.test/crm/api/leads/${id1}`, { method: "DELETE", headers: { cookie: `tk_session=${hTok}` } }), env, {});
assert.equal(res.status, 200);
assert.equal(sqlite.prepare("SELECT count(*) c FROM lead_payouts WHERE lead_id = ?").get(id1).c, 0);
assert.equal(sqlite.prepare("SELECT count(*) c FROM outreach_touches WHERE lead_id = ?").get(id1).c, 0);
assert.equal(sqlite.prepare("SELECT count(*) c FROM lead_events WHERE lead_id = ?").get(id1).c, 0);
ok("delete: cascades payouts/touches/events");

console.log(`\nall ${n} checks passed`);
