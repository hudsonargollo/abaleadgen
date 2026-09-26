/**
 * Lead batch validation — pure, dependency-free, shared by:
 *   - worker/crm-entry.js   POST /crm/api/leads/import  (dry_run + commit)
 *   - scripts/import-leads.mjs  CLI (offline validation, dry-run, commit)
 *   - src/crm/CrmLeads.jsx  Import modal preview
 *
 * Contract: validateBatch(rawRows) → ValidationReport. Nothing here touches
 * a database; DB-side duplicate detection is layered on by the caller via
 * `existing` (see BatchOptions).
 *
 * Severity model:
 *   error   → row is NOT imported (bad syntax, bad state, missing identity,
 *             duplicate in file or DB)
 *   warning → row IS imported, flag rides along in the report and, for
 *             role-based emails, on the row (email_verification_status='risky')
 */
import {
  SOURCE_PLATFORMS,
  PRIORITY_STATES,
  normalizeDomain,
  type SourcePlatform,
  type CreateAbaLeadInput,
  type EmailVerificationStatus,
} from "./abaLead.types.ts";

// ── CSV / TSV parsing (RFC-4180-ish: quoted fields, doubled quotes, CRLF) ──

export function parseDelimited(text: string): { headers: string[]; rows: Record<string, string>[]; delimiter: string } {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.includes("\t") ? "\t" : firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      if (record.some((c) => c.trim() !== "")) records.push(record);
      record = [];
    } else field += ch;
  }
  record.push(field);
  if (record.some((c) => c.trim() !== "")) records.push(record);
  if (!records.length) return { headers: [], rows: [], delimiter };
  const headers = records[0].map((h) => h.trim().toLowerCase());
  const rows = records.slice(1).map((cells) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) row[h] = (cells[i] ?? "").trim();
    });
    return row;
  });
  return { headers, rows, delimiter };
}

// ── Header aliases → canonical field names ─────────────────────────────────

export const HEADER_ALIASES: Record<keyof CreateAbaLeadInput, string[]> = {
  company_name: ["company_name", "company", "company name", "clinic", "clinic name", "organization", "organisation", "account", "account name", "business", "business name", "name of practice", "practice"],
  website: ["website", "url", "site", "company website", "website url", "domain", "web"],
  city: ["city", "town", "locality"],
  state: ["state", "st", "region", "province", "state/region", "company state"],
  locations_count: ["locations_count", "locations", "# locations", "num locations", "number of locations", "location count"],
  est_arr_bucket: ["est_arr_bucket", "arr", "arr bucket", "revenue bucket", "est arr"],
  decision_maker_name: ["decision_maker_name", "decision maker", "decision maker name", "name", "contact", "contact name", "full name", "first and last name", "person", "owner name"],
  decision_maker_title: ["decision_maker_title", "title", "job title", "role", "position", "contact title"],
  decision_maker_role: ["decision_maker_role", "role_normalized", "dm role"],
  verified_email: ["verified_email", "email", "e-mail", "verified email", "work email", "email address", "contact email"],
  email_verification_status: ["email_verification_status", "email status", "verification", "email verification"],
  linkedin_url: ["linkedin_url", "linkedin", "linkedin url", "person linkedin url", "profile url", "linkedin profile"],
  source_platform: ["source_platform", "source", "source platform", "platform", "lead source"],
  source_url: ["source_url", "source url", "listing url", "listing", "maps url", "google maps url"],
  batch_id: ["batch_id", "batch", "batch id"],
  icp_fit: ["icp_fit", "icp", "fit"],
  notes: ["notes", "note", "comments", "comment", "remarks"],
};

const ALIAS_LOOKUP: Record<string, keyof CreateAbaLeadInput> = {};
for (const [field, aliases] of Object.entries(HEADER_ALIASES)) for (const a of aliases) ALIAS_LOOKUP[a] = field as keyof CreateAbaLeadInput;

/** Maps a header (any alias, any case) to its canonical field, or null. */
export function canonicalField(header: string): keyof CreateAbaLeadInput | null {
  return ALIAS_LOOKUP[header.trim().toLowerCase()] ?? null;
}

/** Remaps a raw row's keys through the alias table. Unknown keys are dropped
 *  and reported so the sourcer can see what didn't map. */
