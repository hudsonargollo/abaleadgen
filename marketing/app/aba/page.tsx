import type { Metadata } from "next";
import AnalyticsBeacon from "@/components/AnalyticsBeacon";
import { AbaNav, AbaFooter } from "@/components/aba/AbaShell";
import { AbaHero, AbaSqueeze, AbaHow, AbaFit, AbaFaq } from "@/components/aba/AbaSections";
import AbaIntakeForm from "@/components/aba/AbaIntakeForm";
import { ABA } from "@/lib/aba-config";

// Isolated route for the ABA outbound funnel — same non-destructive pattern
// as /formv2 and /v2: the production homepage (app/page.tsx, pt-BR) is
// untouched. Cold-outreach links point here:
//   /aba?lid=<leadId>&utm_source=cold_email&utm_medium=email
//       &utm_campaign=<batch_id>&utm_content=step<N>
// lib/attribution.ts captures those on first paint; the intake form posts
// them with the answers to POST /crm/api/public/intake, which advances the
// matching lead to form_completed (or creates an inbound lead).

export const metadata: Metadata = {
  title: `${ABA.brand} — Fill your ABA caseload without selling your practice`,
  description:
    "Patient and referral growth for independently owned ABA practices with 1–5 locations. Commercial-insurance and private-pay families, without a private-equity marketing budget. Book a 20-minute discovery call.",
  openGraph: {
    title: `${ABA.brand} — Fill your ABA caseload without selling your practice`,
    description: "Growth for independent ABA practices with 1–5 locations. Book a 20-minute discovery call.",
    locale: "en_US",
    type: "website",
  },
  robots: { index: false, follow: false }, // outreach landing page — keep it out of search until the client says otherwise
};

export const runtime = "edge";

export default function AbaLandingPage() {
  return (
    <>
      <AnalyticsBeacon />
      <AbaNav />
      <main>
        <AbaHero />
        <AbaSqueeze />
        <AbaHow />
        <AbaFit />
        <AbaIntakeForm />
        <AbaFaq />
      </main>
      <AbaFooter />
    </>
  );
}
