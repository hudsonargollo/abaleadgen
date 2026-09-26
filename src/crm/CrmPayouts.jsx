import { useEffect, useState } from "react";
import { DollarSign, FileText, Check, Ban, AlertTriangle, Download, Clock } from "lucide-react";
import { crmApi } from "@/crm/crmApi";
import { Spinner } from "@/components/ui";
import { usd } from "@/crm/abaLead.types";
import { fmtDate } from "@/lib/timezone";

const STATUS_STYLE = {
  earned: "bg-action/10 text-action",
  invoiced: "bg-warning/10 text-warning",
  paid: "bg-success/10 text-success",
  disputed: "bg-danger/10 text-danger",
  voided: "bg-ink/[0.06] text-stone-500",
};
const TRIGGER_LABEL = { qualified_show: "Qualified show", closed_won: "Closed won" };
const FILTERS = [
  { key: "", label: "all" },
  { key: "due_soon", label: "due soon", view: true },
  { key: "overdue", label: "overdue", view: true },
  { key: "earned", label: "earned" },
  { key: "invoiced", label: "invoiced" },
  { key: "paid", label: "paid" },
  { key: "disputed", label: "disputed" },
  { key: "voided", label: "voided" },
];

/** Payout ledger — one row per $50 show / $150 close trigger (lead_payouts).
 *  Admins move rows earned → invoiced → paid (or dispute/void); everyone
 *  else reads. Totals strip is what goes on the pilot invoice. */
