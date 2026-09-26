#!/usr/bin/env node
/**
 * Live Activity & Event Stream Watcher for ABA LEADGEN
 * Polls the live Cloudflare CRM event log and streams incoming opens, clicks,
 * form submissions, and booking webhooks in real time with colorized terminal output.
 * 
 * Usage:
 *   node scripts/watch-live-activity.mjs [--token <token>] [--interval 3000]
 */
import { formatRowResult } from "../src/crm/leadValidation.ts";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};

const token = opt("token", process.env.CRM_TOKEN || "eyJlbWFpbCI6Imh1ZHNvbmFyZ29sbG9AZ21haWwuY29tIiwiZXhwIjoxNzkyODg1MzU1fQ.bfe69f41d1d7c6eb8acc5324d096b0d118836daf95632b9395878096684042eb");
const api = (process.env.CRM_API || "https://abaclinics.clubemkt.digital").replace(/\/+$/, "");
const intervalMs = Math.max(1000, Number(opt("interval", 3000)) || 3000);

console.log(`\n=======================================================`);
console.log(`📡 ABA LEADGEN — Live Real-Time Activity Stream`);
console.log(`🌐 Target API: ${api}`);
console.log(`⏱️ Polling:    Every ${(intervalMs / 1000).toFixed(1)}s`);
console.log(`=======================================================\n`);
console.log(`Listening for live email opens, link clicks, intake forms, and call bookings...\n`);

const seenEventIds = new Set();
let isFirstRun = true;

const EVENT_ICONS = {
  email_opened: "👁️  [EMAIL OPENED]",
  link_clicked: "🎯 [LINK CLICKED]",
  form_completed: "📋 [INTAKE COMPLETED]",
  call_booked: "📅 [CALL SCHEDULED]",
  call_rescheduled: "🔄 [CALL RESCHEDULED]",
  touch_logged: "✉️  [TOUCH LOGGED]",
  qualified_show: "✅ [QUALIFIED SHOW ($50)]",
  closed_won: "💰 [CLOSED WON ($150)]",
};

async function pollEvents() {
  try {
    const res = await fetch(`${api}/crm/api/webhooks/events?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;

    const data = await res.json().catch(() => ({}));
    const events = (data.events || []).reverse();

    for (const ev of events) {
      if (!seenEventIds.has(ev.id)) {
        seenEventIds.add(ev.id);
        if (!isFirstRun) {
          const icon = EVENT_ICONS[ev.event_type] || `⚡ [${ev.event_type.toUpperCase()}]`;
          const timeStr = new Date(ev.received_at || Date.now()).toLocaleTimeString();
          console.log(`\x1b[1;32m${icon}\x1b[0m \x1b[90m(${timeStr})\x1b[0m`);
          console.log(`   Provider: ${ev.provider} | Result: ${ev.result}`);
          if (ev.detail) console.log(`   Detail:   ${ev.detail}`);
          console.log(`───────────────────────────────────────────────────────`);
        }
      }
    }
    isFirstRun = false;
  } catch (e) {
    // Ignore transient network errors
  }
}

// Initial poll
pollEvents();
setInterval(pollEvents, intervalMs);
