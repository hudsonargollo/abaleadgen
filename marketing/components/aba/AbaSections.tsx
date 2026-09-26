"use client";

import { motion } from "framer-motion";
import { ArrowRight, Check, X, Search, Users, Hourglass, PhoneCall, Map, LineChart } from "lucide-react";
import { ABA } from "@/lib/aba-config";
import { trackEvent } from "@/lib/analytics";

const fade = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
};

// ── Hero ───────────────────────────────────────────────────────────────────

export function AbaHero() {
  return (
    <section id="top" className="relative overflow-hidden bg-ivory pt-32 pb-16 sm:pt-40 sm:pb-24">
      <div aria-hidden className="bp-lines pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
      <div className="relative mx-auto max-w-6xl px-6">
        <motion.p {...fade} className="label-tech mb-5">
          For independent ABA practice owners · 1–5 locations
        </motion.p>
        <motion.h1 {...fade} transition={{ ...fade.transition, delay: 0.05 }} className="max-w-3xl text-balance text-4xl font-bold leading-[1.05] tracking-display text-ink sm:text-6xl">
          Fill your caseload without selling your practice.
        </motion.h1>
        <motion.p {...fade} transition={{ ...fade.transition, delay: 0.1 }} className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-ink/70 sm:text-xl">
          The rollups are buying the clinics down the street and outspending you on every family searching for ABA.{" "}
          <span className="text-ink">{ABA.brand}</span> brings independent practices a steady flow of the commercial-insurance and private-pay
          families they need to grow on their own terms — without a private-equity budget.
        </motion.p>
        <motion.div {...fade} transition={{ ...fade.transition, delay: 0.15 }} className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
          <a
            href="#intake"
            onClick={() => trackEvent("cta_click")}
            className="glow-action inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-green px-7 text-base font-semibold text-ivory transition-colors hover:bg-green-hover"
          >
            See if we can fill your openings <ArrowRight size={16} />
          </a>
          <a href="#how" className="inline-flex h-12 items-center justify-center rounded-lg border border-sand-dark/40 px-6 text-base font-semibold text-ink transition-colors hover:bg-green-subtle">
            How it works
          </a>
        </motion.div>
        <motion.dl {...fade} transition={{ ...fade.transition, delay: 0.2 }} className="mt-14 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-3">
          {ABA.proof.map((p) => (
            <div key={p.label} className="surface-paper rounded-xl px-5 py-4">
              <dt className="font-mono text-2xl font-semibold text-green">{p.value}</dt>
              <dd className="mt-1 text-sm leading-snug text-ink/65">{p.label}</dd>
            </div>
          ))}
        </motion.dl>
      </div>
    </section>
  );
}

// ── Problem: the rollup squeeze ────────────────────────────────────────────

const SQUEEZE = [
  {
    icon: Search,
    title: "They buy the search results",
    body: "A family types “ABA therapy near me” and sees a national brand first — not because it's better, but because it bids on every keyword in your county. Your website doesn't get the click.",
  },
  {
    icon: Users,
    title: "They absorb the BCBAs",
    body: "Signing bonuses and relocation packages you can't match. Every clinician they hire is a case you can't take, and a waitlist family who eventually calls someone else.",
  },
  {
    icon: Hourglass,
    title: "They wait for you to get tired",
    body: "Then the acquisition offer arrives — a multiple that prices in your exhaustion, not the practice you built. The clinics that stay independent are the ones with a full caseload and a full pipeline.",
  },
];

export function AbaSqueeze() {
  return (
    <section className="bg-ink-950 py-20 text-ivory sm:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <motion.p {...fade} className="label-tech-ink mb-4">
          The independent's problem
        </motion.p>
        <motion.h2 {...fade} className="max-w-3xl text-balance text-3xl font-bold leading-tight tracking-display sm:text-4xl">
          You didn't open a clinic to compete with a private-equity marketing budget.
        </motion.h2>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {SQUEEZE.map((s, i) => (
            <motion.div key={s.title} {...fade} transition={{ ...fade.transition, delay: i * 0.06 }} className="surface-ink-2 rounded-xl p-6">
              <s.icon size={20} className="text-green-mist" />
              <h3 className="mt-4 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ivory/65">{s.body}</p>
            </motion.div>
          ))}
        </div>
        <motion.p {...fade} className="text-editorial mt-12 max-w-3xl text-xl leading-relaxed text-ivory/85 sm:text-2xl">
          The independents that stay independent aren't out-spending the rollups. They're out-converting them — consistent referral flow, an
          intake that answers the phone, and a caseload mix that doesn't hinge on one payer.
        </motion.p>
      </div>
    </section>
  );
}

// ── How it works ───────────────────────────────────────────────────────────

const STEPS = [
  {
    icon: PhoneCall,
    n: "01",
    title: `A ${ABA.callMinutes}-minute discovery call`,
    body: "We map your open capacity, waitlist, payer mix and hiring plan. You'll leave knowing whether patient growth is your bottleneck — or something else is. If it's something else, we'll say so.",
  },
  {
    icon: Map,
    n: "02",
    title: "A growth plan sized to your clinic",
    body: "Which channels bring families that match your openings: pediatrician and school referral partnerships, local search that beats the national brands in your zip codes, and intake follow-up that stops leaks.",
  },
  {
    icon: LineChart,
    n: "03",
    title: "We run it. You review the families.",
    body: "Weekly numbers — inquiries, intakes scheduled, insurance verified, first sessions. You keep clinical control and the client relationship. We keep the pipeline full.",
  },
];

