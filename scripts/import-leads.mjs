#!/usr/bin/env node
// Batch lead importer for the ABA pipeline.
//
//   npm run import:leads -- <file.csv|tsv> [options]
//
// Modes (safest first — nothing is written unless you say --commit):
//   (default)     offline validation only: syntax, state normalization,
//                 role-based email flags, in-file duplicates. No network.
//   --dry-run     same, but via the API so DB duplicates are detected too.
//   --commit      dry-run first, then import if the dry-run has no errors
//                 (or --force to import the valid rows and skip the rest).
//
// Options:
//   --batch <id>          batch_id stamped on every row (default: pilot-YYYY-MM-DD)
//   --source <platform>   default source_platform for rows without one
//                         (aba_index | google_maps | linkedin_sales_nav | apollo | state_directory | manual)
//   --api <base>          API origin, default $CRM_API or https://abaclinics.clubemkt.digital
//   --token <t>           session token (or $CRM_TOKEN) — log in at /hub, copy the
//                         tk_session cookie value. Sent as Authorization: Bearer.
//   --reject-role-emails  treat info@/support@/… as errors instead of warnings
//   --require-email       rows without an email are errors
//   --json                machine-readable report on stdout
//   --out <file.json>     also write the report to a file
//   --chunk <n>           rows per API call (default 200, max 500)
//
// Exit codes: 0 clean, 1 validation errors/duplicates, 2 usage/network error.
import { readFileSync, writeFileSync } from "node:fs";
import { validateBatch, parseDelimited, formatRowResult } from "../src/crm/leadValidation.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const VALUE_OPTS = new Set(["--batch", "--source", "--api", "--token", "--out", "--chunk"]);
const file = args.find((a, i) => !a.startsWith("--") && !VALUE_OPTS.has(args[i - 1]));
if (!file) {
  console.error("usage: import-leads.mjs <file.csv> [--dry-run|--commit] [--batch id] [--source platform] [--api url] [--token t]");
  process.exit(2);
}

const batch = opt("batch", `pilot-${new Date().toISOString().slice(0, 10)}`);
const source = opt("source", "manual");
const api = (opt("api", process.env.CRM_API || "https://abaclinics.clubemkt.digital") || "").replace(/\/+$/, "");
const token = opt("token", process.env.CRM_TOKEN || "");
const chunkSize = Math.min(500, Math.max(1, Number(opt("chunk", 200)) || 200));
const asJson = flag("json");
const outFile = opt("out", null);
const mode = flag("commit") ? "commit" : flag("dry-run") ? "dry-run" : "offline";

let text;
try {
  text = readFileSync(file, "utf8");
} catch (e) {
  console.error(`cannot read ${file}: ${e.message}`);
  process.exit(2);
}
const { headers, rows, delimiter } = parseDelimited(text);
if (!rows.length) {
  console.error("no data rows found (is there a header line?)");
  process.exit(2);
}

const log = (...a) => !asJson && console.log(...a);
log(`file: ${file}  (${rows.length} rows, delimiter ${JSON.stringify(delimiter)})`);
log(`columns: ${headers.join(", ")}`);
log(`mode: ${mode}  batch: ${batch}  default source: ${source}\n`);

// ── 1. offline validation (always) ─────────────────────────────────────────
const localReport = validateBatch(rows, {
  batchId: batch,
  defaultSource: source,
  rejectRoleEmails: flag("reject-role-emails"),
  requireEmail: flag("require-email"),
  maxRows: Infinity,
});

function printReport(report, title) {
  const s = report.summary;
  log(`── ${title} ──────────────────────────────────────`);
  for (const r of report.rows) if (r.status !== "valid" || r.warnings.length) log(formatRowResult(r));
  log(`\n${s.total} rows · ${s.valid} valid · ${s.errors} errors · ${s.duplicates} duplicates · ${s.warnings} with warnings`);
  if (s.unmappedColumns.length) log(`ignored columns: ${s.unmappedColumns.join(", ")}`);
  const top = Object.entries(s.byIssue).sort((a, b) => b[1] - a[1]);
  if (top.length) log("issues: " + top.map(([k, v]) => `${k}×${v}`).join("  "));
  log("");
}

