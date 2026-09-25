import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  MapPin,
  UserCheck,
  Search,
  Inbox,
  Plus,
  X,
  SlidersHorizontal,
  Upload,
  ShieldCheck,
  DollarSign,
  Linkedin,
  Globe,
} from "lucide-react";
import { crmApi } from "@/crm/crmApi";
import { Spinner } from "@/components/ui";
import { timeAgo, withAlpha } from "@/crm/crmStatus";
import {
  LEAD_STATUSES,
  SOURCE_LABEL,
  SOURCE_PLATFORMS,
  PRIORITY_STATES,
  LOST_REASONS,
  canTransition,
} from "@/crm/abaLead.types";
import { parseDelimited } from "@/crm/leadValidation";

// ABA outbound pipeline board — 9 lanes (sourced → closed_won + lost), native
// HTML5 drag-and-drop. Transition rules are preflighted client-side with
// the same canTransition() the worker enforces, so an invalid drop shows a
// reason instead of flashing an optimistic move that then reverts.
export default function CrmLeads({ onOpenLead, isAdmin }) {
  const [leads, setLeads] = useState(null);
  const [error, setError] = useState("");
  const [term, setTerm] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({ state: "", source: "", batch: "", approved: "" });
  const [dragId, setDragId] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  const [moveErr, setMoveErr] = useState(null);
  const [approving, setApproving] = useState(false);

  function load() {
    crmApi
      .listLeads()
      .then(({ leads }) => setLeads(leads))
      .catch((e) => setError(e.body?.error || "Failed to load leads."));
  }
  useEffect(load, []);

  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const options = useMemo(() => {
    const states = new Set();
    const batches = new Set();
    for (const l of leads || []) {
      if (l.state) states.add(l.state);
      if (l.batch_id) batches.add(l.batch_id);
    }
    return { states: [...states].sort(), batches: [...batches].sort() };
  }, [leads]);

  const filteredLeads = useMemo(() => {
    const q = term.trim().toLowerCase();
    return (leads || []).filter((l) => {
      if (q) {
        const hay = [l.company_name, l.website_domain, l.decision_maker_name, l.verified_email, l.city, l.state]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filters.state && l.state !== filters.state) return false;
      if (filters.source && l.source_platform !== filters.source) return false;
      if (filters.batch && l.batch_id !== filters.batch) return false;
      if (filters.approved === "yes" && !l.approved_for_outreach) return false;
      if (filters.approved === "no" && l.approved_for_outreach) return false;
      return true;
    });
  }, [leads, term, filters]);

  const byStatus = (key) => filteredLeads.filter((l) => l.status === key);

  async function moveLead(id, status) {
    const lead = (leads || []).find((l) => l.id === id);
    if (!lead || lead.status === status) return;
    const check = canTransition(lead, status, { force: isAdmin });
    if (!check.ok) {
      setMoveErr(check.reason);
      return;
    }
    const opts = {};
    if (status === "lost") {
      const r = window.prompt(`Lost reason (${LOST_REASONS.join(" | ")}):`, "no_reply");
      if (r === null) return;
      opts.lostReason = r || "other";
    }
    if (status === "call_scheduled") {
      const when = window.prompt("Call scheduled for (YYYY-MM-DDTHH:MM, local):", new Date(Date.now() + 86400000).toISOString().slice(0, 16));
      if (when === null) return;
      const d = new Date(when);
      if (Number.isNaN(d.getTime())) {
        setMoveErr("Invalid date.");
        return;
      }
      opts.callScheduledFor = d.toISOString();
    }
    if (isAdmin && lead.status !== "sourced" && LEAD_STATUSES.findIndex((s) => s.key === status) < LEAD_STATUSES.findIndex((s) => s.key === lead.status)) {
      opts.force = true;
    }
    const prev = lead.status;
    setMoveErr(null);
    setLeads((cur) => cur.map((l) => (l.id === id ? { ...l, status } : l)));
    try {
      const { lead: updated } = await crmApi.setLeadStatus(id, status, opts);
      setLeads((cur) => cur.map((l) => (l.id === id ? { ...l, ...updated } : l)));
    } catch (e) {
      setLeads((cur) => cur.map((l) => (l.id === id ? { ...l, status: prev } : l)));
      setMoveErr(e.body?.error || "Failed to move lead.");
    }
  }

  async function approveVisibleSourced() {
    const ids = byStatus("sourced").map((l) => l.id);
    if (!ids.length) return;
    const batch = window.prompt(`Approve ${ids.length} lead${ids.length === 1 ? "" : "s"} for outreach. Batch id:`, filters.batch || `pilot-${new Date().toISOString().slice(0, 10)}`);
    if (batch === null) return;
    setApproving(true);
    try {
      await crmApi.approveLeads(ids, batch || undefined);
      load();
    } catch (e) {
      setMoveErr(e.body?.error || "Approval failed.");
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="flex items-start gap-4">
      <FilterPanel
        open={showFilters}
        filters={filters}
        setFilters={setFilters}
        options={options}
        resultCount={filteredLeads.length}
        onClose={() => setShowFilters(false)}
      />

      <div className="min-w-0 flex-1">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-ink">ABA Pipeline</h1>
            <p className="mt-1 text-sm text-stone-500">Sourced clinic → booked discovery call → paying client.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden font-mono text-[11px] text-stone-500 sm:inline">{filteredLeads.length} leads</span>
            <button
              onClick={() => setShowImport(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink/15 px-3.5 py-2 font-mono text-[11px] text-stone-600 hover:text-ink"
            >
              <Upload size={13} /> Import
            </button>
            <button
              onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-action px-3.5 py-2 font-mono text-[11px] font-semibold text-clay"
            >
              <Plus size={13} /> New lead
            </button>
          </div>
        </div>

        <div className="mb-6 flex gap-2">
          <div className="relative max-w-md flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search clinic, domain, decision maker, email, city…"
              className="w-full rounded-lg border border-ink/15 bg-ink/[0.03] py-2 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-stone-400 focus:border-action"
            />
          </div>
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 font-mono text-[11px] transition-colors ${
              showFilters ? "border-action text-action" : "border-ink/15 text-stone-500 hover:text-ink"
            }`}
          >
            <SlidersHorizontal size={13} /> Filters
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-action px-1.5 py-0.5 font-mono text-[9px] font-bold text-clay">{activeFilterCount}</span>
            )}
          </button>
        </div>

        {error && <p className="mb-3 font-mono text-[11px] text-danger">{error}</p>}
        {moveErr && (
          <p className="mb-3 flex items-center gap-2 font-mono text-[11px] text-danger">
            {moveErr}
            <button onClick={() => setMoveErr(null)} className="text-stone-500">
              <X size={12} />
            </button>
          </p>
        )}

        {showAdd && (
          <AddLeadModal
            onClose={() => setShowAdd(false)}
            onCreated={(lead) => {
              setShowAdd(false);
              load();
              onOpenLead(lead.id);
            }}
          />
        )}
        {showImport && (
          <ImportModal
            defaultBatch={filters.batch}
            onClose={() => setShowImport(false)}
            onImported={() => {
              setShowImport(false);
              load();
            }}
          />
        )}

        {leads === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-3">
            {LEAD_STATUSES.map((s) => {
              const col = byStatus(s.key);
              const isDragOver = dragOverKey === s.key;
              return (
                <div key={s.key} className="w-[78vw] shrink-0 sm:w-[45vw] lg:w-[250px]">
                  <div
                    className="flex flex-col overflow-hidden rounded-xl border transition-colors"
                    style={{
                      background: isDragOver ? withAlpha(s.color, 6) : undefined,
                      borderColor: isDragOver ? s.color : undefined,
                      borderTopColor: s.color,
                      borderTopWidth: 3,
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverKey(s.key);
                    }}
                    onDragLeave={() => setDragOverKey((k) => (k === s.key ? null : k))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverKey(null);
                      const id = e.dataTransfer.getData("text/plain");
                      if (id) moveLead(id, s.key);
                    }}
                  >
                    <div className={`flex items-center justify-between border-b border-ink/10 px-3 py-2.5 ${isDragOver ? "" : "surface-2"}`}>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                        <span className="truncate text-xs font-bold text-ink">{s.label}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {s.key === "sourced" && isAdmin && col.length > 0 && (
                          <button
                            onClick={approveVisibleSourced}
                            disabled={approving}
                            title="Approve all visible sourced leads for outreach (moves them to Queued)"
                            className="grid h-6 w-6 place-items-center rounded-md bg-action/15 text-action disabled:opacity-50"
                          >
                            {approving ? <Spinner /> : <ShieldCheck size={13} />}
                          </button>
                        )}
                        <span
                          className="rounded-full px-2 py-0.5 text-center font-mono text-[10.5px] font-bold"
                          style={{ color: s.color, background: withAlpha(s.color, 10), border: `1px solid ${withAlpha(s.color, 25)}` }}
                        >
                          {col.length}
                        </span>
                      </div>
                    </div>
                    <div className={`flex flex-1 flex-col gap-2 p-2.5 ${isDragOver ? "" : "surface-1"}`} style={{ minHeight: 130 }}>
                      {col.map((l) => (
                        <LeadCard
                          key={l.id}
                          lead={l}
                          dragging={dragId === l.id}
                          onClick={() => onOpenLead(l.id)}
                          onDragStart={(e) => {
                            setDragId(l.id);
                            e.dataTransfer.setData("text/plain", l.id);
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onDragEnd={() => setDragId(null)}
                        />
                      ))}
                      {col.length === 0 && (
                        <div
                          className="grid place-items-center gap-2 rounded-lg border border-dashed border-ink/15 text-center text-stone-500"
                          style={{ minHeight: 108 }}
                        >
                          <Inbox size={20} strokeWidth={1.5} className="opacity-45" />
                          <span className="font-mono text-[10px] uppercase tracking-wide">empty</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const PAYOUT_TONE = { earned: "var(--color-action)", invoiced: "var(--color-warning)", paid: "var(--color-success)", disputed: "var(--color-danger)", voided: "var(--color-sand)" };

function LeadCard({ lead, onClick, dragging, onDragStart, onDragEnd }) {
  const loc = [lead.city, lead.state].filter(Boolean).join(", ");
  const priority = lead.state && PRIORITY_STATES.includes(lead.state);
  const emailOk = lead.email_verification_status === "valid";
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="surface-2 w-full rounded-lg p-3 text-left transition-colors hover:border-action/40"
      style={{ cursor: "grab", opacity: dragging ? 0.4 : 1 }}
    >
      <p className="flex items-center gap-1.5 truncate text-[12.5px] font-semibold text-ink">
        <Building2 size={12} className="shrink-0 opacity-60" />
        <span className="truncate">{lead.company_name || lead.website_domain || "Unnamed clinic"}</span>
      </p>
      {loc && (
        <p className="mt-1 flex items-center gap-1.5 truncate font-mono text-[10.5px] text-stone-500">
          <MapPin size={10} /> {loc}
          {priority && <span className="rounded-full bg-action/10 px-1.5 text-[9px] font-bold text-action">priority</span>}
          {lead.locations_count > 1 && <span>· {lead.locations_count} loc</span>}
        </p>
      )}
      {lead.decision_maker_name && (
        <p className="mt-1.5 truncate text-[11.5px] text-ink/80">
          {lead.decision_maker_name}
          {lead.decision_maker_title ? <span className="text-stone-500"> · {lead.decision_maker_title}</span> : null}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 truncate rounded-full border border-ink/10 bg-ink/[0.04] px-2 py-0.5 font-mono text-[10px] text-stone-500">
          {SOURCE_LABEL[lead.source_platform] || lead.source_platform || "—"}
        </span>
        {lead.verified_email && (
          <span
            title={`${lead.verified_email} (${lead.email_verification_status})`}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] ${emailOk ? "bg-success/10 text-success" : "bg-ink/[0.04] text-stone-500"}`}
          >
            <ShieldCheck size={10} /> {emailOk ? "email ✓" : lead.email_verification_status}
          </span>
        )}
        {lead.linkedin_url && <Linkedin size={11} className="text-stone-400" />}
        {lead.website && <Globe size={11} className="text-stone-400" />}
        {["show_payout_status", "close_payout_status"].map((col) =>
          lead[col] && lead[col] !== "not_earned" ? (
            <span
              key={col}
              className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] font-bold"
              style={{ color: PAYOUT_TONE[lead[col]], background: withAlpha(PAYOUT_TONE[lead[col]], 10), border: `1px solid ${withAlpha(PAYOUT_TONE[lead[col]], 30)}` }}
              title={`${col === "show_payout_status" ? "$50 show" : "$150 close"} payout: ${lead[col]}`}
            >
              <DollarSign size={9} /> {col === "show_payout_status" ? "50" : "150"} {lead[col]}
            </span>
          ) : null
        )}
      </div>
      <div className="mt-2.5 flex items-center justify-between">
        <span className="flex items-center gap-1 truncate font-mono text-[10px] text-stone-500">
          <UserCheck size={10} /> {lead.closer_name || "—"}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-stone-500" title="time in stage">
          {timeAgo(lead.stage_entered_at || lead.updated_at)}
        </span>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-ink/15 bg-transparent px-2.5 py-2 text-xs text-ink";

function Field({ label, children }) {
  return (
    <div className="border-t border-ink/10 px-4 py-3.5">
      <label className="mb-1.5 block font-mono text-[10.5px] font-bold uppercase tracking-wide text-stone-500">{label}</label>
      {children}
    </div>
  );
}

function FilterPanel({ open, filters, setFilters, options, resultCount, onClose }) {
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const clear = () => setFilters({ state: "", source: "", batch: "", approved: "" });
  const activeCount = Object.values(filters).filter(Boolean).length;
  if (!open) return null;

  return (
    <div className="surface-2 w-64 shrink-0 rounded-xl">
      <div className="flex items-center justify-between border-b border-ink/10 px-4 py-3.5">
        <span className="flex items-center gap-2 text-sm font-bold text-ink">
          <SlidersHorizontal size={14} /> Filters
        </span>
        <button onClick={onClose} className="text-stone-500 hover:text-ink">
          <X size={16} />
        </button>
      </div>
      <p className="px-4 pt-3 font-mono text-[10.5px] text-stone-500">{resultCount} matching</p>
      <Field label="State">
        <select value={filters.state} onChange={(e) => set({ state: e.target.value })} className={inputCls}>
          <option value="">All</option>
          {options.states.map((s) => (
            <option key={s} value={s}>
              {s}
              {PRIORITY_STATES.includes(s) ? " ★" : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Source">
        <select value={filters.source} onChange={(e) => set({ source: e.target.value })} className={inputCls}>
          <option value="">All</option>
          {SOURCE_PLATFORMS.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Batch">
        <select value={filters.batch} onChange={(e) => set({ batch: e.target.value })} className={inputCls}>
          <option value="">All</option>
          {options.batches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Approved for outreach">
        <select value={filters.approved} onChange={(e) => set({ approved: e.target.value })} className={inputCls}>
          <option value="">All</option>
          <option value="yes">Approved</option>
          <option value="no">Not approved</option>
        </select>
      </Field>
      <div className="border-t border-ink/10 px-4 py-3.5">
        <button
          onClick={clear}
          disabled={activeCount === 0}
          className="w-full rounded-lg border border-ink/15 px-3 py-1.5 font-mono text-[11px] text-stone-500 disabled:opacity-40"
        >
          {activeCount > 0 ? `Clear ${activeCount}` : "No active filters"}
        </button>
      </div>
    </div>
  );
}

const EMPTY_FORM = {
  company_name: "",
  website: "",
  city: "",
  state: "",
  locations_count: "",
  decision_maker_name: "",
  decision_maker_title: "",
  verified_email: "",
  linkedin_url: "",
  source_platform: "manual",
  source_url: "",
  batch_id: "",
};

function AddLeadModal({ onClose, onCreated }) {
  const [f, setF] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k) => (e) => setF((cur) => ({ ...cur, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!f.company_name.trim() && !f.website.trim()) {
      setErr("Company name or website is required.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const { lead } = await crmApi.createLead(f);
      onCreated(lead);
    } catch (e2) {
      setErr(e2.body?.error || "Could not create lead.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New lead" onClose={onClose}>
      <form onSubmit={submit} className="grid gap-2.5 sm:grid-cols-2">
        <input autoFocus placeholder="Clinic name *" value={f.company_name} onChange={set("company_name")} className={inputCls} />
        <input placeholder="Website" value={f.website} onChange={set("website")} className={inputCls} />
        <input placeholder="City" value={f.city} onChange={set("city")} className={inputCls} />
        <div className="flex gap-2">
          <input placeholder="ST" maxLength={2} value={f.state} onChange={set("state")} className={`${inputCls} w-16 uppercase`} />
          <input placeholder="# locations" type="number" min="1" value={f.locations_count} onChange={set("locations_count")} className={inputCls} />
        </div>
        <input placeholder="Decision maker name" value={f.decision_maker_name} onChange={set("decision_maker_name")} className={inputCls} />
        <input placeholder="Title (Founder, Owner, CEO…)" value={f.decision_maker_title} onChange={set("decision_maker_title")} className={inputCls} />
        <input type="email" placeholder="Email" value={f.verified_email} onChange={set("verified_email")} className={inputCls} />
        <input placeholder="LinkedIn URL" value={f.linkedin_url} onChange={set("linkedin_url")} className={inputCls} />
        <select value={f.source_platform} onChange={set("source_platform")} className={inputCls}>
          {SOURCE_PLATFORMS.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
        <input placeholder="Source URL" value={f.source_url} onChange={set("source_url")} className={inputCls} />
        <input placeholder="Batch id (optional)" value={f.batch_id} onChange={set("batch_id")} className={`${inputCls} sm:col-span-2`} />
        {err && <p className="font-mono text-[11px] text-danger sm:col-span-2">{err}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-1 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-action px-4 py-2.5 font-mono text-[11px] font-semibold text-clay disabled:opacity-50 sm:col-span-2"
        >
          {busy && <Spinner />} Add lead
        </button>
      </form>
    </Modal>
  );
}

const ISSUE_TONE = { error: "text-danger", duplicate: "text-warning", valid: "text-success" };

/** Two-step import: paste → server dry-run (validation + DB dedup, zero
 *  writes) → review → import the valid rows. Same validator the CLI and the
 *  worker use (src/crm/leadValidation.ts), so what you see here is exactly
 *  what would land. */
function ImportModal({ defaultBatch, onClose, onImported }) {
  const [text, setText] = useState("");
  const [batch, setBatch] = useState(defaultBatch || `pilot-${new Date().toISOString().slice(0, 10)}`);
  const [source, setSource] = useState("aba_index");
  const [rejectRole, setRejectRole] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // dry-run report
  const [result, setResult] = useState(null); // commit result
  const [err, setErr] = useState("");
  const parsed = useMemo(() => parseDelimited(text), [text]);

  async function dryRun() {
    if (!parsed.rows.length) return;
    setBusy(true);
    setErr("");
    try {
      setPreview(await crmApi.importLeads(parsed.rows, batch || undefined, { source, dry_run: true, reject_role_emails: rejectRole }));
    } catch (e) {
      setErr(e.body?.error || "Validation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setErr("");
    try {
      setResult(await crmApi.importLeads(parsed.rows, batch || undefined, { source, reject_role_emails: rejectRole }));
    } catch (e) {
      setErr(e.body?.error || "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  const s = preview?.summary;
  const problemRows = preview?.rows.filter((r) => r.status !== "valid" || r.warnings.length) || [];

  return (
    <Modal title="Import leads" onClose={onClose} wide>
      {result ? (
        <div>
          <p className="text-sm text-ink">
            Imported <b>{result.created}</b> lead{result.created === 1 ? "" : "s"} into batch <b>{batch}</b> as sourced
            {result.summary.errors + result.summary.duplicates ? ` · ${result.summary.errors + result.summary.duplicates} skipped` : ""}.
          </p>
          <button onClick={onImported} className="mt-4 rounded-lg bg-action px-4 py-2 font-mono text-[11px] font-semibold text-clay">
            Done
          </button>
        </div>
      ) : preview ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-4 gap-2 text-center">
            {[
              ["rows", s.total, "text-ink"],
              ["valid", s.valid, "text-success"],
              ["errors", s.errors, "text-danger"],
              ["duplicates", s.duplicates, "text-warning"],
            ].map(([label, n, tone]) => (
              <div key={label} className="rounded-lg surface-3 px-2 py-2">
                <p className={`text-lg font-bold ${tone}`}>{n}</p>
                <p className="font-mono text-[10px] uppercase tracking-wider text-stone-500">{label}</p>
              </div>
            ))}
          </div>
          {s.unmappedColumns.length > 0 && (
            <p className="font-mono text-[10.5px] text-stone-500">Ignored columns: {s.unmappedColumns.join(", ")}</p>
          )}
          <div className="max-h-72 overflow-y-auto rounded-lg border border-ink/10">
            {problemRows.length === 0 ? (
              <p className="px-3 py-4 text-sm text-stone-500">Every row is clean.</p>
            ) : (
              problemRows.map((r) => (
                <div key={r.row} className="border-b border-ink/10 px-3 py-2 last:border-0">
                  <p className="text-xs text-ink">
                    <span className={`mr-2 font-mono text-[10px] font-bold uppercase ${ISSUE_TONE[r.status]}`}>{r.status}</span>
                    row {r.row} · {r.lead.company_name || r.lead.website_domain || "(no identity)"}
                  </p>
                  <ul className="mt-0.5 font-mono text-[10.5px] text-stone-500">
                    {r.errors.map((i, k) => (
                      <li key={`e${k}`} className="text-danger">✗ {i.message}</li>
                    ))}
                    {r.warnings.map((i, k) => (
                      <li key={`w${k}`}>⚠ {i.message}</li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
          {err && <p className="font-mono text-[11px] text-danger">{err}</p>}
          <div className="flex gap-2">
            <button
              onClick={commit}
              disabled={busy || !s.valid}
              className="inline-flex items-center gap-1.5 rounded-lg bg-action px-4 py-2.5 font-mono text-[11px] font-semibold text-clay disabled:opacity-50"
            >
              {busy && <Spinner />} Import {s.valid} valid row{s.valid === 1 ? "" : "s"}
            </button>
            <button onClick={() => setPreview(null)} disabled={busy} className="rounded-lg border border-ink/15 px-4 py-2.5 font-mono text-[11px] text-stone-500">
              back to edit
            </button>
          </div>
          <p className="font-mono text-[10px] text-stone-400">Errors and duplicates are skipped, never partially applied. Nothing has been written yet.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <p className="text-xs text-stone-500">
            Paste CSV or TSV with a header row (Apollo / Sales Navigator / Sheets exports work as-is). Recognized: company, website, city, state,
            locations, name, title, email, linkedin, source url, notes. States are normalized to 2 letters; emails are syntax-checked and role
            addresses (info@, support@…) flagged; duplicates on domain or email are rejected.
          </p>
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            placeholder={"Company,Website,City,State,Name,Title,Email,LinkedIn\nBright Path ABA,brightpathaba.com,Austin,Texas,Jane Doe,Founder,jane@brightpathaba.com,linkedin.com/in/janedoe"}
            className={`${inputCls} font-mono`}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <select value={source} onChange={(e) => setSource(e.target.value)} className={inputCls}>
              {SOURCE_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  default source: {SOURCE_LABEL[p]}
                </option>
              ))}
            </select>
            <input value={batch} onChange={(e) => setBatch(e.target.value)} placeholder="Batch id" className={inputCls} />
          </div>
          <label className="flex items-center gap-2 font-mono text-[10.5px] text-stone-500">
            <input type="checkbox" checked={rejectRole} onChange={(e) => setRejectRole(e.target.checked)} /> reject role-based emails (info@, support@…) instead of flagging them
          </label>
          <p className="font-mono text-[10.5px] text-stone-500">
            {parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"} detected
            {parsed.headers.length ? ` · columns: ${parsed.headers.join(", ")}` : ""}
          </p>
          {err && <p className="font-mono text-[11px] text-danger">{err}</p>}
          <button
            onClick={dryRun}
            disabled={busy || !parsed.rows.length}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-action px-4 py-2.5 font-mono text-[11px] font-semibold text-clay disabled:opacity-50"
          >
            {busy && <Spinner />} Validate {parsed.rows.length || ""} rows (dry run)
          </button>
        </div>
      )}
    </Modal>
  );
}

function Modal({ title, onClose, wide, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className={`surface-2 w-full rounded-xl p-5 ${wide ? "max-w-2xl" : "max-w-lg"}`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink">{title}</h2>
          <button type="button" onClick={onClose} className="text-stone-500 hover:text-ink">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