export function remapRow(raw: Record<string, unknown>): { row: Partial<Record<keyof CreateAbaLeadInput, unknown>>; unmapped: string[] } {
  const row: Partial<Record<keyof CreateAbaLeadInput, unknown>> = {};
  const unmapped: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const f = canonicalField(k);
    if (f) {
      if (row[f] === undefined || row[f] === "" || row[f] === null) row[f] = v;
    } else unmapped.push(k);
  }
  return { row, unmapped };
}

// ── US states ──────────────────────────────────────────────────────────────

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
  WY: "Wyoming", DC: "District of Columbia", PR: "Puerto Rico",
};
const STATE_BY_NAME: Record<string, string> = {};
for (const [abbr, name] of Object.entries(US_STATES)) STATE_BY_NAME[name.toLowerCase()] = abbr;
STATE_BY_NAME["washington dc"] = "DC";
STATE_BY_NAME["washington d.c."] = "DC";

/** "tx" | "Texas" | " TX, USA" | "Texas, United States" → "TX"; null when
 *  empty; undefined when non-empty but unrecognizable. */
export function normalizeState(input: unknown): string | null | undefined {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;
  // "Austin, TX 78701" / "TX, USA" / "Texas, United States" → take the state-looking token
  s = s.replace(/\b(usa|u\.s\.a\.|united states( of america)?|us)\b\.?/gi, "").replace(/\d{5}(-\d{4})?/g, "").replace(/[,.]+$/g, "").trim();
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const candidates = parts.length ? [parts[parts.length - 1], ...parts] : [s];
  for (const c of candidates) {
    const up = c.toUpperCase().replace(/\./g, "");
    if (US_STATES[up]) return up;
    const byName = STATE_BY_NAME[c.toLowerCase()];
    if (byName) return byName;
  }
  return undefined;
}

// ── Email ──────────────────────────────────────────────────────────────────

// Pragmatic RFC 5322 subset: one @, dot in domain, no spaces, sane charset.
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export const ROLE_LOCAL_PARTS = new Set([
  "info", "support", "admin", "administrator", "office", "contact", "contactus", "hello", "hi", "sales", "billing",
  "accounts", "accounting", "hr", "careers", "jobs", "recruiting", "team", "help", "marketing", "frontdesk", "front.desk",
  "intake", "referrals", "referral", "enquiries", "inquiries", "inquiry", "noreply", "no-reply", "no_reply", "donotreply",
  "postmaster", "webmaster", "mail", "email", "reception", "scheduling", "clinic", "services", "care", "staff",
  "management", "director", "ceo", "owner", "founder", "general", "abuse", "privacy", "legal", "press", "media",
]);

export const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "live.com", "msn.com",
  "protonmail.com", "proton.me", "ymail.com", "comcast.net", "att.net", "verizon.net", "sbcglobal.net",
]);

export interface EmailCheck {
  email: string | null;
  valid: boolean;
  roleBased: boolean;
  freemail: boolean;
  domain: string | null;
}

export function checkEmail(input: unknown): EmailCheck {
  if (input === null || input === undefined) return { email: null, valid: false, roleBased: false, freemail: false, domain: null };
  let s = String(input).trim().toLowerCase();
  // "Jane Doe <jane@x.com>" and "mailto:jane@x.com"
  const angled = s.match(/<([^>]+)>/);
  if (angled) s = angled[1].trim();
  s = s.replace(/^mailto:/, "");
  if (!s) return { email: null, valid: false, roleBased: false, freemail: false, domain: null };
  const valid = EMAIL_RE.test(s) && s.length <= 254;
  const [local = "", domain = ""] = s.split("@");
  const localBase = local.split("+")[0];
  const roleBased = valid && (ROLE_LOCAL_PARTS.has(localBase) || /^(info|support|admin|office|contact|sales|billing|hr)[._-]?/i.test(localBase) && localBase.length <= 12);
  return { email: s, valid, roleBased, freemail: valid && FREEMAIL_DOMAINS.has(domain), domain: valid ? domain : null };
}

// ── Row validation ─────────────────────────────────────────────────────────

export type IssueCode =
  | "missing_identity" // no company_name AND no website
  | "invalid_website"
  | "invalid_email"
  | "invalid_state"
  | "invalid_locations_count"
  | "invalid_linkedin_url"
  | "duplicate_domain_in_file"
  | "duplicate_email_in_file"
  | "duplicate_domain_in_db"
  | "duplicate_email_in_db"
  | "role_based_email"
  | "freemail_domain"
  | "email_domain_mismatch"
  | "missing_email"
  | "missing_decision_maker"
  | "missing_state"
  | "non_priority_state"
  | "unknown_source_platform"
  | "unmapped_columns"
  | "row_limit_exceeded";

