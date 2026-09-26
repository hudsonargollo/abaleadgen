# ABA Lead-Gen Funnel & Automation Specification

## 1. Funnel Stages & Conversion Mechanics

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│ 1. Cold Email   │ ───▶  │ 2. /aba Landing │ ───▶  │ 3. Intake Quiz  │ ───▶  │ 4. Cal.com Book │
│ (3-Touch + Opt) │       │ (Fit & Proof)   │       │ (4 Step Auto-Adv)│      │ (Auto Call Sched)│
└────────┬────────┘       └─────────────────┘       └────────┬────────┘       └────────┬────────┘
         │                                                   │                         │
         ▼                                                   ▼                         ▼
   Open Pixel / Tracked Click                       CRM: form_completed         CRM: call_scheduled
   Telegram Alert 👁️ / 🎯                           Telegram Alert 📋           Telegram Alert 📅 ($50/$150)
```

### Stage Transitions:
1. **Sourced ➔ Queued:** Admin approvals via Review Queue or Telegram `/approve`.
2. **Queued ➔ Contacted:** Dispatcher sends Touch 1; stamps `first_contacted_at` and `sequence_step = 1`.
3. **Contacted ➔ Opened / Clicked:** Tracking pixel `GET /crm/api/track/open` and redirector `GET /crm/api/track/click`.
4. **Clicked ➔ Form Completed:** Visitor completes `/aba` intake form; API updates answers, stamps `form_completed`.
5. **Form Completed ➔ Call Scheduled:** Webhook from Cal.com/Calendly sets `call_scheduled_for`, moves lead to `call_scheduled`.
6. **Call Scheduled ➔ Qualified Show ($50):** Confirmed attendance logged; $50 bounty earned in ledger (Net-7).
7. **Qualified Show ➔ Closed Won ($150):** Deposit logged; $150 bounty earned in ledger (Net-7).

---

## 2. Multi-Touch Email Sequence Copy

### Touch 1 (Day 0) — "Commercial Caseload Bottleneck"
- **Subject:** Quick question about {{company_name}}'s caseload in {{state}}
- **Preview:** Filling open slots without PE marketing budgets
- **Body:**
```text
Hi {{contact_first_name}},

I was looking at independent ABA practices in {{city}} and came across {{company_name}}.

Most clinic owners with 1–{{locations_count}} locations we talk to in {{state}} tell us their primary bottleneck isn't clinical expertise—it's getting a predictable flow of commercial-insurance and private-pay inquiries without selling out to PE roll-ups or burning margin on generic agencies.

We built an intake & patient growth system specifically for independent practices. You can see how the intake flow and caseload matching work here:

{{TRACKED_URL_TOUCH_1}}

Do you have 15 minutes this Thursday or Friday to see if this fits your current openings?

Best,
Hudson Argollo
ABA Practice Growth · Gold Traffic
```

---

### Touch 2 (Day +3) — "The Waitlist Conversion Leak"
- **Subject:** Re: {{company_name}}'s openings in {{state}}
- **Preview:** How independent clinics convert waitlists when BCBA slots open
- **Body:**
```text
Hi {{contact_first_name}},

Quick follow-up on my note from earlier this week.

When clinics expand or onboard new BCBAs/RBTs, the hardest part is usually timing: converting waitlisted families the exact week a slot opens rather than watching them drop off to competitor waitlists.

We put together a 20-minute discovery breakdown for independent practices:
{{TRACKED_URL_TOUCH_2}}

Would love to share what's working for clinics in {{state}} if you're open to comparing notes.

Best,
Hudson
```

---

### Touch 3 (Day +7) — "2-Minute Fit Assessment"
- **Subject:** Filling {{company_name}}'s caseload ({{state}})
- **Preview:** 4-question fit check for independent practices
- **Body:**
```text
Hi {{contact_first_name}},

I know you're busy running {{company_name}} and managing clinical plans.

If patient intake or waitlist conversion isn't a priority right now, no worries at all. If you ever want to check our 2-minute fit assessment or see if our model works for your current capacity, you can bookmark this link:

{{TRACKED_URL_TOUCH_3}}

Wishing you and your clinical team continued success in {{city}}!

Best,
Hudson
```

---

### Touch 4 (Day +14) — "Permission to Close File" (Breakup)
- **Subject:** Closing out {{company_name}}'s file for now?
- **Preview:** Quick check before I archive your clinic's notes
- **Body:**
```text
Hi {{contact_first_name}},

Usually when I haven't heard back, it means one of two things:
1. Your caseload and waitlist in {{city}} are already at 100% capacity.
2. You're interested, but the timing is bad.

If you'd like me to follow up in a few months when you're looking to open new rooms or hire BCBAs, just reply "later". 

Otherwise, if you ever want to review our intake framework, it's always live at:
{{TRACKED_URL_TOUCH_4}}

Thanks for all you do for the autism community in {{state}}.

Best,
Hudson
```
