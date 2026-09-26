# Multi-Channel Outbound (Voice + Email) Implementation Plan

## Objective
Scale the ABA LeadGen pipeline by orchestrating automated cold calls and personalized cold emails with unified link tracking and meeting scheduling.

## 1. Unified Multi-Channel Strategy
- **Sequence:** Cold Email (Step 1) -> Follow-up Call (Step 2) -> Multi-channel Nurture.
- **Link Tracking:** Both channels use `go.goldplanner...` unique slugs to track intent before/during a call.
- **Goal:** Move lead to `call_scheduled` via either automated booking (Email CTA) or live agent booking (Phone).

## 2. Technical Stack

| Layer | Tools | Role |
| :--- | :--- | :--- |
| **Email Delivery** | Resend / Apollo | Personalized delivery of generated campaigns. |
| **Voice AI** | Pipecat (Python) + Twilio | Low-latency outbound calling with interruption handling. |
| **Intelligence** | GPT-4o Realtime | Real-time reasoning and tool-calling for scheduling. |
| **Scheduling** | Cal.com API | Live slot lookup and booking. |
| **CRM Backend** | Hono + D1 | Shared state for touches, events, and stage transitions. |

## 3. Implementation Workflow

### Phase 1: Email Campaign Scale-up (Available Now)
- [x] Generator script created (`automation/email/generate-campaign.mjs`).
- [ ] **Action:** Integrate with Resend API to send directly from the CRM.
- [ ] **Action:** Create `POST /crm/api/leads/:id/email` to trigger individual or batch sends.

### Phase 2: Voice Agent Prototype (Starting Now)
- [ ] **Action:** Setup `automation/calling/outbound_agent.py` using Pipecat.
- [ ] **Action:** Script reads `leads` from D1 where `status = 'queued'` and `icp_fit = 'fit'`.
- [ ] **Action:** Implement `book_meeting` tool inside the voice agent.

### Phase 3: Unified Reporting
- [ ] **Action:** Update CRM Dashboard to show "Email CTR" vs "Call Answer Rate" side-by-side.
- [ ] **Action:** Unified `outreach_touches` log for all channels.

## 4. Acceptance Criteria
- [ ] Voice agent successfully completes a call and logs the transcript to `lead_events`.
- [ ] Email campaign sent with 100% correct `lid` parameters.
- [ ] Booking via phone call moves lead to `call_scheduled` in CRM.
- [ ] Booking via email link moves lead to `form_completed` -> `call_scheduled`.
