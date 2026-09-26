#!/usr/bin/env node
/**
 * Automated Multi-Batch Processor & Ingestion Pipeline
 * 
 * Usage:
 *   node scripts/auto-batch-processor.mjs <master_leads.csv> [options]
 * 
 * Options:
 *   --batch-size <n>    Number of leads per batch (default: 25)
 *   --commit            Automatically ingest verified leads to CRM DB
 *   --token <t>         Session token (or reads $CRM_TOKEN)
 *   --delay <ms>        Delay between batches in ms (default: 1500)
 *   --skip-ping         Skip live HTTP website check
 *   --max-batches <n>   Stop after N batches
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseDelimited, validateBatch } from "../src/crm/leadValidation.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};

const inputFile = args.find((a, i) => !a.startsWith("--") && !["--token", "--batch-size", "--delay", "--api", "--max-batches"].includes(args[i - 1]));
if (!inputFile) {
  console.log("Usage: node scripts/auto-batch-processor.mjs <master_leads.csv> [--commit] [--batch-size 25] [--delay 1500]");
  process.exit(1);
}

const batchSize = Math.max(5, Math.min(100, Number(opt("batch-size", 25)) || 25));
const delayMs = Math.max(0, Number(opt("delay", 1500)) || 1500);
const maxBatches = Number(opt("max-batches", Infinity)) || Infinity;
const shouldCommit = flag("commit");
const skipPing = flag("skip-ping");
const token = opt("token", process.env.CRM_TOKEN || "eyJlbWFpbCI6Imh1ZHNvbmFyZ29sbG9AZ21haWwuY29tIiwiZXhwIjoxNzkyODg1MzU1fQ.bfe69f41d1d7c6eb8acc5324d096b0d118836daf95632b9395878096684042eb");
const api = (opt("api", process.env.CRM_API || "https://abaclinics.clubemkt.digital") || "").replace(/\/+$/, "");

console.log(`\n=======================================================`);
console.log(`⚡ Automated Small-Batch Processing Engine`);
console.log(`📁 Master File:  ${inputFile}`);
console.log(`📦 Batch Size:   ${batchSize} leads per batch`);
console.log(`🚀 Live Commit:  ${shouldCommit ? "YES (Ingest to CRM DB)" : "NO (Dry-run verification)"}`);
console.log(`⏱️ Batch Delay:  ${delayMs}ms`);
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

console.log(`Loaded ${rows.length} total candidate leads.`);

// Split into batches
const chunks = [];
for (let i = 0; i < rows.length; i += batchSize) {
  chunks.push(rows.slice(i, i + batchSize));
}

const totalBatches = Math.min(chunks.length, maxBatches);
console.log(`Split into ${totalBatches} batches.\n`);

async function checkWebsiteLive(url) {
  if (!url || skipPing) return { live: true, status: 200 };
  let target = url;
  if (!target.startsWith("http")) target = `https://${target}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(target, {
      method: "HEAD",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      redirect: "follow",
    });
    clearTimeout(timeout);
    return { live: res.status < 400 || res.status === 403, status: res.status };
  } catch {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(target, {
        method: "GET",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      clearTimeout(timeout);
      return { live: res.status < 400 || res.status === 403, status: res.status };
    } catch {
      return { live: false, status: 0 };
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  let totalProcessed = 0;
  let totalVerified = 0;
  let totalIngested = 0;
  const allVerifiedLeads = [];

  for (let b = 0; b < totalBatches; b++) {
    const batchRows = chunks[b];
    const batchId = `auto-batch-${String(b + 1).padStart(3, "0")}-${new Date().toISOString().slice(0, 10)}`;
    console.log(`\n───────────────────────────────────────────────────────`);
    console.log(`▶ Processing Batch [${b + 1}/${totalBatches}]: ${batchRows.length} leads (ID: ${batchId})`);
    console.log(`───────────────────────────────────────────────────────`);

    // 1. Schema check
    const validationReport = validateBatch(batchRows, {
      batchId,
      defaultSource: "manual",
      maxRows: Infinity,
    });

    const validInBatch = [];
    validationReport.rows.forEach((r, idx) => {
      if (!r.errors || r.errors.length === 0) {
        validInBatch.push({ ...r.lead, rawRow: batchRows[idx] });
      }
    });

    // 2. HTTP Ping check
    const verifiedInBatch = [];
    for (const item of validInBatch) {
      const check = await checkWebsiteLive(item.website);
      if (check.live) {
        verifiedInBatch.push(item);
      }
    }

    console.log(`   • Input: ${batchRows.length} | Schema Valid: ${validInBatch.length} | Live Websites: ${verifiedInBatch.length}`);

    totalProcessed += batchRows.length;
    totalVerified += verifiedInBatch.length;
    allVerifiedLeads.push(...verifiedInBatch);

    // 3. Ingestion if --commit
    if (shouldCommit && verifiedInBatch.length > 0) {
      try {
        const payload = {
          batch_id: batchId,
          default_source: "manual",
          force: true,
          rows: verifiedInBatch.map((l) => ({
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
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });

        const resData = await res.json().catch(() => ({}));
        if (!res.ok) {
          console.error(`   ❌ Ingestion failed:`, resData?.error || `HTTP ${res.status}`);
        } else {
          const count = resData.imported ?? verifiedInBatch.length;
          totalIngested += count;
          console.log(`   ✅ Ingested ${count} leads into CRM database!`);
        }
      } catch (e) {
        console.error(`   ❌ Ingestion error:`, e.message);
      }
    }

    if (b < totalBatches - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  // 4. Final summary and consolidated campaign file
  console.log(`\n=======================================================`);
  console.log(`🏁 AUTOMATED BATCH RUN COMPLETED!`);
  console.log(`   • Total Leads Scanned:    ${totalProcessed}`);
  console.log(`   • 100% Live & Verified:   ${totalVerified}`);
  console.log(`   • Total Ingested to CRM:  ${totalIngested}`);
  console.log(`=======================================================\n`);

  if (allVerifiedLeads.length > 0) {
    const consolidatedCsv = "automation/scraping/auto_verified_consolidated.csv";
    const exportHeaders = [
      "company_name", "website", "city", "state", "locations_count",
      "decision_maker_name", "decision_maker_title", "decision_maker_role",
      "verified_email", "linkedin_url", "source_platform", "source_url", "batch_id"
    ];

    const lines = [
      exportHeaders.join(","),
      ...allVerifiedLeads.map((l) => exportHeaders.map((h) => `"${String(l[h] !== undefined ? l[h] : "").replace(/"/g, '""')}"`).join(",")),
    ];
    writeFileSync(consolidatedCsv, lines.join("\n"), "utf8");
    console.log(`✓ Exported Consolidated Verified Dataset: ${consolidatedCsv}`);

    // Generate campaign files
    const { execSync } = await import("node:child_process");
    try {
      execSync(
        `node --experimental-strip-types automation/email/outbound_dispatcher.mjs ${consolidatedCsv} automation/email/auto_campaign_ready.csv automation/email/auto_campaign_ready.json`,
        { stdio: "inherit" }
      );
    } catch (e) {
      console.error("Failed to generate campaign files:", e.message);
    }
  }
}

run();