export interface Issue {
  code: IssueCode;
  message: string;
  field?: string;
  value?: string;
}

export interface RowResult {
  /** 1-based data row number (header excluded), i.e. spreadsheet row − 1. */
  row: number;
  status: "valid" | "error" | "duplicate";
  errors: Issue[];
  warnings: Issue[];
  /** Fully normalized, DB-ready fields (only meaningful when status !== "error"). */
  lead: NormalizedLead;
  /** Set by the caller after commit. */
  leadId?: string;
  /** For duplicates against the DB: the existing lead's id. */
  existingLeadId?: string;
  /** Source columns that matched no known field (batch summary unions these). */
  unmapped?: string[];
}

export interface NormalizedLead {
  company_name: string | null;
  website: string | null;
  website_domain: string | null;
  city: string | null;
  state: string | null;
  locations_count: number | null;
  est_arr_bucket: string | null;
  decision_maker_name: string | null;
  decision_maker_title: string | null;
  decision_maker_role: string | null;
  verified_email: string | null;
  email_verification_status: EmailVerificationStatus;
  linkedin_url: string | null;
  source_platform: SourcePlatform;
  source_url: string | null;
  batch_id: string | null;
  icp_fit: "fit" | "unfit" | "unknown";
  notes: string | null;
}

export interface BatchOptions {
  /** Applied to rows that don't carry their own batch_id. */
  batchId?: string | null;
  /** Applied to rows whose source_platform is missing/unrecognized. */
  defaultSource?: SourcePlatform;
  /** Existing keys from the DB for duplicate detection. */
  existing?: { byDomain?: Map<string, string>; byEmail?: Map<string, string> };
  /** Treat role-based emails as errors instead of warnings. Default false. */
  rejectRoleEmails?: boolean;
  /** Treat a missing email as an error. Default false (sourcing may enrich later). */
  requireEmail?: boolean;
  /** Hard cap; rows beyond it get row_limit_exceeded. Default 500. */
  maxRows?: number;
}

export interface ValidationReport {
  summary: {
    total: number;
    valid: number;
    errors: number;
    duplicates: number;
    warnings: number;
    byIssue: Partial<Record<IssueCode, number>>;
    unmappedColumns: string[];
  };
  rows: RowResult[];
}

const str = (v: unknown, max = 300): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim().slice(0, max);
  return t || null;
};

function inferRole(title: string | null): NormalizedLead["decision_maker_role"] {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/founder|co-founder|cofounder/.test(t)) return "founder";
  if (/owner|proprietor|principal/.test(t)) return "owner";
  if (/\bceo\b|chief executive|president/.test(t)) return "ceo";
  if (/executive director|exec\.? director|managing director/.test(t)) return "exec_director";
  return "other";
}

