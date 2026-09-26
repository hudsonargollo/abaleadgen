#!/usr/bin/env node
/**
 * Google Maps / Apify / Outscraper Lead Formatter for ABA LeadGen
 * Normalizes raw Google Maps CSV / JSON exports into the standard ABA lead schema
 * ready for `npm run import:leads -- --commit <output.csv>`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { normalizeState, checkEmail } from "../../src/crm/leadValidation.ts";
import { normalizeDomain } from "../../src/crm/abaLead.types.ts";

const args = process.argv.slice(2);
const inputFile = args[0];
const outputFile = args[1] || "automation/scraping/formatted_google_maps_leads.csv";

if (!inputFile) {
  console.log("Usage: node google-maps-formatter.mjs <input_file.csv|json> [output_file.csv]");
  process.exit(1);
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (!lines.length) return [];
  const headers = lines[0].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(h => h.replace(/^["']|["']$/g, "").trim().toLowerCase());
  
  return lines.slice(1).map(line => {
    const values = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => v ? v.replace(/^["']|["']$/g, "").trim() : "");
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = values[i] || "";
    });
    return obj;
  });
}

let rawData = [];
const rawContent = readFileSync(inputFile, "utf8");
if (inputFile.endsWith(".json")) {
  rawData = JSON.parse(rawContent);
} else {
  rawData = parseCSV(rawContent);
}

console.log(`Parsed ${rawData.length} raw leads from ${inputFile}`);

// Standard ABA Lead Header
const standardHeaders = [
  "company_name",
  "website",
  "city",
  "state",
  "locations_count",
  "decision_maker_name",
  "decision_maker_title",
  "decision_maker_role",
  "verified_email",
  "linkedin_url",
  "source_platform",
  "source_url",
  "batch_id"
];

const batchId = `pilot-${new Date().toISOString().slice(0, 10)}`;

const formattedRows = [];
const seenDomains = new Set();

for (const row of rawData) {
  const name = row.name || row.title || row.company || row.company_name || row["place name"] || "";
  if (!name) continue;

  const website = row.website || row.url || row.domain || row.site || "";
  const domain = normalizeDomain(website);
  if (domain && seenDomains.has(domain)) continue;
  if (domain) seenDomains.add(domain);

  const rawState = row.state || row.region || row.state_code || row.province || "";
  const state = normalizeState(rawState) || "";

  const city = row.city || row.locality || row.town || "";
  
  // Locations count inference
  const locations = parseInt(row.locations_count || row.locations || row.num_locations || "1", 10) || 1;

  // Contact / Decision Maker
  const contactName = row.contact_name || row.decision_maker_name || row.owner_name || row.first_name ? `${row.first_name || ""} ${row.last_name || ""}`.trim() : "";
  const contactTitle = row.title || row.decision_maker_title || row.role || "Clinical Director / Owner";
  
  let contactRole = "owner";
  const titleLower = contactTitle.toLowerCase();
  if (titleLower.includes("founder")) contactRole = "founder";
  else if (titleLower.includes("ceo") || titleLower.includes("chief executive")) contactRole = "ceo";
  else if (titleLower.includes("director") || titleLower.includes("bcba")) contactRole = "exec_director";

  const emailRaw = row.email || row.verified_email || row.contact_email || row["email address"] || "";
  const emailCheck = checkEmail(emailRaw);
  const email = emailCheck.email || "";

  const linkedin = row.linkedin || row.linkedin_url || row["linkedin profile"] || "";
  const sourceUrl = row.google_maps_url || row.url || row.source_url || "";

  formattedRows.push({
    company_name: name.replace(/"/g, '""'),
    website: website,
    city: city.replace(/"/g, '""'),
    state: state,
    locations_count: locations,
    decision_maker_name: contactName.replace(/"/g, '""'),
    decision_maker_title: contactTitle.replace(/"/g, '""'),
    decision_maker_role: contactRole,
    verified_email: email,
    linkedin_url: linkedin,
    source_platform: "google_maps",
    source_url: sourceUrl,
    batch_id: batchId
  });
}

function toCSV(headers, rows) {
  const headerLine = headers.join(",");
  const dataLines = rows.map(r => headers.map(h => `"${r[h] !== undefined ? r[h] : ""}"`).join(","));
  return [headerLine, ...dataLines].join("\n");
}

const csvOutput = toCSV(standardHeaders, formattedRows);
writeFileSync(outputFile, csvOutput, "utf8");

console.log(`Successfully formatted ${formattedRows.length} ABA leads → ${outputFile}`);
