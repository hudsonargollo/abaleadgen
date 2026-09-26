// Unit tests for src/crm/leadValidation.ts — run: npm run test:crm
import assert from "node:assert/strict";
import { normalizeState, checkEmail, parseDelimited, validateBatch, remapRow } from "../src/crm/leadValidation.ts";

let n = 0;
const ok = (name) => console.log(`  ✓ ${++n} ${name}`);

// states
for (const [input, want] of [
  ["TX", "TX"], ["tx", "TX"], [" Tx ", "TX"], ["Texas", "TX"], ["texas", "TX"], ["North Carolina", "NC"], ["n.c.", "NC"],
  ["TX, USA", "TX"], ["Austin, TX 78701", "TX"], ["Florida, United States", "FL"], ["Washington DC", "DC"], ["", null], [null, null],
  ["Ontario", undefined], ["XX", undefined], ["Texass", undefined],
]) assert.equal(normalizeState(input), want, `normalizeState(${JSON.stringify(input)})`);
ok("normalizeState: abbreviations, full names, trailing country/zip, unknowns");

// emails
assert.deepEqual(checkEmail("Jane@BrightPathABA.com"), { email: "jane@brightpathaba.com", valid: true, roleBased: false, freemail: false, domain: "brightpathaba.com" });
assert.equal(checkEmail("info@clinic.com").roleBased, true);
assert.equal(checkEmail("support+tickets@clinic.com").roleBased, true);
assert.equal(checkEmail("frontdesk@clinic.com").roleBased, true);
assert.equal(checkEmail("admin.team@clinic.com").roleBased, true);
assert.equal(checkEmail("jane.info@clinic.com").roleBased, false);
assert.equal(checkEmail("jane@gmail.com").freemail, true);
assert.equal(checkEmail("Jane Doe <jane@x.io>").email, "jane@x.io");
assert.equal(checkEmail("mailto:jane@x.io").valid, true);
for (const bad of ["jane", "jane@", "@x.com", "jane@x", "jane doe@x.com", "jane@x..com", "jane@@x.com", ""]) assert.equal(checkEmail(bad).valid, false, bad);
ok("checkEmail: syntax, role-based detection, freemail, angle-bracket/mailto cleanup");

// csv parsing
const csv = '﻿Company,Website,"Decision Maker",Email,State\r\n"Bright Path, LLC",brightpathaba.com,"Doe, Jane",jane@brightpathaba.com,TX\r\nSunrise,sunrise.org,"Bob ""Bobby"" Ray",bob@sunrise.org,fl\r\n\r\n';
const parsed = parseDelimited(csv);
assert.deepEqual(parsed.headers, ["company", "website", "decision maker", "email", "state"]);
assert.equal(parsed.rows.length, 2);
assert.equal(parsed.rows[0].company, "Bright Path, LLC");
assert.equal(parsed.rows[1]["decision maker"], 'Bob "Bobby" Ray');
const tsv = parseDelimited("company\twebsite\nA\ta.com\n");
assert.equal(tsv.delimiter, "\t");
assert.equal(tsv.rows[0].website, "a.com");
ok("parseDelimited: BOM, CRLF, quoted commas, doubled quotes, blank lines, TSV");

// header remap
const { row, unmapped } = remapRow({ "Company Name": "X", "Person LinkedIn URL": "linkedin.com/in/x", "Random Col": 1, Email: "a@b.co" });
assert.equal(row.company_name, "X");
assert.equal(row.linkedin_url, "linkedin.com/in/x");
assert.equal(row.verified_email, "a@b.co");
assert.deepEqual(unmapped, ["Random Col"]);
ok("remapRow: alias mapping + unmapped reporting");

