#!/usr/bin/env node
/**
 * ABA LeadGen Outbound Dispatcher & Campaign Automation Engine
 * Supports:
 *   1. Instantly / Smartlead / CSV export with pre-rendered tracking URLs & open pixels.
 *   2. Direct Resend / SMTP live dispatch with delay jitter & touch tracking.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseDelimited } from "../../src/crm/leadValidation.ts";

const args = process.argv.slice(2);
const inputFile = args[0] || "automation/scraping/live_npi_aba_leads_2000.csv";
const outCsv = args[1] || "automation/email/instantly_campaign_ready.csv";
const outJson = args[2] || "automation/email/instantly_campaign_ready.json";

const BASE_URL = "https://abaclinics.clubemkt.digital";

console.log(`🚀 Loading leads from: ${inputFile}...`);

let text;
try {
  text = readFileSync(inputFile, "utf8");
} catch (e) {
  console.error(`Error reading ${inputFile}:`, e.message);
  process.exit(1);
}

const { rows } = parseDelimited(text);
if (!rows.length) {
  console.error("No lead rows found.");
  process.exit(1);
}

console.log(`Loaded ${rows.length} valid lead rows. Generating 4-touch personalized campaigns...`);

const campaignRows = rows.map((lead, idx) => {
  const leadId = lead.id || `lead_${String(idx + 1).padStart(4, "0")}`;
  const company = lead.company_name || lead.company || "your practice";
  const contactName = lead.decision_maker_name || lead.name || "";
  const firstName = contactName.split(" ")[0] || "there";
  const city = lead.city ? `in ${lead.city}` : "in your area";
  const state = lead.state || "US";
  const email = lead.verified_email || lead.email || "";
  const locations = parseInt(lead.locations_count || lead.locations || "1", 10) || 1;
  const batchId = lead.batch_id || `pilot-${new Date().toISOString().slice(0, 10)}`;

  // Tracking links generated per touch
  const buildTrackedUrl = (touchNum) => {
    const landing = `${BASE_URL}/aba?lid=${encodeURIComponent(leadId)}&utm_source=cold_email&utm_medium=email&utm_campaign=${encodeURIComponent(batchId)}&utm_content=touch_${touchNum}`;
    return `${BASE_URL}/crm/api/track/click?lid=${encodeURIComponent(leadId)}&touch=${touchNum}&url=${encodeURIComponent(landing)}`;
  };

  const buildOpenPixel = (touchNum) => {
    return `<img src="${BASE_URL}/crm/api/track/open?lid=${encodeURIComponent(leadId)}&touch=${touchNum}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`;
  };

  const touch1Url = buildTrackedUrl(1);
  const touch2Url = buildTrackedUrl(2);
  const touch3Url = buildTrackedUrl(3);
  const touch4Url = buildTrackedUrl(4);

  // ── Touch 1 Copy ─────────────────────────────────────────────────────────
  const touch1_subject = `Quick question about ${company}'s caseload in ${state}`;
  const touch1_body = `Hi ${firstName},

I was looking at independent ABA practices ${city} and came across ${company}.

Most clinic owners with 1–${Math.max(3, locations)} locations we talk to in ${state} tell us their primary bottleneck isn't clinical expertise—it's getting a predictable flow of commercial-insurance and private-pay inquiries without selling out to PE roll-ups or burning margin on generic agencies.

We built an intake & patient growth system specifically for independent practices. You can see how the intake flow and caseload matching work here:

${touch1Url}

Do you have 15 minutes this Thursday or Friday to see if this fits your current openings?

Best,
Hudson Argollo
ABA Practice Growth · Gold Traffic`;

  // ── Touch 2 Copy ─────────────────────────────────────────────────────────
  const touch2_subject = `Re: ${company}'s openings in ${state}`;
  const touch2_body = `Hi ${firstName},

Quick follow-up on my note from earlier this week.

When clinics expand or onboard new BCBAs/RBTs, the hardest part is usually timing: converting waitlisted families the exact week a slot opens rather than watching them drop off to competitor waitlists.

We put together a 20-minute discovery breakdown for independent practices:
${touch2Url}

Would love to share what's working for clinics in ${state} if you're open to comparing notes.

Best,
Hudson`;

  // ── Touch 3 Copy ─────────────────────────────────────────────────────────
  const touch3_subject = `Filling ${company}'s caseload (${state})`;
  const touch3_body = `Hi ${firstName},

I know you're busy running ${company} and managing clinical plans.

If patient intake or waitlist conversion isn't a priority right now, no worries at all. If you ever want to check our 2-minute fit assessment or see if our model works for your current capacity, you can bookmark this link:

${touch3Url}

Wishing you and your clinical team continued success ${city}!

Best,
Hudson`;

  // ── Touch 4 Copy ─────────────────────────────────────────────────────────
  const touch4_subject = `Closing out ${company}'s file for now?`;
  const touch4_body = `Hi ${firstName},

Usually when I haven't heard back, it means one of two things:
1. Your caseload and waitlist in ${city} are already at 100% capacity.
2. You're interested, but the timing is bad.

If you'd like me to follow up in a few months when you're looking to open new rooms or hire BCBAs, just reply "later".

Otherwise, if you ever want to review our intake framework, it's always live at:
${touch4Url}

Thanks for all you do for the autism community in ${state}.

Best,
Hudson`;

  return {
    lead_id: leadId,
    email: email,
    first_name: firstName,
    last_name: contactName.split(" ").slice(1).join(" "),
    company_name: company,
    city: lead.city || "",
    state: state,
    locations_count: locations,
    batch_id: batchId,
    website: lead.website || "",
    linkedin_url: lead.linkedin_url || "",

    // Touch 1
    subject_1: touch1_subject,
    body_1: touch1_body,
    tracked_link_1: touch1Url,
    open_pixel_1: buildOpenPixel(1),

    // Touch 2
    subject_2: touch2_subject,
    body_2: touch2_body,
    tracked_link_2: touch2Url,
    open_pixel_2: buildOpenPixel(2),

    // Touch 3
    subject_3: touch3_subject,
    body_3: touch3_body,
    tracked_link_3: touch3Url,
    open_pixel_3: buildOpenPixel(3),

    // Touch 4
    subject_4: touch4_subject,
    body_4: touch4_body,
    tracked_link_4: touch4Url,
    open_pixel_4: buildOpenPixel(4),
  };
});

// Write CSV export
const exportHeaders = [
  "email",
  "first_name",
  "last_name",
  "company_name",
  "city",
  "state",
  "locations_count",
  "lead_id",
  "batch_id",
  "website",
  "linkedin_url",
  "subject_1",
  "body_1",
  "tracked_link_1",
  "subject_2",
  "body_2",
  "tracked_link_2",
  "subject_3",
  "body_3",
  "tracked_link_3",
  "subject_4",
  "body_4",
  "tracked_link_4",
];

const csvContent = [
  exportHeaders.join(","),
  ...campaignRows.map((r) =>
    exportHeaders.map((h) => `"${String(r[h] || "").replace(/"/g, '""')}"`).join(",")
  ),
].join("\n");

writeFileSync(outCsv, csvContent, "utf8");
writeFileSync(outJson, JSON.stringify(campaignRows, null, 2), "utf8");

console.log(`\n=======================================================`);
console.log(`✓ Successfully compiled 4-touch campaign for ${campaignRows.length} ABA leads!`);
console.log(`✓ Instantly/Smartlead CSV: ${outCsv}`);
console.log(`✓ Campaign JSON:           ${outJson}`);
console.log(`=======================================================\n`);