export function AbaHow() {
  return (
    <section id="how" className="bg-ivory py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <motion.p {...fade} className="label-tech mb-4">
          How it works
        </motion.p>
        <motion.h2 {...fade} className="max-w-3xl text-balance text-3xl font-bold leading-tight tracking-display text-ink sm:text-4xl">
          Growth that fits a 1-to-5-location practice — not a template built for a 60-clinic platform.
        </motion.h2>
        <ol className="mt-12 grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <motion.li key={s.n} {...fade} transition={{ ...fade.transition, delay: i * 0.06 }} className="surface-paper-raised rounded-xl p-6">
              <div className="flex items-center justify-between">
                <s.icon size={20} className="text-green" />
                <span className="font-mono text-xs text-sand-dark">{s.n}</span>
              </div>
              <h3 className="mt-4 text-lg font-semibold text-ink">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink/65">{s.body}</p>
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ── Fit ────────────────────────────────────────────────────────────────────

const FIT_YES = [
  "You own the practice — founder, owner, CEO or executive director",
  "1 to 5 locations, or 1 location and a plan for the second",
  "You have capacity now, or BCBAs joining in the next 90 days",
  "You want more commercial-insurance or private-pay families in the mix",
  "You'd rather grow than sell",
];
const FIT_NO = [
  "PE-backed or national multi-state groups",
  "Staffing agencies and BCBA placement firms",
  "School-district or hospital-based programs",
  "Solo practitioners without a clinic location",
  "Practices that can't take a new family in the next 90 days",
];

export function AbaFit() {
  return (
    <section className="border-y border-ink/10 bg-paper py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-6">
        <motion.h2 {...fade} className="max-w-3xl text-balance text-3xl font-bold leading-tight tracking-display text-ink sm:text-4xl">
          We only take practices we can actually fill.
        </motion.h2>
        <motion.p {...fade} className="mt-4 max-w-2xl text-lg text-ink/65">
          The discovery call is a fit check in both directions. Here's the honest version of who we're for.
        </motion.p>
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <motion.div {...fade} className="rounded-xl border border-success/25 bg-success/[0.04] p-6">
            <p className="label-tech mb-4 !text-success">A good fit</p>
            <ul className="space-y-3">
              {FIT_YES.map((t) => (
                <li key={t} className="flex gap-3 text-[15px] leading-snug text-ink">
                  <Check size={18} className="mt-0.5 shrink-0 text-success" /> {t}
                </li>
              ))}
            </ul>
          </motion.div>
          <motion.div {...fade} transition={{ ...fade.transition, delay: 0.06 }} className="rounded-xl border border-ink/10 bg-ivory p-6">
            <p className="label-tech mb-4 !text-ink/50">Not a fit</p>
            <ul className="space-y-3">
              {FIT_NO.map((t) => (
                <li key={t} className="flex gap-3 text-[15px] leading-snug text-ink/70">
                  <X size={18} className="mt-0.5 shrink-0 text-sand-dark" /> {t}
                </li>
              ))}
            </ul>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

// ── FAQ ────────────────────────────────────────────────────────────────────

const FAQ = [
  {
    q: "Is this an acquisition pitch?",
    a: `No. ${ABA.brand} does not buy practices, broker sales, or take equity. We get paid to bring you families. If you ever want to sell, you'll do it from a position of a full caseload — which is the only position worth selling from.`,
  },
  {
    q: "What happens on the discovery call?",
    a: `${ABA.callMinutes} minutes, no slides. We ask about your locations, open capacity, waitlist, payer mix and hiring. You ask us anything. At the end we tell you plainly whether we think we can help and what it would look like. If we can't, we'll tell you that too.`,
  },
  {
    q: "We're at capacity with a waitlist. Why would we need more families?",
    a: "A waitlist is only an asset if it converts when a slot opens. Most independents lose 30–50% of waitlisted families to the first clinic that calls back. We help you keep the list warm, prioritize the families that fit your openings, and keep intake ahead of your hiring — so a new BCBA starts with a caseload, not an empty calendar.",
  },
  {
    q: "Do you work with Medicaid-heavy practices?",
    a: "Yes — and a common goal is diversifying the mix so one payer's rate change can't decide your year. Growth plans usually target commercial-insurance and private-pay families alongside your existing base.",
  },
  {
    q: "What do you need from us?",
    a: "An owner on the call, an intake person who answers the phone, and honest numbers. We handle the rest.",
  },
];

export function AbaFaq() {
  return (
    <section className="bg-ivory py-20 sm:py-24">
      <div className="mx-auto max-w-3xl px-6">
        <motion.h2 {...fade} className="text-3xl font-bold tracking-display text-ink">
          Questions owners ask before the call
        </motion.h2>
        <div className="mt-8 divide-y divide-ink/10 border-y border-ink/10">
          {FAQ.map((f) => (
            <details key={f.q} className="group py-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[17px] font-semibold text-ink">
                {f.q}
                <span className="font-mono text-green transition-transform group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 text-pretty text-[15px] leading-relaxed text-ink/70">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
