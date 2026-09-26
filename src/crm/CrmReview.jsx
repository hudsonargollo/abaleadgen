import { useEffect, useMemo, useState } from "react";
import { Check, X, Search, ShieldCheck, Star, ExternalLink, RotateCcw, Filter } from "lucide-react";
import { crmApi } from "@/crm/crmApi";
import { Spinner } from "@/components/ui";
import { SOURCE_LABEL, PRIORITY_STATES } from "@/crm/abaLead.types";
import { timeAgo } from "@/crm/crmStatus";

// Pre-launch lead review — the client signs off on Hudson's first 50–100
// sourced leads here before anything is sent. Approve moves a lead to
// `queued` (approved_for_outreach=1); Reject parks it in `lost` (not_icp)
// with an exclusion reason. Both are reversible until a lead is contacted.

const REJECT_REASONS = [
  ["not_icp_other", "Not a fit (other)"],
  ["solo_practitioner", "Solo practitioner, no clinic"],
  ["non_owner", "Contact is not an owner/exec"],
  ["pe_backed", "PE-backed / national group"],
  ["school", "School / district program"],
  ["staffing", "Staffing agency"],
  ["non_aba", "Not an ABA provider"],
];

function reviewState(l) {
  if (l.status === "lost" && l.lost_reason === "not_icp") return "rejected";
  if (l.approved_for_outreach) return "approved";
  return "pending";
}

const BADGE = {
  pending: "bg-warning/10 text-warning",
  approved: "bg-success/10 text-success",
  rejected: "bg-danger/10 text-danger",
};

