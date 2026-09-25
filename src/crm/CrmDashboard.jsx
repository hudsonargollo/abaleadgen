import { useEffect, useMemo, useState } from "react";
import { CalendarClock, DollarSign, MapPin, Users, Database, Send, CalendarCheck, UserCheck, Trophy, RefreshCw, Star } from "lucide-react";
import { crmApi } from "@/crm/crmApi";
import { Spinner } from "@/components/ui";
import { LEAD_STATUSES, CATEGORY_PALETTE, withAlpha } from "@/crm/crmStatus";
import { SOURCE_LABEL, PRIORITY_STATES, usd } from "@/crm/abaLead.types";
import { fmtDateTime } from "@/lib/timezone";

const STATUS_LABEL = Object.fromEntries(LEAD_STATUSES.map((s) => [s.key, s.label]));
const STATUS_COLOR = Object.fromEntries(LEAD_STATUSES.map((s) => [s.key, s.color]));

// ── chart atoms (hand-rolled SVG, no chart library — same as the rest of the repo) ──

function Donut({ data, size = 128, strokeWidth = 18 }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--color-ink)" strokeOpacity="0.08" strokeWidth={strokeWidth} />
      {total > 0 &&
        data.map((d, i) => {
          const frac = d.value / total;
          const dash = Math.max(frac * circumference - 1.5, 0);
          const el = (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={d.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              strokeLinecap="round"
            />
          );
          offset += frac * circumference;
          return el;
        })}
    </svg>
  );
}

function Legend({ data }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.color }} />
          <span className="min-w-0 flex-1 truncate text-ink">{d.label}</span>
          <span className="shrink-0 font-mono text-stone-500 tnum">{d.value}</span>
          <span className="w-10 shrink-0 text-right font-mono text-[10px] text-stone-500 tnum">{total ? Math.round((d.value / total) * 100) : 0}%</span>
        </div>
      ))}
      {data.length === 0 && <p className="text-xs text-stone-500">No data yet.</p>}
    </div>
  );
}

