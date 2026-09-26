"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { ArrowRight } from "lucide-react";
import Logo from "@/components/Logo";
import { ABA } from "@/lib/aba-config";
import { trackEvent } from "@/lib/analytics";

/** Sticky top bar for the /aba funnel — light theme, one CTA, no site nav
 *  (a cold-outreach landing page should have exactly one place to go). */
export function AbaNav() {
  const { scrollY } = useScroll();
  const shadow = useTransform(scrollY, [0, 60], [0, 1]);
  return (
    <motion.header className="fixed inset-x-0 top-0 z-50">
      <motion.div aria-hidden className="absolute inset-0 border-b border-ink/10 bg-ivory/92 backdrop-blur-xl" style={{ opacity: shadow }} />
      <div className="relative mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="#top" className="flex items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <span className="text-sm font-semibold tracking-tightish text-ink">{ABA.brand}</span>
        </a>
        <a
          href="#intake"
          onClick={() => trackEvent("cta_click")}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-green px-4 text-[13px] font-semibold text-ivory transition-colors hover:bg-green-hover"
        >
          Book a discovery call <ArrowRight size={14} />
        </a>
      </div>
    </motion.header>
  );
}

export function AbaFooter() {
  return (
    <footer className="border-t border-ink/10 bg-ivory">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-10 text-sm text-ink/60 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <Logo className="h-6 w-6" />
          <div>
            <p className="font-semibold text-ink">{ABA.brand}</p>
            <p className="text-xs">{ABA.tagline}</p>
          </div>
        </div>
        <p className="text-xs">
          © {new Date().getFullYear()} {ABA.legalName} ·{" "}
          <a href={`mailto:${ABA.supportEmail}`} className="underline-offset-2 hover:underline">
            {ABA.supportEmail}
          </a>
          {" · "}
          We work only with independently owned ABA practices. Not affiliated with any payer or PE group.
        </p>
      </div>
    </footer>
  );
}