export default function CrmPayouts({ isAdmin, timezone }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState("");

  function load() {
    const f = FILTERS.find((x) => x.key === filter);
    crmApi
      .listPayouts(f?.view ? { view: filter } : { status: filter || undefined })
      .then(setData)
      .catch((e) => setErr(e.body?.error || "Failed to load payouts."));
  }
  useEffect(load, [filter]);

  async function move(p, status) {
    let extra = {};
    if (status === "invoiced") {
      const ref = window.prompt("Invoice reference (optional):", p.invoice_ref || "");
      if (ref === null) return;
      extra = { invoice_ref: ref || null };
    }
    if (status === "paid") {
      const ref = window.prompt("Payment reference (optional):", "");
      if (ref === null) return;
      extra = { paid_ref: ref || null };
    }
    if (status === "voided") {
      const reason = window.prompt("Why is this payout voided?");
      if (reason === null) return;
      extra = { voided_reason: reason || null };
    }
    setBusy(p.id);
    setErr("");
    try {
      await crmApi.updatePayout(p.id, { status, ...extra });
      load();
    } catch (e) {
      setErr(e.body?.error || "Could not update payout.");
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const t = data.totals;
  const exportView = filter === "due_soon" || filter === "overdue" ? filter : "all";
  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink">Payouts</h1>
          <p className="mt-1 text-sm text-stone-500">
            $50 per qualified show-up · $150 per closed paying client · net {data.netDays} days from the milestone (or deposit date).
          </p>
        </div>
        <a
          href={crmApi.payoutsExportUrl(exportView)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ink/15 px-3.5 py-2 font-mono text-[11px] text-stone-600 hover:text-ink"
          title="CSV for the client invoice"
        >
          <Download size={13} /> export {exportView === "all" ? "ledger" : exportView.replace("_", " ")}
        </a>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={`Due within ${data.netDays}d`} value={usd(data.dueSoonCents)} sub={`${data.dueSoonCount} payout${data.dueSoonCount === 1 ? "" : "s"}`} tone="text-warning" />
        <Stat label="Overdue" value={usd(data.overdueCents)} sub={`${data.overdueCount} payout${data.overdueCount === 1 ? "" : "s"}`} tone={data.overdueCount ? "text-danger" : "text-stone-500"} />
        <Stat label="Earned (unbilled)" value={usd(t.earned)} />
        <Stat label="Invoiced" value={usd(t.invoiced)} />
        <Stat label="Paid" value={usd(t.paid)} tone="text-success" />
        <Stat label="Outstanding" value={usd(t.earned + t.invoiced)} tone="text-action" />
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key || "all"}
            onClick={() => setFilter(f.key)}
            className={`rounded-lg px-3 py-1.5 font-mono text-[11px] ${filter === f.key ? "bg-action text-clay" : "surface-3 text-stone-600"}`}
          >
            {f.label}
            {f.key === "overdue" && data.overdueCount ? ` (${data.overdueCount})` : ""}
            {f.key === "due_soon" && data.dueSoonCount ? ` (${data.dueSoonCount})` : ""}
          </button>
        ))}
      </div>

      {err && <p className="mb-3 font-mono text-[11px] text-danger">{err}</p>}

      {data.payouts.length === 0 ? (
        <p className="text-sm text-stone-500">No payouts yet — they appear when a lead reaches Qualified show or Closed won.</p>
      ) : (
        <div className="space-y-2">
          {data.payouts.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg surface-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">
                  {p.company_name || p.lead_id.slice(0, 8)}
                  {p.state ? <span className="ml-1.5 font-mono text-[10px] text-stone-500">{p.state}</span> : null}
                </p>
                <p className="font-mono text-[10.5px] text-stone-500">
                  {TRIGGER_LABEL[p.trigger]} · earned {fmtDate(p.earned_at, timezone)}
                  {p.deposit_date ? ` · deposit ${p.deposit_date.slice(0, 10)}` : ""}
                  {p.invoice_ref ? ` · inv ${p.invoice_ref}` : ""}
                  {p.paid_at ? ` · paid ${fmtDate(p.paid_at, timezone)}` : ""}
                  {p.voided_reason ? ` · ${p.voided_reason}` : ""}
                </p>
                <DueLine p={p} timezone={timezone} />
              </div>
              <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${STATUS_STYLE[p.status]}`}>{p.status}</span>
              <span className="w-20 text-right text-sm font-semibold text-ink">{usd(p.amount_cents)}</span>
              {isAdmin && (
                <div className="flex gap-1">
                  {p.status === "earned" && <Act icon={FileText} title="Mark invoiced" onClick={() => move(p, "invoiced")} busy={busy === p.id} />}
                  {p.status === "invoiced" && <Act icon={Check} title="Mark paid" onClick={() => move(p, "paid")} busy={busy === p.id} tone="text-success" />}
                  {(p.status === "earned" || p.status === "invoiced") && (
                    <Act icon={AlertTriangle} title="Dispute" onClick={() => move(p, "disputed")} busy={busy === p.id} tone="text-danger" />
                  )}
                  {p.status === "disputed" && <Act icon={Check} title="Resolve → earned" onClick={() => move(p, "earned")} busy={busy === p.id} />}
                  {p.status !== "paid" && p.status !== "voided" && <Act icon={Ban} title="Void" onClick={() => move(p, "voided")} busy={busy === p.id} />}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone = "text-ink" }) {
  return (
    <div className="rounded-xl surface-2 px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-wider text-stone-500">{label}</p>
      <p className={`mt-1 flex items-center gap-1 text-lg font-bold ${tone}`}>
        <DollarSign size={14} className="opacity-50" /> {value.replace("$", "")}
      </p>
      {sub && <p className="font-mono text-[10px] text-stone-500">{sub}</p>}
    </div>
  );
}

/** Due-date line: silent for paid/voided, amber inside the net window, red past it. */
function DueLine({ p, timezone }) {
  if (!p.due_at || (p.status !== "earned" && p.status !== "invoiced")) return null;
  const due = new Date(p.due_at);
  const days = Math.ceil((due.getTime() - Date.now()) / 86400000);
  const tone = days < 0 ? "text-danger" : days <= 7 ? "text-warning" : "text-stone-500";
  return (
    <p className={`mt-0.5 flex items-center gap-1 font-mono text-[10.5px] ${tone}`}>
      <Clock size={10} /> {days < 0 ? `overdue by ${-days} day${-days === 1 ? "" : "s"}` : days === 0 ? "due today" : `due in ${days} day${days === 1 ? "" : "s"}`} · {fmtDate(p.due_at, timezone)}
    </p>
  );
}

function Act({ icon: Icon, title, onClick, busy, tone = "text-stone-600" }) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={busy}
      className={`grid h-7 w-7 place-items-center rounded-md surface-2 ${tone} hover:border-action/40 disabled:opacity-50`}
    >
      {busy ? <Spinner /> : <Icon size={13} />}
    </button>
  );
}
