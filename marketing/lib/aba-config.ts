/**
 * Single place to brand the ABA intake funnel (/aba). Everything the page
 * says about the client lives here — swap the placeholders and the copy in
 * components/aba/* picks it up. No component hardcodes a brand name.
 */
export const ABA = {
  /** Client brand as shown in the nav, hero, footer. */
  brand: "{{BRAND}}",
  /** One-line positioning under the logo. Keep it under ~8 words. */
  tagline: "Patient growth for independent ABA practices",
  /** Legal footer line. */
  legalName: "{{BRAND LEGAL NAME}}",
  supportEmail: "hello@example.com",

  /**
   * Booking widget. Cal.com: https://cal.com/<user>/<event>
   * Calendly: https://calendly.com/<user>/<event>
   * Set NEXT_PUBLIC_BOOKING_URL at build time; leave unset to show the
   * "we'll email you times" fallback instead of an empty iframe.
   */
  bookingUrl: process.env.NEXT_PUBLIC_BOOKING_URL || "",
  /** Discovery-call length, shown on the booking step. */
  callMinutes: 20,

  /**
   * Proof points. Replace with the client's real numbers before launch —
   * the page renders them verbatim. Keep the shape; drop any you can't back.
   */
  proof: [
    { value: "1–5", label: "locations is exactly who we build for" },
    { value: "20 min", label: "discovery call — no deck, no pitch" },
    { value: "$0", label: "to find out whether we can help" },
  ],

  /** States the pilot prioritizes — used only to personalize copy. */
  priorityStates: ["TX", "FL", "CA", "NC", "CO", "VA", "MD", "IL", "UT", "GA", "NJ"],
} as const;

/** Where the pipeline API lives. Same host as the marketing site in production
 *  (Workers Routes), so a relative path is correct there; set
 *  NEXT_PUBLIC_CRM_API for local dev against a remote worker. */
export const CRM_API_BASE = process.env.NEXT_PUBLIC_CRM_API || "";
