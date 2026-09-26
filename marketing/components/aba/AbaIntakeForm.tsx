"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, ArrowRight, CalendarCheck, Check, Loader2 } from "lucide-react";
import { ABA, CRM_API_BASE } from "@/lib/aba-config";
import { trackEvent } from "@/lib/analytics";
import { captureAttribution, emptyAttribution, withBookingParams, type Attribution } from "@/lib/attribution";

// ── Answer vocabulary — mirrors worker/crm-entry.js#POST /crm/api/public/intake ─

export const LOCATION_OPTIONS = [
  { value: "1", label: "1 location", hint: "Single clinic, maybe in-home too" },
  { value: "2-3", label: "2–3 locations" },
  { value: "4-5", label: "4–5 locations" },
  { value: "6+", label: "6 or more", hint: "We're built for 1–5 — you can still book, we'll be candid on the call" },
] as const;

export const CAPACITY_OPTIONS = [
  { value: "open_now", label: "We have open capacity right now", hint: "Slots sitting empty this month" },
  { value: "full_waitlist", label: "Full, with a waitlist", hint: "Families waiting, no slots" },
  { value: "full_no_waitlist", label: "Full, no waitlist", hint: "Steady, not growing" },
  { value: "hiring", label: "Hiring clinicians to open capacity", hint: "BCBAs/RBTs starting soon" },
] as const;

export const PRIORITY_OPTIONS = [
  { value: "commercial_private", label: "More commercial-insurance & private-pay families" },
  { value: "fill_waitlist", label: "Fill the waitlist — and keep it converting" },
  { value: "hire_bcbas", label: "Hire BCBAs so we can take more cases" },
  { value: "new_location", label: "Open the next location" },
  { value: "payer_diversification", label: "Depend less on one payer / Medicaid" },
] as const;

export const TIMELINE_OPTIONS = [
  { value: "30_days", label: "Next 30 days", hint: "We have openings now" },
  { value: "60_90_days", label: "60–90 days", hint: "Lining up with hiring or a new site" },
  { value: "exploring", label: "Exploring — no fixed date" },
] as const;

const US_STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

interface Answers {
  locations: string;
  capacity: string;
  priority: string;
  timeline: string;
  name: string;
  clinic: string;
  email: string;
  phone: string;
  state: string;
  website: string;
  /** honeypot — must stay empty */
  company_fax: string;
}

const EMPTY: Answers = { locations: "", capacity: "", priority: "", timeline: "", name: "", clinic: "", email: "", phone: "", state: "", website: "", company_fax: "" };

const STEP_KEYS = ["locations", "capacity", "priority", "timeline", "contact", "book"] as const;
type Step = (typeof STEP_KEYS)[number];

// ── UI atoms ───────────────────────────────────────────────────────────────