export function validateRow(raw: Record<string, unknown>, index: number, opts: BatchOptions = {}): RowResult {
  const { row, unmapped } = remapRow(raw);
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (code: IssueCode, message: string, field?: string, value?: unknown) => errors.push({ code, message, field, value: value == null ? undefined : String(value) });
  const warn = (code: IssueCode, message: string, field?: string, value?: unknown) => warnings.push({ code, message, field, value: value == null ? undefined : String(value) });

  // company / website
  const company = str(row.company_name);
  const websiteRaw = str(row.website, 500);
  let website: string | null = null;
  let domain: string | null = null;
  if (websiteRaw) {
    domain = normalizeDomain(websiteRaw);
    if (!domain || !domain.includes(".") || /\s/.test(domain) || domain.length > 253) {
      err("invalid_website", `Website "${websiteRaw}" is not a valid URL or domain`, "website", websiteRaw);
      domain = null;
    } else {
      website = /^https?:\/\//i.test(websiteRaw) ? websiteRaw : `https://${domain}`;
    }
  }
  if (!company && !domain) err("missing_identity", "Row needs at least a company name or a website", "company_name");

  // email
  const emailRaw = row.verified_email;
  const ec = checkEmail(emailRaw);
  let email: string | null = null;
  let emailStatus: EmailVerificationStatus = "unverified";
  if (emailRaw !== undefined && emailRaw !== null && String(emailRaw).trim() !== "") {
    if (!ec.valid) err("invalid_email", `Email "${String(emailRaw).trim()}" is not valid`, "verified_email", emailRaw);
    else {
      email = ec.email;
      if (ec.roleBased) {
        const msg = `"${email}" looks like a role-based address (not a person)`;
        if (opts.rejectRoleEmails) err("role_based_email", msg, "verified_email", email);
        else {
          warn("role_based_email", msg, "verified_email", email);
          emailStatus = "risky";
        }
      }
      if (ec.freemail) warn("freemail_domain", `"${email}" is on a free mail provider — verify it belongs to the owner`, "verified_email", email);
      else if (domain && ec.domain && ec.domain !== domain && !ec.domain.endsWith(`.${domain}`) && !domain.endsWith(`.${ec.domain}`)) {
        warn("email_domain_mismatch", `Email domain "${ec.domain}" ≠ website domain "${domain}"`, "verified_email", email);
      }
      const explicit = str(row.email_verification_status, 20)?.toLowerCase();
      if (explicit && ["unverified", "valid", "risky", "invalid"].includes(explicit)) {
        if (explicit === "invalid") err("invalid_email", `Email "${email}" is marked invalid by the verifier`, "verified_email", email);
        else if (!(emailStatus === "risky" && explicit === "valid")) emailStatus = explicit as EmailVerificationStatus;
      }
    }
  } else if (opts.requireEmail) err("missing_email", "Email is required", "verified_email");
  else warn("missing_email", "No email — lead can be sourced but not contacted until enriched", "verified_email");

  // state
  const stateNorm = normalizeState(row.state);
  let state: string | null = null;
  if (stateNorm === undefined) err("invalid_state", `State "${String(row.state).trim()}" is not a recognized US state`, "state", row.state);
  else if (stateNorm === null) warn("missing_state", "No state — regional filtering won't include this lead", "state");
  else {
    state = stateNorm;
    if (!PRIORITY_STATES.includes(state)) warn("non_priority_state", `${state} is outside the priority-state list`, "state", state);
  }

  // locations
  let locations: number | null = null;
  const locRaw = row.locations_count;
  if (locRaw !== undefined && locRaw !== null && String(locRaw).trim() !== "") {
    const n = Number(String(locRaw).replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(n) || n < 1 || n > 1000) err("invalid_locations_count", `Locations "${locRaw}" must be a positive number`, "locations_count", locRaw);
    else locations = Math.round(n);
  }

  // decision maker
  const dmName = str(row.decision_maker_name, 200);
  const dmTitle = str(row.decision_maker_title, 200);
  if (!dmName) warn("missing_decision_maker", "No decision-maker name", "decision_maker_name");
  const dmRoleRaw = str(row.decision_maker_role, 30)?.toLowerCase();
  const dmRole = dmRoleRaw && ["founder", "owner", "ceo", "exec_director", "other"].includes(dmRoleRaw) ? (dmRoleRaw as NormalizedLead["decision_maker_role"]) : inferRole(dmTitle);

  // linkedin
  let linkedin = str(row.linkedin_url, 500);
  if (linkedin) {
    if (!/^https?:\/\//i.test(linkedin)) linkedin = `https://${linkedin.replace(/^\/+/, "")}`;
    if (!/linkedin\.com\/(in|company)\//i.test(linkedin)) {
      err("invalid_linkedin_url", `LinkedIn URL "${linkedin}" must be a linkedin.com/in/… or /company/… link`, "linkedin_url", linkedin);
    }
  }

  // source
  const srcRaw = str(row.source_platform, 40)?.toLowerCase().replace(/[\s-]+/g, "_");
  const srcAlias: Record<string, SourcePlatform> = { theabaindex: "aba_index", the_aba_index: "aba_index", abaindex: "aba_index", maps: "google_maps", gmaps: "google_maps", google: "google_maps", sales_navigator: "linkedin_sales_nav", sales_nav: "linkedin_sales_nav", linkedin: "linkedin_sales_nav", apollo_io: "apollo", directory: "state_directory" };
  let source: SourcePlatform = opts.defaultSource ?? "manual";
  if (srcRaw) {
    if ((SOURCE_PLATFORMS as readonly string[]).includes(srcRaw)) source = srcRaw as SourcePlatform;
    else if (srcAlias[srcRaw]) source = srcAlias[srcRaw];
    else warn("unknown_source_platform", `Source "${srcRaw}" not recognized — defaulted to ${source}`, "source_platform", srcRaw);
  }

  const icpRaw = str(row.icp_fit, 10)?.toLowerCase();
  const icp: NormalizedLead["icp_fit"] = icpRaw === "fit" || icpRaw === "unfit" ? icpRaw : "unknown";

  const lead: NormalizedLead = {
    company_name: company,
    website,
    website_domain: domain,
    city: str(row.city, 120),
    state,
    locations_count: locations,
    est_arr_bucket: str(row.est_arr_bucket, 20),
    decision_maker_name: dmName,
    decision_maker_title: dmTitle,
    decision_maker_role: dmRole,
    verified_email: email,
    email_verification_status: emailStatus,
    linkedin_url: linkedin,
    source_platform: source,
    source_url: str(row.source_url, 1000),
    batch_id: str(row.batch_id, 60) ?? (opts.batchId ? String(opts.batchId).slice(0, 60) : null),
    icp_fit: icp,
    notes: str(row.notes, 5000),
  };

  return { row: index, status: errors.length ? "error" : "valid", errors, warnings, lead, unmapped };
}

/** Validates every row, then runs in-file and DB duplicate detection over
 *  the rows that survived. Row order is preserved; the first occurrence of
 *  a key wins, later ones become duplicates. */
export function validateBatch(rawRows: Record<string, unknown>[], opts: BatchOptions = {}): ValidationReport {
  const maxRows = opts.maxRows ?? 500;
  const rows: RowResult[] = rawRows.map((raw, i) => {
    if (i >= maxRows) {
      const r = validateRow(raw, i + 1, opts);
      r.errors.unshift({ code: "row_limit_exceeded", message: `Only the first ${maxRows} rows are processed per batch` });
      r.status = "error";
      return r;
    }
    return validateRow(raw, i + 1, opts);
  });

  const seenDomain = new Map<string, number>();
  const seenEmail = new Map<string, number>();
  const dbDomain = opts.existing?.byDomain;
  const dbEmail = opts.existing?.byEmail;
  for (const r of rows) {
    if (r.status === "error") continue;
    const d = r.lead.website_domain;
    const e = r.lead.verified_email;
    if (d && dbDomain?.has(d)) {
      r.status = "duplicate";
      r.existingLeadId = dbDomain.get(d);
      r.errors.push({ code: "duplicate_domain_in_db", message: `Domain "${d}" already exists (lead ${r.existingLeadId})`, field: "website", value: d });
    } else if (e && dbEmail?.has(e)) {
      r.status = "duplicate";
      r.existingLeadId = dbEmail.get(e);
      r.errors.push({ code: "duplicate_email_in_db", message: `Email "${e}" already exists (lead ${r.existingLeadId})`, field: "verified_email", value: e });
    } else if (d && seenDomain.has(d)) {
      r.status = "duplicate";
      r.errors.push({ code: "duplicate_domain_in_file", message: `Domain "${d}" duplicates row ${seenDomain.get(d)}`, field: "website", value: d });
    } else if (e && seenEmail.has(e)) {
      r.status = "duplicate";
      r.errors.push({ code: "duplicate_email_in_file", message: `Email "${e}" duplicates row ${seenEmail.get(e)}`, field: "verified_email", value: e });
    } else {
      if (d) seenDomain.set(d, r.row);
      if (e) seenEmail.set(e, r.row);
    }
  }

  const byIssue: Partial<Record<IssueCode, number>> = {};
  let warningsTotal = 0;
  for (const r of rows) {
    for (const i of [...r.errors, ...r.warnings]) byIssue[i.code] = (byIssue[i.code] || 0) + 1;
    if (r.warnings.length) warningsTotal++;
  }
  const unmappedColumns = [...new Set(rows.flatMap((r) => r.unmapped ?? []))];
  if (unmappedColumns.length) byIssue.unmapped_columns = unmappedColumns.length;

  return {
    summary: {
      total: rows.length,
      valid: rows.filter((r) => r.status === "valid").length,
      errors: rows.filter((r) => r.status === "error").length,
      duplicates: rows.filter((r) => r.status === "duplicate").length,
      warnings: warningsTotal,
      byIssue,
      unmappedColumns,
    },
    rows,
  };
}

/** Human-readable one-liner per row, for CLI/terminal output. */
export function formatRowResult(r: RowResult): string {
  const id = r.lead.company_name || r.lead.website_domain || "(no identity)";
  const tag = r.status === "valid" ? "OK " : r.status === "duplicate" ? "DUP" : "ERR";
  const issues = [...r.errors.map((e) => `✗ ${e.message}`), ...r.warnings.map((w) => `⚠ ${w.message}`)];
  return `${tag} row ${String(r.row).padStart(4)}  ${id}${issues.length ? "\n      " + issues.join("\n      ") : ""}`;
}
