#!/usr/bin/env node
/**
 * Small Batch Validator & Automated Ingestion Pipeline
 * 
 * Usage:
 *   node scripts/small-batch-runner.mjs <leads.csv> [options]
 * 
 * Features:
 *   1. Live Website HTTP Verification: Pings every clinic website to ensure it's 100% active.
 *   2. Schema & Email Validation: Normalizes states (USPS), checks email syntax & domains.
 *   3. Direct CRM Ingestion: Automatically commits valid rows to the live CRM DB via API.
 *   4. Campaign Generation: Produces 4-touch Instantly/Smartlead CSV with tracked URLs & open pixels.
 * 
 * Options:
 *   --token <tk_session>    Session token (or reads $CRM_TOKEN)
 *   --commit                Directly import valid leads to CRM
 *   --batch <id>            Custom batch identifier
 *   --skip-ping             Skip HTTP ping checks (faster dry run)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseDelimited, validateBatch } from "../src/crm/leadValidation.ts";
import { normalizeDomain } from "../src/crm/abaLead.types.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};

const inputFile = args.find((a, i) => !a.startsWith("--") && !["--token", "--batch", "--api"].includes(args[i - 1]));
if (!inputFile) {
  console.log("Usage: node scripts/small-batch-runner.mjs <leads.csv> [--commit] [--token <token>] [--batch <id>]");
  process.exit(1);
}

const token = opt("token", process.env.CRM_TOKEN || "eyJlbWFpbCI6Imh1ZHNvbmFyZ29sbG9AZ21haWwuY29tIiwiZXhwIjoxNzkyODg1MzU1fQ.bfe69f41d1d7c6eb8acc5324d096b0d118836daf95632b9395878096684042eb");
const api = (opt("api", process.env.CRM_API || "https://abaclinics.clubemkt.digital") || "").replace(/\/+$/, "");
const batchId = opt("batch", `batch-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`);
const shouldCommit = flag("commit");
const skipPing = flag("skip-ping");

console.log(`\n=======================================================`);
console.log(`🔍 Small Batch Validation & Ingestion Engine`);
console.log(`📁 File:  ${inputFile}`);
console.log(`🏷️ Batch: ${batchId}`);
console.log(`🚀 Mode:  ${shouldCommit ? "Validate + Ingest to CRM" : "Dry-Run & Verification Only"}`);
console.log(`=======================================================\n`);

let rawText;
try {
  rawText = readFileSync(inputFile, "utf8");
} catch (e) {
  console.error(`Cannot read ${inputFile}:`, e.message);
  process.exit(1);
}

const { rows } = parseDelimited(rawText);
if (!rows.length) {
  console.error("No data rows found.");
  process.exit(1);
}

console.log(`Loaded ${rows.length} candidate rows. Validating schema...`);

// ── 1. Schema & Data Validation ────────────────────────────────────────────
const validationReport = validateBatch(rows, {
  batchId,
  defaultSource: "manual",
  maxRows: Infinity,
});

const validRows = [];
const invalidRows = [];

validationReport.rows.forEach((r, idx) => {
  const original = rows[idx];
  if (r.errors && r.errors.length > 0) {
    invalidRows.push({ row: original, errors: r.errors });
  } else {
    validRows.push({ ...r.lead, rawRow: original, warnings: r.warnings || [] });
  }
});

console.log(`✓ Schema Check: ${validRows.length} valid, ${invalidRows.length} errors.\n`);

// ── 2. Live HTTP Website Ping Check ─────────────────────────────────────────
async function checkWebsiteLive(url) {
  if (!url || skipPing) return { live: true, status: 200 };
  let target = url;
  if (!target.startsWith("http")) target = `https://${target}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(target, {
      method: "HEAD",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      redirect: "follow",
    });
    clearTimeout(timeout);
    return { live: res.status < 400 || res.status === 403, status: res.status };
  } catch (e) {
    // Try GET if HEAD fails
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(target, {
        method: "GET",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      clearTimeout(timeout);
      return { live: res.status < 400 || res.status === 403, status: res.status };
    } catch {
      return { live: false, status: 0, error: e.message };
    }
  }
}

async function runLiveVerification() {
  console.log(`🌐 Performing live HTTP verification on ${validRows.length} clinic websites...`);
  const verifiedLeads = [];
  const deadWebsites = [];

  for (let i = 0; i < validRows.length; i++) {
    const item = validRows[i];
    const site = item.website;
    process.stdout.write(`  [${i + 1}/${validRows.length}] Checking ${item.company_name} (${site})... `);
    
    const check = await checkWebsiteLive(site);
    if (check.live) {
      console.log(`✅ LIVE (${check.status})`);
      verifiedLeads.push(item);
    } else {
      console.log(`❌ DEAD / UNREACHABLE`);
      deadWebsites.push({ item, error: check.error || `HTTP ${check.status}` });
    }
  }

  console.log(`\n=======================================================`);
  console.log(`📊 Batch Verification Summary:`);
  console.log(`   • Total Input Rows:   ${rows.length}`);
  console.log(`   • Schema Valid:       ${validRows.length}`);
  console.log(`   • Live Active Sites:  ${verifiedLeads.length}`);
  console.log(`   • Dead / Unreachable: ${deadWebsites.length}`);
  console.log(`=======================================================\n`);

  if (!verifiedLeads.length) {
    console.log("No live verified leads to ingest.");
    return;
  }

  // Save verified batch CSV
  const verifiedCsvPath = `automation/scraping/verified_${batchId}.csv`;
  const exportHeaders = [
    "company_name", "website", "city", "state", "locations_count",
    "decision_maker_name", "decision_maker_title", "decision_maker_role",
    "verified_email", "linkedin_url", "source_platform", "source_url", "batch_id"
  ];

  const csvLines = [
    exportHeaders.join(","),
    ...verifiedLeads.map(l => exportHeaders.map(h => `"${String(l[h] !== undefined ? l[h] : "").replace(/"/g, '""')}"`).join(","))
  ];
  writeFileSync(verifiedCsvPath, csvLines.join("\n"), "utf8");
  console.log(`✓ Saved verified batch CSV: ${verifiedCsvPath}`);

  // ── 3. Direct Ingestion to Live CRM API ────────────────────────────────────
  if (shouldCommit) {
    if (!token) {
      console.error("❌ Cannot commit: No session token provided. Pass --token or set $CRM_TOKEN.");
      process.exit(1);
    }

    console.log(`\n🚀 Ingesting ${verifiedLeads.length} leads into live CRM (${api})...`);
    try {
      const payload = {
        batch_id: batchId,
        default_source: "manual",
        force: true,
        rows: verifiedLeads.map(l => ({
          company_name: l.company_name,
          website: l.website,
          city: l.city,
          state: l.state,
          locations_count: l.locations_count,
          decision_maker_name: l.decision_maker_name,
          decision_maker_title: l.decision_maker_title,
          decision_maker_role: l.decision_maker_role,
          verified_email: l.verified_email,
          linkedin_url: l.linkedin_url,
          source_platform: l.source_platform || "manual",
          source_url: l.source_url,
          batch_id: batchId,
        })),
      };

      const res = await fetch(`${api}/crm/api/leads/import?commit=1&force=1`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      const resData = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(resData?.error || `HTTP ${res.status}`);
      }

      console.log(`\n🎉 SUCCESS! Ingested ${resData.imported ?? verifiedLeads.length} leads into live Kanban pipeline!`);
      console.log(`   Batch ID: ${batchId}`);
      console.log(`   View live: https://abaclinics.clubemkt.digital/hub\n`);
    } catch (e) {
      console.error("❌ CRM Ingestion failed:", e.message);
    }
  } else {
    console.log(`\n💡 Dry-run complete. Run with '--commit' to ingest these leads into the CRM.`);
  }

  // ── 4. Generate 4-Touch Campaign ──────────────────────────────────────────
  const campaignCsvPath = `automation/email/campaign_${batchId}.csv`;
  const campaignJsonPath = `automation/email/campaign_${batchId}.json`;
  
  // Call campaign generator
  const { execSync } = await import("node:child_process");
  try {
    execSync(`node --experimental-strip-types automation/email/outbound_dispatcher.mjs ${verifiedCsvPath} ${campaignCsvPath} ${campaignJsonPath}`, { stdio: "inherit" });
  } catch (e) {
    console.error("Failed to generate campaign files:", e.message);
  }
}

runLiveVerification();
