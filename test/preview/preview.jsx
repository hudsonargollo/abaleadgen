// Visual harness for the ABA CRM views with the API stubbed — not shipped.
import { createRoot } from "react-dom/client";
import "@/index.css";
import CrmDashboard from "@/crm/CrmDashboard";
import CrmReview from "@/crm/CrmReview";

const P = ["TX", "FL", "CA", "NC", "CO", "VA", "MD", "IL", "UT", "GA", "NJ"];
const states = [...P, "OH", "PA", "AZ", "WA"];
const leads = Array.from({ length: 84 }, (_, i) => {
  const state = states[i % states.length];
  const stage = i % 9;
  const status = stage < 3 ? "sourced" : stage < 5 ? "queued" : stage === 5 ? "contacted" : stage === 6 ? "replied" : stage === 7 ? "call_scheduled" : i % 4 === 0 ? "closed_won" : "qualified_show";
  const rejected = i % 17 === 0;
  return {
    id: `L${i}`, company_name: ["Bright Path ABA", "Sunrise Behavior", "Little Steps Therapy", "Northstar Autism Center", "Blue Sky ABA", "Harbor Behavioral"][i % 6] + (i > 5 ? ` ${i}` : ""),
    website_domain: `clinic${i}.com`, city: ["Austin", "Tampa", "Denver", "Raleigh", "Salt Lake City"][i % 5], state, locations_count: (i % 4) + 1,
    decision_maker_name: ["Jane Doe", "Sam Owner", "Pat Lee", "Chris Kim", "Alex Rivera"][i % 5], decision_maker_title: ["Founder & BCBA", "Owner", "CEO", "Executive Director"][i % 4],
    verified_email: i % 7 === 0 ? null : `owner@clinic${i}.com`, email_verification_status: ["valid", "unverified", "risky"][i % 3], linkedin_url: i % 2 ? "https://linkedin.com/in/x" : null,
    source_platform: ["aba_index", "google_maps", "apollo", "linkedin_sales_nav"][i % 4], batch_id: i < 60 ? "pilot-01" : "pilot-02",
    status: rejected ? "lost" : status, lost_reason: rejected ? "not_icp" : null, exclusion_reason: rejected ? "pe_backed" : null,
    approved_for_outreach: !rejected && stage >= 3 ? 1 : 0, approved_at: stage >= 3 ? "2026-09-05T12:00:00Z" : null, approved_by: "hudson@tektone.com.br",
    first_contacted_at: stage >= 5 ? "2026-09-05T12:00:00Z" : null, replied_at: stage >= 6 ? "2026-09-06T12:00:00Z" : null,
    call_scheduled_for: stage >= 7 ? "2026-09-10T15:00:00Z" : null, call_held_at: stage >= 8 ? "2026-09-06T15:00:00Z" : null, closed_at: status === "closed_won" ? "2026-09-07T15:00:00Z" : null,
    updated_at: "2026-09-07T01:00:00Z",
  };
});
const byState = states.map((st) => {
  const rows = leads.filter((l) => l.state === st);
  const n = (f) => rows.filter(f).length;
  return { state: st, count: rows.length, approved: n((l) => l.approved_for_outreach), contacted: n((l) => l.first_contacted_at), replied: n((l) => l.replied_at), booked: n((l) => l.call_scheduled_for), shows: n((l) => l.call_held_at), closes: n((l) => l.closed_at), rejected: n((l) => l.lost_reason === "not_icp") };
});
const c = (f) => leads.filter(f).length;
const dashboard = {
  pilotStartedAt: "2026-09-01T00:00:00Z",
  kpi: { totalLeads: leads.length, loaded: leads.length, pendingReview: c((l) => l.status === "sourced"), rejected: c((l) => l.lost_reason === "not_icp"), approved: c((l) => l.approved_for_outreach), contacted: c((l) => l.first_contacted_at), booked: c((l) => l.call_scheduled_for), shows: c((l) => l.call_held_at), closes: c((l) => l.closed_at),
    replyRatePct: 41.2, bookRatePct: 23.5, showRatePct: 75, closeRatePct: 33.3, leadsLast30d: 84, earnedCents: 9 * 5000 + 3 * 15000, paidCents: 10000, outstandingCents: 80000, dueSoonCents: 25000, dueSoonCount: 3, overdueCents: 5000, overdueCount: 1 },
  funnel: { sourced: 84, approved: c((l) => l.approved_for_outreach), contacted: c((l) => l.first_contacted_at), replied: c((l) => l.replied_at), call_scheduled: c((l) => l.call_scheduled_for), qualified_show: c((l) => l.call_held_at), closed_won: c((l) => l.closed_at), lost: c((l) => l.status === "lost") },
  leadsByStatus: Object.fromEntries(["sourced", "queued", "contacted", "replied", "form_completed", "call_scheduled", "qualified_show", "closed_won", "lost"].map((k) => [k, c((l) => l.status === k)])),
  payoutTotals: { earned: 60000, invoiced: 20000, paid: 10000, disputed: 0, voided: 5000 },
  bySource: [{ source: "aba_index", count: 21 }, { source: "google_maps", count: 21 }, { source: "apollo", count: 21 }, { source: "linkedin_sales_nav", count: 21 }],
  byState, byBatch: [{ batch: "pilot-01", count: 60 }, { batch: "pilot-02", count: 24 }],
  byCloser: [{ closer: "Hudson", leads: 84, shows: 9, closes: 3 }],
  upcomingCalls: leads.filter((l) => l.status === "call_scheduled").slice(0, 4).map((l) => ({ id: l.id, company_name: l.company_name, decision_maker_name: l.decision_maker_name, state: l.state, call_scheduled_for: l.call_scheduled_for })),
  totalLeads: leads.length,
};
const realFetch = window.fetch;
window.fetch = async (url, opts) => {
  const u = String(url);
  const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  if (u.includes("/crm/api/dashboard")) return ok(dashboard);
  if (u.includes("/crm/api/leads/approve")) return ok({ approved: JSON.parse(opts.body).ids.length });
  if (u.includes("/crm/api/leads/reject")) return ok({ rejected: JSON.parse(opts.body).ids.length });
  if (u.includes("/crm/api/leads")) return ok({ leads });
  return realFetch(url, opts);
};
const view = new URLSearchParams(location.search).get("view") || "dashboard";
createRoot(document.getElementById("root")).render(view === "review" ? <CrmReview isAdmin onOpenLead={() => {}} /> : <CrmDashboard timezone="America/New_York" onOpenLead={() => {}} />);
