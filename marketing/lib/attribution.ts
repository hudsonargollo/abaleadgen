/**
 * Attribution capture for the intake funnel.
 *
 * Every cold-outreach link carries `?lid=<leadId>&utm_source=…&utm_medium=…
 * &utm_campaign=<batch>&utm_content=<sequence step>` (see the "copy intake
 * link" button on a lead in the Hub). The values are read once on first
 * paint and persisted to sessionStorage, so they survive the visitor
 * scrolling, reloading, or coming back to the tab before finishing — the
 * form always submits the attribution from the ORIGINAL click, not the
 * current URL (which may have been cleaned by the time they submit).
 *
 * `lid` is what ties the submission back to the exact outbound lead. The
 * UTMs are what tie it to the campaign for reporting when `lid` is absent
 * (forwarded link, retyped URL, organic).
 */
export interface Attribution {
  lid: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  referrer: string;
  landing_path: string;
  first_seen_at: string;
}

const KEY = "aba_attribution_v1";
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

export function emptyAttribution(): Attribution {
  return { lid: "", utm_source: "", utm_medium: "", utm_campaign: "", utm_content: "", utm_term: "", referrer: "", landing_path: "", first_seen_at: "" };
}

/** Reads (and on first visit, captures) the attribution. Safe on the server — returns empty. */
export function captureAttribution(): Attribution {
  if (typeof window === "undefined") return emptyAttribution();
  let stored: Attribution | null = null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    stored = raw ? (JSON.parse(raw) as Attribution) : null;
  } catch {
    stored = null;
  }
  const params = new URLSearchParams(window.location.search);
  const fromUrl: Partial<Attribution> = {};
  const lid = params.get("lid") || params.get("lead") || "";
  if (lid) fromUrl.lid = lid.slice(0, 64);
  for (const k of UTM_KEYS) {
    const v = params.get(k);
    if (v) fromUrl[k] = v.slice(0, 120);
  }
  const hasNew = Object.keys(fromUrl).length > 0;
  // A fresh click with its own parameters wins over a stale stored session
  // (the same person may be hit by step 1 and step 3 of the sequence).
  const merged: Attribution = {
    ...emptyAttribution(),
    ...(stored || {}),
    ...(hasNew ? fromUrl : {}),
  };
  if (!merged.first_seen_at) merged.first_seen_at = new Date().toISOString();
  if (!merged.referrer) merged.referrer = (document.referrer || "").slice(0, 300);
  if (!merged.landing_path || hasNew) merged.landing_path = (window.location.pathname + window.location.search).slice(0, 300);
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    /* private mode — still works for this page load */
  }
  return merged;
}

/** Appends attribution to a booking-widget URL so the calendar webhook can
 *  be reconciled to the lead. Cal.com reads `metadata[...]`; Calendly reads
 *  `utm_*`; both accept `name`/`email` prefill. */
export function withBookingParams(url: string, a: Attribution, prefill: { name?: string; email?: string }): string {
  if (!url) return "";
  const u = new URL(url);
  if (prefill.name) u.searchParams.set("name", prefill.name);
  if (prefill.email) u.searchParams.set("email", prefill.email);
  for (const k of UTM_KEYS) if (a[k]) u.searchParams.set(k, a[k]);
  if (a.lid) {
    u.searchParams.set("metadata[lead_id]", a.lid); // Cal.com
    if (!a.utm_content) u.searchParams.set("utm_content", `lid:${a.lid}`); // Calendly fallback
  }
  u.searchParams.set("hide_gdpr_banner", "1");
  return u.toString();
}