export default function CrmReview({ isAdmin, onOpenLead }) {
  const [leads, setLeads] = useState(null);
  const [error, setError] = useState("");
  const [term, setTerm] = useState("");
  const [batch, setBatch] = useState("");
  const [show, setShow] = useState("pending"); // pending | approved | rejected | all
  const [onlyPriority, setOnlyPriority] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  function load() {
    crmApi
      .listLeads()
      .then(({ leads }) => setLeads(leads))
      .catch((e) => setError(e.body?.error || "Failed to load leads."));
  }
  useEffect(load, []);

  const batches = useMemo(() => [...new Set((leads || []).map((l) => l.batch_id).filter(Boolean))].sort(), [leads]);

  // Reviewable = not yet in play. Once contacted, decisions happen on the board.
  const reviewable = useMemo(() => (leads || []).filter((l) => ["sourced", "queued"].includes(l.status) || reviewState(l) === "rejected"), [leads]);
  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0 };
    for (const l of reviewable) if (!batch || l.batch_id === batch) c[reviewState(l)]++;
    return c;
  }, [reviewable, batch]);

  const rows = useMemo(() => {
    const q = term.trim().toLowerCase();
    return reviewable
      .filter((l) => (!batch || l.batch_id === batch) && (show === "all" || reviewState(l) === show) && (!onlyPriority || PRIORITY_STATES.includes(l.state)))
      .filter((l) => !q || [l.company_name, l.website_domain, l.decision_maker_name, l.decision_maker_title, l.verified_email, l.city, l.state].filter(Boolean).join(" ").toLowerCase().includes(q))
      .sort((a, b) => (PRIORITY_STATES.includes(b.state) - PRIORITY_STATES.includes(a.state)) || (a.state || "").localeCompare(b.state || "") || (a.company_name || "").localeCompare(b.company_name || ""));
  }, [reviewable, batch, show, onlyPriority, term]);

  const allSelected = rows.length > 0 && rows.every((l) => selected.has(l.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((l) => l.id)));
  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function approve(ids) {
    if (!ids.length) return;
    setBusy(true); setMsg("");
    try {
      const { approved } = await crmApi.approveLeads(ids, batch || undefined);
      setMsg(`${approved} approved → queued`);
      setSelected(new Set());
      load();
    } catch (e) { setMsg(e.body?.error || "Approve failed."); } finally { setBusy(false); }
  }
  async function reject(ids) {
    if (!ids.length) return;
    const pick = window.prompt(`Reject ${ids.length} lead${ids.length === 1 ? "" : "s"} — reason:\n` + REJECT_REASONS.map(([k, l], i) => `${i + 1}. ${l}`).join("\n") + "\n\nEnter a number:", "1");
    if (pick === null) return;
    const [key] = REJECT_REASONS[Math.max(0, Math.min(REJECT_REASONS.length - 1, Number(pick) - 1))] || REJECT_REASONS[0];
    const reason = key === "not_icp_other" ? "other" : key;
    setBusy(true); setMsg("");
    try {
      const { rejected } = await crmApi.rejectLeads(ids, reason);
      setMsg(`${rejected} rejected`);
      setSelected(new Set());
      load();
    } catch (e) { setMsg(e.body?.error || "Reject failed."); } finally { setBusy(false); }
  }

  if (error) return <p className="font-mono text-[11px] text-danger">{error}</p>;
  if (!leads) return <div className="flex justify-center py-16"><Spinner /></div>;

  const totalInBatch = counts.pending + counts.approved + counts.rejected;
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">Pilot lead review</h1>
          <p className="mt-1 text-sm text-stone-500">Sign off on the sourced batch before outreach starts. Approved leads move to Queued; rejected ones are parked and never contacted.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-lg surface-2 px-3 py-2 font-mono text-[11px] text-stone-600">
            <b className="text-ink">{counts.approved}</b>/{totalInBatch} approved · <span className="text-warning">{counts.pending} pending</span>{counts.rejected ? <> · <span className="text-danger">{counts.rejected} rejected</span></> : null}
          </span>
        </div>
      </div>

      {/* progress toward the pilot batch */}
      <div className="mb-5 h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.06]" title={`${counts.approved} approved of ${totalInBatch}`}>
        <div className="flex h-full">
          <div className="h-full bg-success transition-[width]" style={{ width: `${totalInBatch ? (counts.approved / totalInBatch) * 100 : 0}%` }} />
          <div className="ml-0.5 h-full bg-danger transition-[width]" style={{ width: `${totalInBatch ? (counts.rejected / totalInBatch) * 100 : 0}%` }} />
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-500" />
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search clinic, owner, email, state…" className="w-full rounded-lg border border-ink/15 bg-ink/[0.03] py-2 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-stone-400 focus:border-action" />
        </div>
        <select value={batch} onChange={(e) => { setBatch(e.target.value); setSelected(new Set()); }} className="rounded-lg border border-ink/15 bg-transparent px-2.5 py-2 text-xs text-ink">
          <option value="">all batches</option>
          {batches.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <div className="flex gap-1">
          {[["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"], ["all", "All"]].map(([k, l]) => (
            <button key={k} onClick={() => { setShow(k); setSelected(new Set()); }} className={`rounded-lg px-3 py-1.5 font-mono text-[11px] ${show === k ? "bg-action text-clay" : "surface-3 text-stone-600"}`}>
              {l}{k !== "all" && counts[k] ? ` ${counts[k]}` : ""}
            </button>
          ))}
        </div>
        <button onClick={() => setOnlyPriority((v) => !v)} className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 font-mono text-[11px] ${onlyPriority ? "bg-action text-clay" : "surface-3 text-stone-600"}`} title="Only TX FL CA NC CO VA MD IL UT GA NJ">
          <Star size={11} fill={onlyPriority ? "currentColor" : "none"} /> priority states
        </button>
      </div>

      {isAdmin && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 font-mono text-[11px] text-stone-600">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} /> select all {rows.length} shown
          </label>
          <button disabled={busy || !selected.size} onClick={() => approve([...selected])} className="inline-flex items-center gap-1.5 rounded-lg bg-success px-3 py-1.5 font-mono text-[11px] font-semibold text-clay disabled:opacity-40">
            <Check size={12} /> approve {selected.size || ""}
          </button>
          <button disabled={busy || !selected.size} onClick={() => reject([...selected])} className="inline-flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 font-mono text-[11px] font-semibold text-clay disabled:opacity-40">
            <X size={12} /> reject {selected.size || ""}
          </button>
          {busy && <Spinner />}
          {msg && <span className="font-mono text-[11px] text-stone-500">{msg}</span>}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-ink/10">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="surface-2 font-mono text-[10px] uppercase tracking-wider text-stone-500">
            <tr>
              {isAdmin && <th className="w-8 px-3 py-2.5" />}
              <th className="px-3 py-2.5 text-left font-normal">Clinic</th>
              <th className="px-3 py-2.5 text-left font-normal">State</th>
              <th className="px-3 py-2.5 text-left font-normal">Decision maker</th>
              <th className="px-3 py-2.5 text-left font-normal">Email</th>
              <th className="px-3 py-2.5 text-left font-normal">Source</th>
              <th className="px-3 py-2.5 text-left font-normal">Review</th>
              {isAdmin && <th className="px-3 py-2.5 text-right font-normal">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-10 text-center text-sm text-stone-500">Nothing to review{show === "pending" ? " — every lead in this batch has a decision." : "."}</td></tr>
            )}
            {rows.map((l) => {
              const st = reviewState(l);
              const priority = PRIORITY_STATES.includes(l.state);
              return (
                <tr key={l.id} className={`border-t border-ink/[0.06] ${selected.has(l.id) ? "bg-action/[0.04]" : "hover:bg-ink/[0.02]"}`}>
                  {isAdmin && <td className="px-3 py-2.5"><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} /></td>}
                  <td className="px-3 py-2.5">
                    <button onClick={() => onOpenLead?.(l.id)} className="text-left font-semibold text-ink hover:text-action">{l.company_name || l.website_domain || "—"}</button>
                    <p className="font-mono text-[10.5px] text-stone-500">
                      {l.website ? (
                        <a href={/^https?:\/\//i.test(l.website) ? l.website : `https://${l.website}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-action hover:underline">
                          {l.website_domain || l.website.replace(/^https?:\/\/(www\.)?/, "")} <ExternalLink size={9} />
                        </a>
                      ) : (
                        <a href={`https://www.google.com/search?q=${encodeURIComponent((l.company_name || "") + " " + (l.city || "") + " " + (l.state || "") + " ABA")}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-stone-400 hover:text-action">
                          Search Web <ExternalLink size={9} />
                        </a>
                      )}
                      {l.city ? ` · ${l.city}` : ""}
                      {l.locations_count ? ` · ${l.locations_count} loc` : ""}
                      <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((l.company_name || "") + " " + (l.city || "") + " " + (l.state || ""))}`} target="_blank" rel="noreferrer" className="ml-1 text-stone-400 hover:text-action" title="Google Maps">
                        📍 Maps
                      </a>
                    </p>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10.5px] ${priority ? "bg-action/10 font-bold text-action" : "bg-ink/[0.05] text-stone-600"}`}>
                      {priority && <Star size={9} fill="currentColor" />}{l.state || "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <p className="text-ink">{l.decision_maker_name || <span className="text-stone-400">unknown</span>}</p>
                    <p className="font-mono text-[10.5px] text-stone-500">
                      {l.decision_maker_title || "—"}
                      {l.decision_maker_name ? (
                        <a
                          href={l.linkedin_url && !l.linkedin_url.includes("search") ? l.linkedin_url : `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent((l.decision_maker_name || "") + " " + (l.company_name || "") + " ABA")}`}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-1.5 inline-flex items-center gap-0.5 text-stone-400 hover:text-action"
                        >
                          LinkedIn <ExternalLink size={9} />
                        </a>
                      ) : null}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px]">
                    {l.verified_email ? (
                      <span className="inline-flex items-center gap-1 text-ink">
                        <ShieldCheck size={11} className={l.email_verification_status === "valid" ? "text-success" : l.email_verification_status === "risky" ? "text-warning" : "text-stone-400"} title={l.email_verification_status} />
                        {l.verified_email}
                      </span>
                    ) : <span className="text-stone-400">missing</span>}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[10.5px] text-stone-500">{SOURCE_LABEL[l.source_platform] || l.source_platform || "—"}<br />{l.batch_id || ""}</td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${BADGE[st]}`}>{st}</span>
                    {st === "rejected" && l.exclusion_reason && <p className="mt-0.5 font-mono text-[10px] text-stone-500">{l.exclusion_reason.replace(/_/g, " ")}</p>}
                    {st === "approved" && l.approved_at && <p className="mt-0.5 font-mono text-[10px] text-stone-500">{timeAgo(l.approved_at)} ago{l.approved_by ? ` · ${l.approved_by.split("@")[0]}` : ""}</p>}
                  </td>
                  {isAdmin && (
                    <td className="px-3 py-2.5 text-right">
                      <div className="inline-flex gap-1">
                        {st !== "approved" && (
                          <button disabled={busy} onClick={() => approve([l.id])} title={st === "rejected" ? "Reopen and approve" : "Approve → queued"} className="grid h-7 w-7 place-items-center rounded-md bg-success/15 text-success hover:bg-success/25 disabled:opacity-40">
                            {st === "rejected" ? <RotateCcw size={13} /> : <Check size={13} />}
                          </button>
                        )}
                        {st !== "rejected" && (
                          <button disabled={busy} onClick={() => reject([l.id])} title="Reject (not ICP)" className="grid h-7 w-7 place-items-center rounded-md bg-danger/15 text-danger hover:bg-danger/25 disabled:opacity-40">
                            <X size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!isAdmin && <p className="mt-3 flex items-center gap-1.5 font-mono text-[10.5px] text-stone-500"><Filter size={10} /> Approve / reject is an admin action — you can review and open leads here.</p>}
    </div>
  );
}
