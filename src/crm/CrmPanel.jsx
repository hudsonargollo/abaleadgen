import { useEffect, useState } from "react";
import { ArrowLeft, LayoutGrid, Users, DollarSign, TrendingUp } from "lucide-react";
import CrmDashboard from "@/crm/CrmDashboard";
import CrmLeads from "@/crm/CrmLeads";
import CrmLeadDetail from "@/crm/CrmLeadDetail";
import CrmPayouts from "@/crm/CrmPayouts";

const TABS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutGrid },
  { key: "leads", label: "Pipeline", icon: Users },
  { key: "sales", label: "Payouts", icon: DollarSign },
];

// CRM as an in-Hub panel — same "full-screen view swapped in by App.jsx"
// pattern as CommercialPanel/FinancePanel, but CRM keeps its OWN inner
// vertical sidebar (Dashboard/Pipeline/Vendas) nested inside the Hub's
// outer AppSidebar, without the Links tab, now a top-level Hub panel of its
// own (CrmWaLinks, wired directly in App.jsx/AppSidebar). The CRM used to
// have its own standalone full-page app (crm.html/crm-main.jsx/CrmApp.jsx,
// retired) — the goldplanner-crm Worker (worker/crm-entry.js) still owns the
// CRM's API routes, this panel just calls them via crmApi.js (hardcoded to
// /crm regardless of which bundle it's compiled into).
export default function CrmPanel({ crmRole, userEmail, timezone, onClose }) {
  const [view, setView] = useState({ tab: "dashboard" });

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const activeTab = view.tab === "lead" ? "leads" : view.tab;

  return (
    <div className="flex h-full w-full surface-2">
      {/* Desktop inner sidebar */}
      <aside className="hidden w-44 shrink-0 flex-col border-r border-ink/10 py-4 lg:flex">
        <nav className="flex flex-1 flex-col gap-1 px-2">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setView({ tab: t.key })}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left font-mono text-[11px] tracking-wide transition-colors ${
                  active ? "bg-action/10 text-action" : "text-stone-500 hover:bg-ink/[0.05] hover:text-ink"
                }`}
              >
                <Icon size={15} className="shrink-0" /> {t.label}
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header — back button + label; the inner sidebar above is desktop-only */}
        <div className="flex shrink-0 items-center gap-2 border-b border-ink/15 px-4 py-3 sm:px-6 lg:hidden">
          <button
            onClick={onClose}
            className="-ml-1.5 rounded-lg p-1.5 text-stone-500 hover:bg-ink/[0.05] hover:text-ink"
          >
            <ArrowLeft size={16} />
          </button>
          <TrendingUp size={15} className="text-action" />
          <span className="label-tech">CRM</span>
        </div>

        {/* Mobile tab strip — same lanes as the desktop inner sidebar, horizontal here */}
        {view.tab !== "lead" && (
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-ink/10 px-3 py-2 lg:hidden">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setView({ tab: t.key })}
                className={`shrink-0 rounded-lg px-3 py-1.5 font-mono text-[11px] transition-colors ${
                  activeTab === t.key ? "bg-action text-clay" : "text-stone-500"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {view.tab === "dashboard" && <CrmDashboard isAdmin={crmRole === "admin"} />}
          {view.tab === "leads" && (
            <CrmLeads
              userEmail={userEmail}
              onOpenLead={(id) => setView({ tab: "lead", leadId: id })}
            />
          )}
          {view.tab === "lead" && (
            <CrmLeadDetail
              leadId={view.leadId}
              timezone={timezone}
              userEmail={userEmail}
              onBack={() => setView({ tab: "leads" })}
            />
          )}
          {view.tab === "sales" && <CrmPayouts isAdmin={crmRole === "admin"} timezone={timezone} />}
        </div>
      </div>
    </div>
  );
}
