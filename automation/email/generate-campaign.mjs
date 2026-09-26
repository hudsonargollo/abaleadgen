#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseDelimited } from "../../src/crm/leadValidation.ts";

/**
 * ABA Multi-Touch Campaign Generator
 * Generates ready-to-send personalized sequences (Touch 1, Touch 2, Touch 3)
 * with tracked URLs for cold email outreach tools (Instantly, Smartlead, Lemlist).
 */

const args = process.argv.slice(2);
const file = args[0] || "automation/scraping/sample-pilot-leads.csv";
const outputFile = args[1] || "automation/email/campaign_ready.json";
const outputCsv = args[2] || "automation/email/campaign_ready.csv";

if (!file) {
  console.log("Usage: node generate-campaign.mjs <leads.csv> [output.json] [output.csv]");
  process.exit(1);
}

let text;
try {
  text = readFileSync(file, "utf8");
} catch (e) {
  console.error(`Cannot read ${file}: ${e.message}`);
  process.exit(1);
}

const { rows } = parseDelimited(text);
if (!rows.length) {
  console.error("No valid lead rows found in file.");
  process.exit(1);
}

const campaign = rows.map((lead, idx) => {
  const name = lead.decision_maker_name || lead.name || "";
  const firstName = name.split(" ")[0] || "there";
  const state = lead.state || "your area";
  const city = lead.city ? `in ${lead.city}` : `in ${state}`;
  const company = lead.company_name || lead.company || "your clinic";
  const locations = parseInt(lead.locations_count || lead.locations || "1", 10) || 1;
  const batchId = lead.batch_id || `pilot-${new Date().toISOString().slice(0, 10)}`;

  // Value prop hooks
  const locationsText = locations > 1 ? `across your ${locations} locations` : `at ${company}`;
  const stateText = state ? `in ${state}` : "locally";

  // Touch 1: Direct observation & commercial caseload focus
  const touch1_subject = `Quick question about ${company}'s openings ${stateText}`;
  const touch1_body = `Hi ${firstName},

I was looking at independent ABA practices ${city} and came across ${company}. 

A lot of clinic owners we talk to with 1–${Math.max(3, locations)} locations tell us their biggest bottleneck isn't clinical interest—it's getting predictable commercial-insurance & private-pay inquiries without giving up margins to PE aggregators.

We built an intake & patient growth system specifically for independent practices ${locationsText}. You can see how the intake flow and caseload matching work here:

{{TRACKED_URL_TOUCH_1}}

Do you have 15 minutes this Thursday or Friday to see if this fits your current openings?

Best,
Hudson Argollo
Gold Traffic / ABA Practice Growth`;

  // Touch 2: 3-day follow up (Waitlist conversion & BCBA capacity)
  const touch2_subject = `Re: ${company}'s openings ${stateText}`;
  const touch2_body = `Hi ${firstName},

Quick follow-up on my note from earlier this week.

When clinics expand or try to hire new BCBAs, keeping the waitlist warm and converting families at the exact moment a slot opens is usually what keeps rooms full.

We put together a 20-minute discovery breakdown for independent practices:
{{TRACKED_URL_TOUCH_2}}

Would love to share what's working for clinics in ${state} if you're open to it.

Best,
Hudson`;

  // Touch 3: 7-day follow up (Break-even / No-pitch check)
  const touch3_subject = `Filling ${company}'s caseload (${state})`;
  const touch3_body = `Hi ${firstName},

I know you're busy running ${company}. 

If patient intake or waitlist conversion isn't a priority right now, no worries at all. If you ever want to check our 2-minute fit assessment or look at the numbers, you can bookmark this link:

{{TRACKED_URL_TOUCH_3}}

Wishing you and the team continued success ${city}!

Best,
Hudson`;

  const baseUrl = "https://abaclinics.clubemkt.digital/aba";

  return {
    lead_id: lead.id || `lead_${idx + 1}`,
    company_name: company,
    contact_name: name,
    contact_first_name: firstName,
    email: lead.verified_email || lead.email || "",
    city: lead.city || "",
    state: state,
    locations_count: locations,
    batch_id: batchId,
    
    // Touch 1
    touch1_subject,
    touch1_body,
    touch1_url: `${baseUrl}?lid={{LEAD_ID}}&utm_source=cold_email&utm_medium=email&utm_campaign=${batchId}&utm_content=touch_1`,

    // Touch 2
    touch2_subject,
    touch2_body,
    touch2_url: `${baseUrl}?lid={{LEAD_ID}}&utm_source=cold_email&utm_medium=email&utm_campaign=${batchId}&utm_content=touch_2`,

    // Touch 3
    touch3_subject,
    touch3_body,
    touch3_url: `${baseUrl}?lid={{LEAD_ID}}&utm_source=cold_email&utm_medium=email&utm_campaign=${batchId}&utm_content=touch_3`,
  };
});

writeFileSync(outputFile, JSON.stringify(campaign, null, 2), "utf8");

// Generate CSV export
const csvHeaders = [
  "company_name",
  "contact_name",
  "contact_first_name",
  "email",
  "city",
  "state",
  "locations_count",
  "batch_id",
  "touch1_subject",
  "touch1_body",
  "touch1_url",
  "touch2_subject",
  "touch2_body",
  "touch2_url",
  "touch3_subject",
  "touch3_body",
  "touch3_url"
];

const csvRows = [
  csvHeaders.join(","),
  ...campaign.map(c => 
    csvHeaders.map(h => `"${String(c[h] || "").replace(/"/g, '""')}"`).join(",")
  )
];

writeFileSync(outputCsv, csvRows.join("\n"), "utf8");

console.log(`Generated multi-touch email campaign for ${campaign.length} ABA leads!`);
console.log(`JSON: ${outputFile}`);
console.log(`CSV:  ${outputCsv}`);
