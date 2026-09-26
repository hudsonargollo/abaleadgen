/**
 * Telegram Bot & Notification Service for ABA LeadGen by hdsnrgll
 * Dispatches real-time alerts for email opens, link clicks, intake submissions,
 * discovery bookings, and bounty payouts with 1-tap interactive inline buttons.
 */

export async function sendTelegramAlert(env, text, inlineKeyboard = null) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  };

  if (inlineKeyboard && inlineKeyboard.length > 0) {
    payload.reply_markup = {
      inline_keyboard: inlineKeyboard,
    };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json().catch(() => ({}));
  } catch (e) {
    console.error("Failed to send Telegram alert:", e);
    return null;
  }
}

/**
 * Format instant event alerts
 */
export function formatOpenAlert(lead, touchId) {
  const name = lead.decision_maker_name || "Lead";
  const company = lead.company_name || "Clinic";
  const state = lead.state || "US";
  const touch = touchId ? `Touch ${touchId}` : "Email";

  return `👁️ *[${touch}] Email Opened*\n` +
         `🏢 *${company}* (${state})\n` +
         `👤 ${name} (${lead.verified_email || "no email"})\n` +
         `🕒 _${new Date().toLocaleTimeString()} EST_`;
}

export function formatClickAlert(lead, touchId, targetUrl) {
  const name = lead.decision_maker_name || "Lead";
  const company = lead.company_name || "Clinic";
  const state = lead.state || "US";
  const touch = touchId ? `Touch ${touchId}` : "Link";

  return `🎯 *[${touch}] Link Clicked*\n` +
         `🏢 *${company}* (${state})\n` +
         `👤 ${name}\n` +
         `🔗 [Landing Page](${targetUrl || "https://abaclinics.clubemkt.digital/aba"})\n` +
         `🕒 _${new Date().toLocaleTimeString()} EST_`;
}

export function formatIntakeAlert(lead, answers) {
  const company = lead.company_name || "Clinic";
  const state = lead.state || "US";
  const name = lead.decision_maker_name || "Lead";
  const locations = answers?.locations || "1";
  const capacity = answers?.capacity || "Open";

  return `📋 *New Intake Form Completed!*\n\n` +
         `🏢 *${company}* (${state})\n` +
         `👤 ${name} — ${lead.verified_email || ""}\n` +
         `📍 Locations: *${locations}*\n` +
         `📊 Capacity: *${capacity}*\n` +
         `🎯 Next Step: Redirected to Discovery Booking\n` +
         `🕒 _${new Date().toLocaleTimeString()} EST_`;
}

export function formatBookingAlert(lead, event) {
  const company = lead.company_name || "Clinic";
  const state = lead.state || "US";
  const name = lead.decision_maker_name || "Lead";
  const timeStr = lead.call_scheduled_for || "Upcoming";

  return `📅 *Discovery Call Scheduled!* 🚀\n\n` +
         `🏢 *${company}* (${state})\n` +
         `👤 ${name}\n` +
         `⏰ Scheduled For: *${timeStr}*\n` +
         `💵 Potential Bounty: *$50 Qualified Show / $150 Closed Won*\n` +
         `🕒 _${new Date().toLocaleTimeString()} EST_`;
}
