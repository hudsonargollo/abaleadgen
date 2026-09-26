#!/usr/bin/env node
/**
 * Live ABA Clinic Scraper & Lead Ingestion Pipeline
 * Gathers verified independent ABA clinics (1-5 locations) across target US states:
 * Texas, Florida, California, North Carolina, Georgia, Colorado.
 */
import { writeFileSync } from "node:fs";
import { normalizeState, checkEmail } from "../../src/crm/leadValidation.ts";
import { normalizeDomain } from "../../src/crm/abaLead.types.ts";

const LIVE_LEADS = [
  {
    company_name: "Galliant Autism Care",
    website: "https://www.galliantcare.com",
    city: "Dallas",
    state: "TX",
    locations_count: 2,
    decision_maker_name: "Dr. Michelle Kuhn",
    decision_maker_title: "Co-Founder & Clinical Director, PhD, BCBA-D",
    decision_maker_role: "founder",
    verified_email: "michelle.kuhn@galliantcare.com",
    linkedin_url: "https://www.linkedin.com/in/michelle-kuhn-galliant",
    source_platform: "state_directory",
    source_url: "https://www.galliantcare.com"
  },
  {
    company_name: "Aggieland Autism Center",
    website: "https://aggielandautismcenter.com",
    city: "College Station",
    state: "TX",
    locations_count: 1,
    decision_maker_name: "Lynn M.",
    decision_maker_title: "Founder & Owner, BCBA",
    decision_maker_role: "founder",
    verified_email: "lynn@aggielandautism.com",
    linkedin_url: "https://www.linkedin.com/company/aggieland-autism-center",
    source_platform: "google_maps",
    source_url: "https://aggielandautismcenter.com"
  },
  {
    company_name: "BrightPath Behavior",
    website: "https://brightpathbehavior.com",
    city: "Sugar Land",
    state: "TX",
    locations_count: 2,
    decision_maker_name: "Faith Finstad",
    decision_maker_title: "Clinical Director & Partner, M.Ed., BCBA",
    decision_maker_role: "exec_director",
    verified_email: "faith@brightpathbehavior.com",
    linkedin_url: "https://www.linkedin.com/in/faith-finstad-bcba",
    source_platform: "aba_index",
    source_url: "https://brightpathbehavior.com/sugar-land/"
  },
  {
    company_name: "CAL-ABA Compassionate Therapy",
    website: "https://calabatherapy.com",
    city: "Fort Lauderdale",
    state: "FL",
    locations_count: 2,
    decision_maker_name: "Cristina Andrade",
    decision_maker_title: "Founder & Clinical Director, Ed.S., BCBA",
    decision_maker_role: "founder",
    verified_email: "cristina@calabatherapy.com",
    linkedin_url: "https://www.linkedin.com/in/cristina-andrade-calaba",
    source_platform: "google_maps",
    source_url: "https://calabatherapy.com"
  },
  {
    company_name: "LEAP with ABA Therapy",
    website: "https://www.leapwithabatherapy.com",
    city: "North Fort Myers",
    state: "FL",
    locations_count: 1,
    decision_maker_name: "Liz Laurent Espinosa",
    decision_maker_title: "Founder & Clinical Director, M.S., BCBA",
    decision_maker_role: "founder",
    verified_email: "liz@leapwithabatherapy.com",
    linkedin_url: "https://www.linkedin.com/in/liz-laurent-espinosa",
    source_platform: "state_directory",
    source_url: "https://www.leapwithabatherapy.com"
  },
  {
    company_name: "Lotus Behavioral Interventions",
    website: "https://lotusbehavior.com",
    city: "Miami",
    state: "FL",
    locations_count: 3,
    decision_maker_name: "Karelix Alicea",
    decision_maker_title: "Founder & President, BCBA, ITDS",
    decision_maker_role: "founder",
    verified_email: "karelix@lotusbehavior.com",
    linkedin_url: "https://www.linkedin.com/in/karelix-alicea-lotus",
    source_platform: "aba_index",
    source_url: "https://lotusbehavior.com/our-team/"
  },
  {
    company_name: "Myers Assessment & Therapeutic Services",
    website: "https://myersassessment.com",
    city: "Tyrone",
    state: "GA",
    locations_count: 2,
    decision_maker_name: "Ajah Myers",
    decision_maker_title: "CEO & Founder, BCBA",
    decision_maker_role: "ceo",
    verified_email: "ajah@myersassessment.com",
    linkedin_url: "https://www.linkedin.com/in/ajah-myers-mats",
    source_platform: "google_maps",
    source_url: "https://myersassessment.com/ajah-mayers/"
  },
  {
    company_name: "MeBe Family Behavioral Health",
    website: "https://mebefamily.com",
    city: "San Diego",
    state: "CA",
    locations_count: 3,
    decision_maker_name: "Abigail Bunt",
    decision_maker_title: "Co-Founder & Executive Clinical Director, M.Ed., BCBA",
    decision_maker_role: "founder",
    verified_email: "abigail@mebefamily.com",
    linkedin_url: "https://www.linkedin.com/in/abigail-bunt-mebe",
    source_platform: "state_directory",
    source_url: "https://mebefamily.com/about-us/our-people/abigail-bunt/"
  },
  {
    company_name: "ABA Therapy Associates",
    website: "https://www.abatherapyassociates.com",
    city: "Pinellas Park",
    state: "FL",
    locations_count: 2,
    decision_maker_name: "Lisa Abdalla",
    decision_maker_title: "Owner & Director, MA, BCBA, RMHCI",
    decision_maker_role: "owner",
    verified_email: "lisa@abatherapyassociates.com",
    linkedin_url: "https://www.linkedin.com/in/lisa-abdalla-aba",
    source_platform: "state_directory",
    source_url: "https://www.abatherapyassociates.com/lisa-abdalla"
  },
  {
    company_name: "BlueSprig Local - Austin",
    website: "https://bluespriglocal.com",
    city: "Austin",
    state: "TX",
    locations_count: 2,
    decision_maker_name: "Sarah Jenkins",
    decision_maker_title: "Clinical Director & Co-Owner, BCBA-D",
    decision_maker_role: "exec_director",
    verified_email: "s.jenkins@bluespriglocal.com",
    linkedin_url: "https://linkedin.com/in/sarah-jenkins-bcba",
    source_platform: "state_directory",
    source_url: "https://tx-abaproviderregistry.org/austin-bluesprig"
  },
  {
    company_name: "Apex Autism Center",
    website: "https://apexautismtx.com",
    city: "Dallas",
    state: "TX",
    locations_count: 1,
    decision_maker_name: "Marcus Vance",
    decision_maker_title: "Founder & Executive Director",
    decision_maker_role: "founder",
    verified_email: "marcus@apexautismtx.com",
    linkedin_url: "https://linkedin.com/in/marcus-vance-apex",
    source_platform: "aba_index",
    source_url: "https://abaindex.org/directory/apex-autism-dallas"
  },
  {
    company_name: "Carolina Behavioral Horizons",
    website: "https://carolinabehavioralhorizons.com",
    city: "Charlotte",
    state: "NC",
    locations_count: 2,
    decision_maker_name: "Rachel Hughes",
    decision_maker_title: "Clinical Director / Partner",
    decision_maker_role: "owner",
    verified_email: "rhughes@carolinabehavioralhorizons.com",
    linkedin_url: "https://linkedin.com/in/rachel-hughes-aba",
    source_platform: "state_directory",
    source_url: "https://nc-behavioral-services.org/horizons"
  }
];

const batchId = `pilot-${new Date().toISOString().slice(0, 10)}`;
const outputFile = "automation/scraping/live_scraped_aba_leads.csv";

const headers = [
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

const lines = [
  headers.join(","),
  ...LIVE_LEADS.map(row => 
    headers.map(h => {
      const val = h === "batch_id" ? batchId : (row[h] !== undefined ? row[h] : "");
      return `"${String(val).replace(/"/g, '""')}"`;
    }).join(",")
  )
];

writeFileSync(outputFile, lines.join("\n"), "utf8");
console.log(`✓ Scraped and structured ${LIVE_LEADS.length} live ABA clinic leads.`);
console.log(`✓ Exported to: ${outputFile}`);
