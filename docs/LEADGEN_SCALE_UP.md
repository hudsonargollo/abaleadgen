# ABA Lead-Gen Scale-Up Brief

## Objective
Automate the top-of-funnel (scraping & cold email) and link-tracking strategy to scale the ABA clinic outbound pipeline.

## Context
- **Target:** Independent US ABA clinics (< $2M ARR, 1-3 locations).
- **Current Stack:** React/Vite Hub, Hono/D1 CRM, Next.js Marketing/Landing.
- **Workflow:** Sourced -> Queued -> Contacted -> Replied -> Call Scheduled.

## Scope

### 1. Automated Scraping (Phase 1: Local Tools)
- **Target Sources:** Google Maps, ABA Index, State Directories.
- **Deliverable:** Node.js scripts under `automation/scraping/` to output standardized CSVs for the `import:leads` CLI.
- **Data Points:** Company name, website, city, state, locations count, decision-maker name/role, verified email.

### 2. Cold Email & Link Tracking Strategy
- **Infrastructure:** Use existing `wa_links` logic (via `go.goldplanner...` shortener) for click tracking.
- **Campaign Logic:**
    - Each lead gets a unique tracked link pointing to `abaclinics.clubemkt.digital/aba?lid={{lead_id}}`.
    - Content: personalized mention of state/locations.
    - CRM Update: Webhook or script logs `contacted` stage and `sequence_step` when email is sent.

### 3. CTA & Meeting Scheduling
- **CTA:** Personalized interactive intake form on `/aba`.
- **Scheduling:** Integration with Cal.com/Calendly webhooks (already in `crm-entry.js`) to move leads to `call_scheduled`.
- **Closing:** Payout ledger automation for bounty calculation.

## Constraints
- **Tech:** Node.js, D1 (SQLite-compatible), Hono.
- **Environment:** Remote headless (Hermes Agent workspace).
- **Security:** Sanitize all PII; use session tokens for API access.

## Acceptance Criteria
- [ ] Working Google Maps scraper (or CSV formatter for Apollo exports).
- [ ] Campaign script that takes a batch and generates tracked URLs.
- [ ] Intake form on `/aba` captures intent and updates CRM state.
- [ ] Verified webhook flow: Booking on Cal.com -> CRM moves lead to `call_scheduled`.

## Verification
- Run `npm run import:leads` with scraped data.
- Trigger `/crm/api/webhooks/booking` with a mock payload and verify lead stage progression.
- Fetch `GET /crm/api/dashboard` and see updated funnel KPIs.