if (mode === "offline") {
  printReport(localReport, "offline validation");
  finish(localReport, null);
}

// ── 2. server-side dry run (adds DB duplicate detection) ───────────────────
if (!token) {
  console.error("--token (or $CRM_TOKEN) is required for --dry-run / --commit");
  process.exit(2);
}

async function post(body) {
  const res = await fetch(`${api}/crm/api/leads/import`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${res.status} ${json?.error || res.statusText}`);
  return json;
}

function mergeReports(parts) {
  // Re-number rows across chunks so they match the file.
  let offset = 0;
  const merged = { summary: { total: 0, valid: 0, errors: 0, duplicates: 0, warnings: 0, byIssue: {}, unmappedColumns: [] }, rows: [] };
  for (const p of parts) {
    for (const r of p.rows) merged.rows.push({ ...r, row: r.row + offset });
    offset += p.summary.total;
    for (const k of ["total", "valid", "errors", "duplicates", "warnings"]) merged.summary[k] += p.summary[k];
    for (const [k, v] of Object.entries(p.summary.byIssue)) merged.summary.byIssue[k] = (merged.summary.byIssue[k] || 0) + v;
    merged.summary.unmappedColumns = p.summary.unmappedColumns;
  }
  return merged;
}

const common = { batch_id: batch, source, reject_role_emails: flag("reject-role-emails"), require_email: flag("require-email") };
const chunks = [];
for (let i = 0; i < rows.length; i += chunkSize) chunks.push(rows.slice(i, i + chunkSize));

let dryParts;
try {
  dryParts = [];
  for (const [i, chunk] of chunks.entries()) {
    log(`dry-run chunk ${i + 1}/${chunks.length} (${chunk.length} rows)…`);
    dryParts.push(await post({ ...common, rows: chunk, dry_run: true }));
  }
} catch (e) {
  console.error(`API error: ${e.message}`);
  process.exit(2);
}
const dryReport = mergeReports(dryParts);
// Cross-chunk in-file duplicates aren't visible to the server; layer the local ones back in.
for (const local of localReport.rows) {
  const remote = dryReport.rows[local.row - 1];
  if (remote && remote.status === "valid" && local.status === "duplicate") {
    remote.status = "duplicate";
    remote.errors.push(...local.errors);
    dryReport.summary.valid--;
    dryReport.summary.duplicates++;
  }
}
printReport(dryReport, "server dry-run (with DB duplicate check)");

if (mode === "dry-run") finish(dryReport, null);

// ── 3. commit ──────────────────────────────────────────────────────────────
const blocked = dryReport.summary.errors + dryReport.summary.duplicates;
if (blocked && !flag("force")) {
  console.error(`refusing to import: ${blocked} row(s) have errors or are duplicates. Fix the file, or pass --force to import only the ${dryReport.summary.valid} valid rows.`);
  finish(dryReport, null, 1);
}
let created = 0;
const commitParts = [];
try {
  for (const [i, chunk] of chunks.entries()) {
    log(`importing chunk ${i + 1}/${chunks.length}…`);
    const res = await post({ ...common, rows: chunk, dry_run: false });
    created += res.created;
    commitParts.push(res);
  }
} catch (e) {
  console.error(`API error mid-import after ${created} rows: ${e.message} — re-running is safe (duplicates are skipped).`);
  process.exit(2);
}
const commitReport = mergeReports(commitParts);
log(`\n✓ imported ${created} lead(s) into batch "${batch}" as sourced.`);
finish(commitReport, created);

function finish(report, createdCount, code) {
  const exit = code ?? (report.summary.errors + report.summary.duplicates > 0 ? 1 : 0);
  const payload = { mode, batch, created: createdCount, ...report };
  if (outFile) writeFileSync(outFile, JSON.stringify(payload, null, 2));
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  process.exit(exit);
}