function Choice({ options, value, onChange }: { options: readonly { value: string; label: string; hint?: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid gap-2">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3.5 text-left transition-all duration-150 ${
              active ? "border-green bg-green-subtle text-ink" : "border-sand-dark/25 bg-paper text-ink/75 hover:border-sand-dark/50"
            }`}
          >
            <span>
              <span className="block text-[15px] font-medium leading-snug">{o.label}</span>
              {o.hint && <span className="mt-0.5 block text-xs text-ink/50">{o.hint}</span>}
            </span>
            <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${active ? "border-green bg-green text-ivory" : "border-sand-dark/40"}`}>
              {active && <Check size={12} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-sand-dark/25 bg-paper px-4 py-3 text-[15px] text-ink placeholder:text-ink/30 outline-none transition-colors focus:border-green";

function Question({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="mb-5">
      <h3 className="text-xl font-semibold leading-snug text-ink sm:text-2xl">{label}</h3>
      {sub && <p className="mt-1.5 text-sm text-ink/55">{sub}</p>}
    </div>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ── Form ───────────────────────────────────────────────────────────────────

export default function AbaIntakeForm() {
  const [step, setStep] = useState<Step>("locations");
  const [a, setA] = useState<Answers>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [leadId, setLeadId] = useState<string | null>(null);
  const attribution = useRef<Attribution>(emptyAttribution());
  const started = useRef(false);

  useEffect(() => {
    attribution.current = captureAttribution();
  }, []);

  const idx = STEP_KEYS.indexOf(step);
  const progress = Math.round((idx / (STEP_KEYS.length - 1)) * 100);
  const set = (k: keyof Answers) => (v: string) => setA((cur) => ({ ...cur, [k]: v }));

  function go(next: Step) {
    if (!started.current) {
      started.current = true;
      trackEvent("form_start");
    }
    setError("");
    setStep(next);
  }
  const pick = (k: keyof Answers, next: Step) => (v: string) => {
    set(k)(v);
    // Auto-advance on choice — one tap per question.
    setTimeout(() => go(next), 160);
  };

  const contactValid = a.name.trim().length > 1 && a.clinic.trim().length > 1 && EMAIL_RE.test(a.email.trim()) && a.state;

  async function submit() {
    if (!contactValid || submitting) return;
    if (a.company_fax) return; // bot
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${CRM_API_BASE}/crm/api/public/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: { locations: a.locations, capacity: a.capacity, priority: a.priority, timeline: a.timeline },
          contact: { name: a.name.trim(), clinic: a.clinic.trim(), email: a.email.trim(), phone: a.phone.trim(), state: a.state, website: a.website.trim() },
          attribution: attribution.current,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Something went wrong — please try again.");
      setLeadId(json.leadId || null);
      trackEvent("form_complete");
      go("book");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const bookingSrc = useMemo(
    () => withBookingParams(ABA.bookingUrl, { ...attribution.current, lid: leadId || attribution.current.lid }, { name: a.name, email: a.email }),
    [leadId, a.name, a.email]
  );

  const back = () => idx > 0 && go(STEP_KEYS[idx - 1]);

  return (
    <section id="intake-section" className="bg-ivory py-20 sm:py-28">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <p className="label-tech mb-4">Fit check · 2 minutes</p>
          <h2 className="text-balance text-3xl font-bold leading-tight tracking-display text-ink sm:text-4xl">Let's see if we can fill your openings.</h2>
          <p className="mt-4 text-pretty text-lg text-ink/65">
            Four quick questions about your practice, then pick a time. You'll talk to someone who has looked at your answers — not a setter reading
            a script.
          </p>
          <ul className="mt-8 space-y-3 text-[15px] text-ink/75">
            {["No commitment, no proposal you didn't ask for", `${ABA.callMinutes} minutes, owner to owner`, "If we're not the right fit, we'll tell you who might be"].map((t) => (
              <li key={t} className="flex gap-3">
                <Check size={18} className="mt-0.5 shrink-0 text-green" /> {t}
              </li>
            ))}
          </ul>
        </div>

        {/* CTAs target the card, not the section — on mobile the pitch column
            sits above the form, and landing on it means scrolling past a wall
            of text before the first question (same friction the PT page hit). */}
        <div id="intake" className="surface-paper-raised scroll-mt-24 rounded-2xl p-6 sm:p-8">
          {/* progress */}
          <div className="mb-6">
            <div className="mb-2 flex items-center justify-between font-mono text-[11px] uppercase tracking-wider text-ink/45">
              <span>{step === "book" ? "Pick a time" : step === "contact" ? "Your details" : `Question ${idx + 1} of 4`}</span>
              <span>{progress}%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-sand/25">
              <motion.div className="h-full bg-green" animate={{ width: `${progress}%` }} transition={{ duration: 0.4, ease: "easeOut" }} />
            </div>
          </div>

          <AnimatePresence mode="wait">
            <motion.div key={step} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -18 }} transition={{ duration: 0.22 }}>
              {step === "locations" && (
                <>
                  <Question label="How many locations does your practice run today?" sub="Count clinics with their own address. In-home only counts as one." />
                  <Choice options={LOCATION_OPTIONS} value={a.locations} onChange={pick("locations", "capacity")} />
                </>
              )}
              {step === "capacity" && (
                <>
                  <Question label="Where is your caseload right now?" />
                  <Choice options={CAPACITY_OPTIONS} value={a.capacity} onChange={pick("capacity", "priority")} />
                </>
              )}
              {step === "priority" && (
                <>
                  <Question label="What's the one growth priority for the next two quarters?" sub="Pick the one that would change the year if it happened." />
                  <Choice options={PRIORITY_OPTIONS} value={a.priority} onChange={pick("priority", "timeline")} />
                </>
              )}
              {step === "timeline" && (
                <>
                  <Question label="When do you want new families starting?" />
                  <Choice options={TIMELINE_OPTIONS} value={a.timeline} onChange={pick("timeline", "contact")} />
                </>
              )}
              {step === "contact" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    submit();
                  }}
                >
                  <Question label="Where should we send the call details?" sub="We only use this to run the call and send a short recap." />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <input required autoComplete="name" placeholder="Your name" value={a.name} onChange={(e) => set("name")(e.target.value)} className={inputCls} />
                    <input required autoComplete="organization" placeholder="Practice name" value={a.clinic} onChange={(e) => set("clinic")(e.target.value)} className={inputCls} />
                    <input required type="email" autoComplete="email" placeholder="Work email" value={a.email} onChange={(e) => set("email")(e.target.value)} className={inputCls} />
                    <input type="tel" autoComplete="tel" placeholder="Mobile (optional, for a reminder text)" value={a.phone} onChange={(e) => set("phone")(e.target.value)} className={inputCls} />
                    <select required value={a.state} onChange={(e) => set("state")(e.target.value)} className={`${inputCls} ${a.state ? "" : "text-ink/30"}`}>
                      <option value="">State</option>
                      {US_STATES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <input autoComplete="url" placeholder="Website (optional)" value={a.website} onChange={(e) => set("website")(e.target.value)} className={inputCls} />
                    {/* Honeypot — hidden from humans, filled by bots. */}
                    <input tabIndex={-1} autoComplete="off" aria-hidden className="absolute -left-[9999px] h-0 w-0 opacity-0" name="company_fax" value={a.company_fax} onChange={(e) => set("company_fax")(e.target.value)} />
                    {/* Hidden attribution — read from the outreach link on first paint, see lib/attribution.ts. */}
                    <input type="hidden" name="lid" value={attribution.current.lid} readOnly />
                    <input type="hidden" name="utm_source" value={attribution.current.utm_source} readOnly />
                    <input type="hidden" name="utm_medium" value={attribution.current.utm_medium} readOnly />
                    <input type="hidden" name="utm_campaign" value={attribution.current.utm_campaign} readOnly />
                    <input type="hidden" name="utm_content" value={attribution.current.utm_content} readOnly />
                    <input type="hidden" name="utm_term" value={attribution.current.utm_term} readOnly />
                  </div>
                  {error && <p className="mt-3 text-sm text-danger">{error}</p>}
                  <button
                    type="submit"
                    disabled={!contactValid || submitting}
                    className="glow-action mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-green text-base font-semibold text-ivory transition-colors hover:bg-green-hover disabled:opacity-50"
                  >
                    {submitting ? <Loader2 size={16} className="animate-spin" /> : <CalendarCheck size={16} />} Continue to pick a time
                  </button>
                  <p className="mt-3 text-center text-xs text-ink/45">No spam, no list. One call, then you decide.</p>
                </form>
              )}
              {step === "book" && (
                <div>
                  <Question
                    label={`Pick a ${ABA.callMinutes}-minute slot`}
                    sub={a.locations === "6+" ? "Heads-up: we focus on 1–5 location practices. Book anyway — we'll be candid about fit." : "Times shown in your timezone. You'll get a calendar invite right away."}
                  />
                  {bookingSrc ? (
                    <iframe
                      title="Book your discovery call"
                      src={bookingSrc}
                      className="h-[640px] w-full rounded-lg border border-sand-dark/20 bg-paper"
                      allow="payment"
                    />
                  ) : (
                    <div className="rounded-lg border border-success/25 bg-success/[0.05] p-5 text-[15px] text-ink">
                      <p className="font-semibold">You're in. We'll email {a.email} within one business day with three times to pick from.</p>
                      <p className="mt-2 text-sm text-ink/60">(Set NEXT_PUBLIC_BOOKING_URL to show the live calendar here instead.)</p>
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {step !== "locations" && step !== "book" && (
            <button type="button" onClick={back} className="mt-5 inline-flex items-center gap-1.5 text-sm text-ink/50 hover:text-ink">
              <ArrowLeft size={14} /> back
            </button>
          )}
          {step === "locations" && (
            <p className="mt-5 flex items-center gap-1.5 text-xs text-ink/45">
              <ArrowRight size={12} /> Tap an answer to continue
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