function KpiTile({ label, value, sub, tone = "text-ink" }) {
  return (
    <div className="surface-2 rounded-xl p-4">
      <p className="font-mono text-[9.5px] uppercase tracking-wider text-stone-500">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tone}`}>{value}</p>
      {sub && <p className="mt-0.5 font-mono text-[10.5px] text-stone-500">{sub}</p>}
    </div>
  );
}

const pct = (n) => (n === null || n === undefined ? "—" : `${n}%`);

/** Operational KPI card: big number, a thin progress bar against the previous
 *  funnel step (`of`), and one line of context. */
function OpsCard({ icon: Icon, label, value, sub, of, tone = "text-ink" }) {
  const share = of ? Math.min(100, Math.round(((value || 0) / of) * 100)) : null;
  return (
    <div className="surface-2 rounded-xl p-4">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[9.5px] uppercase tracking-wider text-stone-500">{label}</p>
        <Icon size={13} className="text-stone-400" />
      </div>
      <p className={`mt-1 text-3xl font-bold tnum ${tone}`}>{value ?? 0}</p>
      {share !== null && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-ink/[0.06]" title={`${share}% of previous step`}>
          <div className="h-full rounded-full bg-action transition-[width] duration-500" style={{ width: `${share}%` }} />
        </div>
      )}
      {sub && <p className="mt-1.5 font-mono text-[10.5px] text-stone-500">{sub}</p>}
    </div>
  );
}

const STATE_METRICS = [
  ["count", "Leads"],
  ["contacted", "Contacted"],
  ["booked", "Booked"],
  ["shows", "Shows"],
  ["closes", "Closes"],
];

/** State-by-state volume — one series (leads), so one hue. Priority states get
 *  a star + label (identity is never color-alone) and sort to the top within
 *  equal counts. Hover any bar for the full per-state funnel. */
function StateBreakdown({ byState }) {
  const [metric, setMetric] = useState("count");
  const [hover, setHover] = useState(null);
  const rows = useMemo(() => {
    const isP = (s) => PRIORITY_STATES.includes(s);
    return [...byState].sort((a, b) => b[metric] - a[metric] || isP(b.state) - isP(a.state) || a.state.localeCompare(b.state));
  }, [byState, metric]);
  const max = Math.max(1, ...rows.map((r) => r[metric] || 0));
  const priorityTotal = rows.filter((r) => PRIORITY_STATES.includes(r.state)).reduce((s, r) => s + (r[metric] || 0), 0);
  const total = rows.reduce((s, r) => s + (r[metric] || 0), 0);
  if (!rows.length) {
    return (
      <div className="surface-2 rounded-2xl p-5">
        <p className="label-tech mb-2 flex items-center gap-1.5">
          <MapPin size={12} /> By state
        </p>
        <p className="text-sm text-stone-500">No leads with a state yet — import a batch to see the breakdown.</p>
      </div>
    );
  }
  return (
    <div className="surface-2 rounded-2xl p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="label-tech flex items-center gap-1.5">
          <MapPin size={12} /> By state
          <span className="ml-2 normal-case tracking-normal text-stone-500">
            <Star size={10} className="mr-1 inline text-action" fill="currentColor" />
            priority states: {total ? Math.round((priorityTotal / total) * 100) : 0}% of {STATE_METRICS.find(([k]) => k === metric)[1].toLowerCase()}
          </span>
        </p>
        <div className="flex gap-1">
          {STATE_METRICS.map(([k, label]) => (
            <button key={k} onClick={() => setMetric(k)} className={`rounded-md px-2.5 py-1 font-mono text-[10.5px] ${metric === k ? "bg-action text-clay" : "surface-3 text-stone-600"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-x-6 gap-y-1.5 md:grid-cols-2">
        {rows.map((r) => {
          const v = r[metric] || 0;
          const priority = PRIORITY_STATES.includes(r.state);
          return (
            <div
              key={r.state}
              className="group relative grid grid-cols-[56px_1fr_36px] items-center gap-2"
              onMouseEnter={() => setHover(r.state)}
              onMouseLeave={() => setHover(null)}
            >
              <span className={`flex items-center gap-1 font-mono text-[11px] ${priority ? "font-bold text-ink" : "text-stone-500"}`}>
                {priority && <Star size={9} className="text-action" fill="currentColor" aria-label="priority state" />}
                {r.state}
              </span>
              <div className="h-3.5 w-full rounded-[4px] bg-ink/[0.05]">
                <div
                  className="h-full rounded-[4px] transition-[width] duration-500"
                  style={{ width: `${Math.max(v ? 3 : 0, (v / max) * 100)}%`, background: priority ? "var(--color-action)" : withAlpha("var(--color-action)", 45) }}
                />
              </div>
              <span className="text-right font-mono text-[11px] tnum text-ink">{v}</span>
              {hover === r.state && (
                <div className="pointer-events-none absolute left-14 top-5 z-10 rounded-lg surface-2 px-3 py-2 font-mono text-[10.5px] text-ink shadow-lg">
                  <span className="font-bold">{r.state}{priority ? " · priority" : ""}</span>
                  <span className="text-stone-500"> — {r.count} leads · {r.approved} approved · {r.contacted} contacted · {r.replied} replied · {r.booked} booked · {r.shows} shows · {r.closes} closes{r.rejected ? ` · ${r.rejected} rejected` : ""}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 font-mono text-[10px] text-stone-400">Solid bars = priority states (TX FL CA NC CO VA MD IL UT GA NJ). Hover a row for the per-state funnel.</p>
    </div>
  );
}

const FUNNEL_STEPS = [
  ["sourced", "Sourced"],
  ["approved", "Approved"],
  ["contacted", "Contacted"],
  ["replied", "Replied"],
  ["call_scheduled", "Call booked"],
  ["qualified_show", "Showed · $50"],
  ["closed_won", "Closed · $150"],
];

/** Cumulative "reached at least this stage" funnel, with step-to-step conversion. */
function Funnel({ funnel }) {
  const max = Math.max(1, funnel.sourced || 0);
  return (
    <div className="surface-2 rounded-2xl p-5">
      <p className="label-tech mb-4">Pilot funnel</p>
      <div className="space-y-2.5">
        {FUNNEL_STEPS.map(([key, label], i) => {
          const n = funnel[key] || 0;
          const prev = i ? funnel[FUNNEL_STEPS[i - 1][0]] || 0 : null;
          const conv = prev ? Math.round((n / prev) * 100) : null;
          const color = key === "qualified_show" || key === "closed_won" ? "var(--color-success)" : key === "sourced" || key === "approved" ? "var(--color-sand)" : "var(--color-action)";
          return (
            <div key={key} className="grid grid-cols-[110px_1fr_auto] items-center gap-3">
              <span className="truncate text-xs text-ink">{label}</span>
              <div className="h-5 overflow-hidden rounded-md bg-ink/[0.05]">
                <div className="h-full rounded-md transition-[width] duration-500" style={{ width: `${Math.max(2, (n / max) * 100)}%`, background: withAlpha(color, 70) }} />
              </div>
              <span className="w-24 text-right font-mono text-[11px] tnum">
                <span className="text-ink">{n}</span>
                {conv !== null && <span className="ml-1.5 text-stone-500">{conv}%</span>}
              </span>
            </div>
          );
        })}
      </div>
      {funnel.lost > 0 && <p className="mt-3 font-mono text-[10.5px] text-stone-500">{funnel.lost} lost</p>}
    </div>
  );
}

export default function CrmDashboard({ onOpenLead, timezone }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const [tick, setTick] = useState(0);

  // "Real-time" for a pilot = a 30s poll; the Hub has no CRM push channel and
  // the numbers only move when a human or a webhook writes.
  useEffect(() => {
    let alive = true;
    const load = () =>
      crmApi
        .dashboard()
        .then((d) => {
          if (!alive) return;
          setData(d);
          setUpdatedAt(Date.now());
          setError("");
        })
        .catch((e) => alive && setError(e.body?.error || "Failed to load the dashboard."));
    load();
    const poll = setInterval(load, 30_000);
    const clock = setInterval(() => setTick((t) => t + 1), 5_000);
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  const ago = updatedAt ? Math.max(0, Math.round((Date.now() - updatedAt) / 1000)) : null; // eslint-disable-line no-unused-vars -- tick forces re-render
  void tick;

  if (error) return <p className="font-mono text-[11px] text-danger">{error}</p>;
  if (!data) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const { kpi, funnel, payoutTotals: t, byState = [], bySource = [], byBatch = [], byCloser = [], upcomingCalls = [], leadsByStatus = {}, emailMetrics = {} } = data;
  const stageData = LEAD_STATUSES.map((s) => ({ label: s.label, value: leadsByStatus[s.key] || 0, color: STATUS_COLOR[s.key] })).filter((d) => d.value > 0);
  const sourceData = bySource.map((s, i) => ({ label: SOURCE_LABEL[s.source] || s.source, value: s.count, color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length] }));

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">Campaign health</h1>
          <p className="mt-1 text-sm text-stone-500">Outbound → discovery calls → paying clients. Payouts: $50 per qualified show, $150 per close.</p>
        </div>
        <div className="flex flex-col items-end gap-1 font-mono text-[11px] text-stone-500">
          <span className="flex items-center gap-1.5">
            <RefreshCw size={11} className={ago !== null && ago < 2 ? "animate-spin" : ""} /> {ago === null ? "loading" : ago < 5 ? "live" : `updated ${ago}s ago`} · refreshes every 30s
          </span>
          {data.pilotStartedAt && <span>pilot since {fmtDateTime(data.pilotStartedAt, timezone)}</span>}
        </div>
      </div>

      {/* The five operational KPIs, in funnel order */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <OpsCard icon={Database} label="Total leads loaded" value={kpi.loaded ?? kpi.totalLeads} sub={`${kpi.pendingReview ?? 0} awaiting review · ${kpi.approved} approved${kpi.rejected ? ` · ${kpi.rejected} rejected` : ""}`} />
        <OpsCard icon={Send} label="Contacted" value={kpi.contacted} sub={`${pct(kpi.replyRatePct)} replied`} of={kpi.approved} />
        <OpsCard icon={CalendarCheck} label="Appointments booked" value={kpi.booked ?? funnel.call_scheduled} sub={`${pct(kpi.bookRatePct)} of contacted`} of={kpi.contacted} />
        <OpsCard icon={UserCheck} label="Qualified shows" value={kpi.shows} sub={`${usd(kpi.shows * 5000)} earned · ${pct(kpi.showRatePct)} show rate`} of={kpi.booked ?? funnel.call_scheduled} tone="text-success" />
        <OpsCard icon={Trophy} label="Closes" value={kpi.closes} sub={`${usd(kpi.closes * 15000)} earned · ${pct(kpi.closeRatePct)} close rate`} of={kpi.shows} tone="text-success" />
      </div>

      {/* Money */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <KpiTile label="Earned to date" value={usd(kpi.earnedCents)} sub={`${funnel.qualified_show} shows · ${funnel.closed_won} closes`} />
        <KpiTile label="Paid" value={usd(t.paid)} tone="text-success" />
        <KpiTile label="Outstanding" value={usd(kpi.outstandingCents)} sub={t.invoiced ? `${usd(t.invoiced)} invoiced` : "not yet invoiced"} tone="text-action" />
        <KpiTile label="Due within 7d" value={usd(kpi.dueSoonCents || 0)} sub={`${kpi.dueSoonCount || 0} payouts`} tone="text-warning" />
        <KpiTile label="Overdue" value={usd(kpi.overdueCents || 0)} sub={`${kpi.overdueCount || 0} payouts`} tone={kpi.overdueCount ? "text-danger" : "text-stone-500"} />
        <KpiTile label="Disputed / voided" value={usd((t.disputed || 0) + (t.voided || 0))} tone={t.disputed ? "text-danger" : "text-stone-500"} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <Funnel funnel={funnel} />

        <div className="surface-2 rounded-2xl p-5">
          <p className="label-tech mb-3 flex items-center gap-1.5">
            <CalendarClock size={12} /> Upcoming calls
          </p>
          {upcomingCalls.length === 0 ? (
            <p className="text-sm text-stone-500">No calls booked yet.</p>
          ) : (
            <div className="space-y-2">
              {upcomingCalls.map((c) => (
                <button key={c.id} onClick={() => onOpenLead?.(c.id)} className="flex w-full items-center justify-between gap-3 rounded-lg surface-3 px-3.5 py-2.5 text-left hover:border-action/40">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">{c.company_name || "—"}</span>
                    <span className="block truncate font-mono text-[10.5px] text-stone-500">
                      {c.decision_maker_name || "—"}
                      {c.state ? ` · ${c.state}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-action">{fmtDateTime(c.call_scheduled_for, timezone)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div className="surface-2 rounded-2xl p-5">
          <p className="label-tech mb-3">Leads by stage</p>
          <div className="flex items-center gap-4">
            <Donut data={stageData} />
            <Legend data={stageData} />
          </div>
        </div>
        <div className="surface-2 rounded-2xl p-5">
          <p className="label-tech mb-3">Leads by source</p>
          <div className="flex items-center gap-4">
            <Donut data={sourceData} />
            <Legend data={sourceData} />
          </div>
        </div>
      </div>

      <StateBreakdown byState={byState} />

      {/* Email Campaign Activity & Metrics */}
      <div className="surface-2 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <p className="label-tech flex items-center gap-1.5">
            <Send size={13} /> Email Campaign Metrics & Live Tracking
          </p>
          <span className="font-mono text-xs text-stone-500">Resend API + Pixel Tracking</span>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 mb-5">
          <KpiTile label="Total Sent" value={emailMetrics?.sent || 0} sub="Outbound emails dispatched" />
          <KpiTile label="Opened" value={emailMetrics?.opened || 0} sub={`${emailMetrics?.openRatePct || 0}% open rate`} tone="text-success" />
          <KpiTile label="Bounced" value={emailMetrics?.bounced || 0} sub="Delivery failures" tone={emailMetrics?.bounced ? "text-danger" : "text-stone-500"} />
          <KpiTile label="Reply Rate" value={pct(kpi.replyRatePct)} sub={`${funnel.replied} replies recorded`} tone="text-action" />
        </div>
        <div>
          <p className="font-mono text-xs font-semibold text-stone-600 mb-2">Recent Email Activity (Opens, Clicks & Bounces)</p>
          {(!emailMetrics?.recentEvents || emailMetrics.recentEvents.length === 0) ? (
            <p className="text-xs text-stone-500">No email events recorded yet. Dispatch a campaign to start tracking opens & clicks.</p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
              {emailMetrics.recentEvents.map((ev, i) => (
                <div key={ev.id || i} className="flex items-center justify-between gap-3 surface-3 rounded-lg px-3 py-2 text-xs">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${ev.type === 'email_opened' ? 'bg-success' : ev.type === 'link_clicked' ? 'bg-action' : 'bg-danger'}`} />
                    <span className="font-semibold truncate text-ink">{ev.company_name || ev.lead_id}</span>
                    <span className="text-stone-500 truncate font-mono text-[10.5px]">({ev.type})</span>
                  </div>
                  <span className="font-mono text-[10.5px] text-stone-500 shrink-0">{fmtDateTime(ev.created_at, timezone)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div className="surface-2 rounded-2xl p-5">
          <p className="label-tech mb-3 flex items-center gap-1.5">
            <Users size={12} /> By closer
          </p>
          {byCloser.length === 0 ? (
            <p className="text-sm text-stone-500">No leads assigned yet.</p>
          ) : (
            <div className="space-y-1.5">
              {byCloser.map((c) => (
                <div key={c.closer} className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 flex-1 truncate text-ink">{c.closer}</span>
                  <span className="font-mono text-stone-500 tnum">{c.leads} leads</span>
                  <span className="font-mono text-stone-500 tnum">{c.shows} shows</span>
                  <span className="font-mono text-success tnum">{c.closes} closes</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="surface-2 rounded-2xl p-5">
          <p className="label-tech mb-3 flex items-center gap-1.5">
            <DollarSign size={12} /> By batch
          </p>
          {byBatch.length === 0 ? (
            <p className="text-sm text-stone-500">No batches yet — import leads with a batch id.</p>
          ) : (
            <div className="space-y-1.5">
              {byBatch.map((b) => (
                <div key={b.batch} className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono text-ink">{b.batch}</span>
                  <span className="font-mono text-stone-500 tnum">{b.count} leads</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