// batch validation
const report = validateBatch(
  [
    { company: "Bright Path ABA", website: "https://www.BrightPathABA.com/about", state: "Texas", email: "Jane@BrightPathABA.com", title: "Founder & BCBA", locations: "3", linkedin: "linkedin.com/in/jane" },
    { company: "Role Email Clinic", website: "roleclinic.com", state: "FL", email: "info@roleclinic.com", name: "Front Desk" },
    { company: "Bad Email", website: "bademail.com", state: "CA", email: "not-an-email" },
    { company: "Bad State", website: "badstate.com", state: "Ontario", email: "x@badstate.com" },
    { company: "Dup Domain", website: "brightpathaba.com", email: "other@brightpathaba.com" },
    { company: "Dup Email", website: "dupemail.com", email: "jane@brightpathaba.com" },
    { company: "Already In DB", website: "existing.com", email: "e@existing.com" },
    { company: "Gmail Owner", website: "gmailclinic.com", state: "nc", email: "owner@gmail.com", name: "Sam Owner", title: "Owner" },
    { website: "   ", email: "" },
    { company: "Bad LinkedIn", website: "badli.com", state: "UT", linkedin: "twitter.com/x" },
    { company: "Mismatch", website: "mismatch.com", state: "GA", email: "jo@otherco.com", "Source": "TheABAIndex", "Random": "ignored" },
  ],
  { batchId: "pilot-01", defaultSource: "apollo", existing: { byDomain: new Map([["existing.com", "LEAD-EXISTING"]]), byEmail: new Map() } }
);
const byRow = Object.fromEntries(report.rows.map((r) => [r.row, r]));
const codes = (r) => [...r.errors, ...r.warnings].map((i) => i.code);

assert.equal(byRow[1].status, "valid");
assert.equal(byRow[1].lead.website_domain, "brightpathaba.com");
assert.equal(byRow[1].lead.state, "TX");
assert.equal(byRow[1].lead.verified_email, "jane@brightpathaba.com");
assert.equal(byRow[1].lead.locations_count, 3);
assert.equal(byRow[1].lead.decision_maker_role, "founder");
assert.equal(byRow[1].lead.linkedin_url, "https://linkedin.com/in/jane");
assert.equal(byRow[1].lead.batch_id, "pilot-01");
assert.equal(byRow[1].lead.source_platform, "apollo");
assert.equal(byRow[1].lead.email_verification_status, "unverified");
ok("valid row: full normalization (domain, state, email, role inference, linkedin, batch, default source)");

assert.equal(byRow[2].status, "valid");
assert.ok(codes(byRow[2]).includes("role_based_email"));
assert.equal(byRow[2].lead.email_verification_status, "risky");
ok("role-based email: imported as warning, flagged risky");

assert.equal(byRow[3].status, "error");
assert.ok(codes(byRow[3]).includes("invalid_email"));
assert.equal(byRow[4].status, "error");
assert.ok(codes(byRow[4]).includes("invalid_state"));
ok("invalid email / invalid state → error");

assert.equal(byRow[5].status, "duplicate");
assert.ok(codes(byRow[5]).includes("duplicate_domain_in_file"));
assert.equal(byRow[6].status, "duplicate");
assert.ok(codes(byRow[6]).includes("duplicate_email_in_file"));
assert.equal(byRow[7].status, "duplicate");
assert.ok(codes(byRow[7]).includes("duplicate_domain_in_db"));
assert.equal(byRow[7].existingLeadId, "LEAD-EXISTING");
ok("duplicates: domain in file, email in file, domain in DB (with existing id)");

assert.equal(byRow[8].status, "valid");
assert.ok(codes(byRow[8]).includes("freemail_domain"));
assert.equal(byRow[8].lead.decision_maker_role, "owner");
assert.equal(byRow[9].status, "error");
assert.ok(codes(byRow[9]).includes("missing_identity"));
assert.equal(byRow[10].status, "error");
assert.ok(codes(byRow[10]).includes("invalid_linkedin_url"));
assert.equal(byRow[11].status, "valid");
assert.ok(codes(byRow[11]).includes("email_domain_mismatch"));
assert.equal(byRow[11].lead.source_platform, "aba_index");
ok("freemail warning, missing identity error, bad linkedin error, domain mismatch warning, source alias");

assert.deepEqual(
  [report.summary.total, report.summary.valid, report.summary.errors, report.summary.duplicates],
  [11, 4, 4, 3]
);
assert.deepEqual(report.summary.unmappedColumns, ["Random"]);
ok("summary counts + unmapped columns");

// reject role emails + require email
const strict = validateBatch([{ company: "A", website: "a.com", email: "info@a.com" }, { company: "B", website: "b.com" }], { rejectRoleEmails: true, requireEmail: true });
assert.equal(strict.rows[0].status, "error");
assert.equal(strict.rows[1].status, "error");
ok("strict options: rejectRoleEmails / requireEmail");

// row cap
const big = validateBatch(Array.from({ length: 12 }, (_, i) => ({ company: `C${i}`, website: `c${i}.com` })), { maxRows: 10 });
assert.equal(big.summary.errors, 2);
assert.equal(big.rows[11].errors[0].code, "row_limit_exceeded");
ok("maxRows cap");

console.log(`\nall ${n} checks passed`);
