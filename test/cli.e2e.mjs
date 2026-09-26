// Runs scripts/import-leads.mjs against a live in-process instance of the CRM
// worker (sqlite-backed). Run: node --experimental-strip-types test/cli.e2e.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { signSession } from "../functions/_lib/session.js";
import app from "../worker/crm-entry.js";

const sqlite = new Database(":memory:");
for (const f of readdirSync("migrations").sort()) sqlite.exec(readFileSync(`migrations/${f}`, "utf8"));
function stmt(sql, params = []) {
  const s = sqlite.prepare(sql);
  const isRead = /^\s*(select|pragma|with)/i.test(sql);
  return { bind: (...p) => stmt(sql, p), first: async () => s.get(...params) ?? null, all: async () => ({ results: s.all(...params) }),
    run: async () => (isRead ? { results: s.all(...params), meta: {} } : { meta: { changes: s.run(...params).changes } }) };
}
const env = { DB: { prepare: stmt, batch: async (xs) => Promise.all(xs.map((x) => x.run())) }, SESSION_SECRET: "s" };
sqlite.prepare("INSERT INTO users (email, name, access_role, crm_role) VALUES ('h@x.io','H','ADMIN','admin')").run();
sqlite.prepare("INSERT INTO leads (id, company_name, website_domain, status) VALUES ('EXISTING','Sunrise','sunrisebehavior.org','sourced')").run();
const token = await signSession("s", "h@x.io");

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await app.fetch(new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env, {});
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((ok) => server.listen(0, ok));
const api = `http://localhost:${server.address().port}`;

const exec = (argv) =>
  new Promise((resolve) => {
    const p = spawn("node", ["--experimental-strip-types", ...argv]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err: err.replace(/.*ExperimentalWarning.*\n?/g, "") }));
  });
const run = (extra) => exec(["scripts/import-leads.mjs", "test/fixtures/pilot-sample.csv", "--batch", "pilot-01", "--api", api, "--token", token, ...extra]);
let n = 0;
const ok = (m) => console.log(`  ✓ ${++n} ${m}`);

let r = await run([]);
assert.equal(r.code, 1);
assert.match(r.out, /offline validation/);
assert.match(r.out, /7 rows · 4 valid · 2 errors · 1 duplicates/);
assert.match(r.out, /role-based address/);
assert.match(r.out, /not a recognized US state/);
assert.match(r.out, /ignored columns: random col/);
assert.equal(sqlite.prepare("SELECT count(*) c FROM leads").get().c, 1);
ok("offline: exit 1 with errors, nothing written, no network needed");

r = await run(["--dry-run"]);
assert.equal(r.code, 1);
assert.match(r.out, /server dry-run/);
assert.match(r.out, /already exists \(lead EXISTING\)/);
assert.match(r.out, /7 rows · 3 valid · 2 errors · 2 duplicates/);
assert.equal(sqlite.prepare("SELECT count(*) c FROM leads").get().c, 1);
ok("dry-run: DB duplicate surfaced (Sunrise), nothing written");

r = await run(["--commit"]);
assert.equal(r.code, 1);
assert.match(r.err, /refusing to import: 4 row\(s\)/);
assert.equal(sqlite.prepare("SELECT count(*) c FROM leads").get().c, 1);
ok("commit without --force refuses when the dry-run has problems");

r = await run(["--commit", "--force", "--out", "/tmp/gp-report.json"]);
assert.equal(r.code, 1, "exit 1 still signals skipped rows");
assert.match(r.out, /imported 3 lead\(s\) into batch "pilot-01"/);
assert.equal(sqlite.prepare("SELECT count(*) c FROM leads WHERE batch_id='pilot-01'").get().c, 3);
const risky = sqlite.prepare("SELECT email_verification_status s, state FROM leads WHERE website_domain='rolemail.com'").get();
assert.equal(risky.s, "risky");
assert.equal(risky.state, "CO");
assert.equal(sqlite.prepare("SELECT state FROM leads WHERE website_domain='brightpathaba.com'").get().state, "TX");
const report = JSON.parse(readFileSync("/tmp/gp-report.json", "utf8"));
assert.equal(report.created, 3);
assert.equal(report.rows.filter((x) => x.leadId).length, 3);
ok("commit --force: 3 imported, states normalized, role email flagged risky, JSON report written");

r = await run(["--dry-run", "--json"]);
const j = JSON.parse(r.out);
assert.equal(j.summary.valid, 0);
assert.equal(j.summary.duplicates, 5);
ok("re-run after import: everything is a duplicate (idempotent)");

r = await exec(["scripts/import-leads.mjs", "--dry-run"]);
assert.equal(r.code, 2);
ok("usage error → exit 2");

server.close();
console.log(`\nall ${n} checks passed`);
