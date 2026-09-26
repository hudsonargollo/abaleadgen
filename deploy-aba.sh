#!/usr/bin/env bash
# One-shot deploy of the ABA lead-gen stack to abaclinics.clubemkt.digital.
#
#   ./deploy-aba.sh            # build + deploy hub worker, crm worker, marketing site
#   ./deploy-aba.sh secrets    # interactive: set the worker secrets (run once)
#   ./deploy-aba.sh hub|crm|site
#
# Prerequisites (run once on this machine):
#   npx wrangler login                       # ClubeMKT account (cb27e1a6…)
#   ./deploy-aba.sh secrets
#
# Cloud resources are already provisioned on the account:
#   D1  abaclinics-db      e4cc77ba-2e27-460f-bfd3-8b52a4eba0af  (migrations 0001–0029 applied, admin user seeded)
#   KV  abaclinics-KANBAN  2cedebe19b13415699b6eacfea0c1fd2
#   DO/R2 shared with goldplanner-realtime / goldplanner-boards-sync / goldplanner-boards-data
set -euo pipefail
cd "$(dirname "$0")"

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-cb27e1a67198789eb42d11ab90737652}"
HOST="abaclinics.clubemkt.digital"
PAGES_PROJECT="abaclinics"

step() { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }

build_hub_bundle() {
  step "Building Hub (vite) + Pages Functions bundle"
  npm run build
  npx wrangler pages functions build --outdir=./dist/_worker.js/
  # keep the compiled functions bundle out of the static-asset upload
  printf '_worker.js\n' > dist/.assetsignore
}

deploy_hub() {
  step "Deploying abaclinics-hub  →  https://$HOST/hub"
  npx wrangler deploy --config wrangler.worker.toml
}

deploy_crm() {
  step "Deploying abaclinics-crm  →  https://$HOST/crm/api/*"
  npx wrangler deploy --config wrangler.crm.toml
}

deploy_site() {
  step "Building + deploying marketing site (Next.js on Pages project '$PAGES_PROJECT')"
  ( cd marketing
    [ -d node_modules ] || npm ci --legacy-peer-deps
    # NEXT_PUBLIC_BOOKING_URL=https://cal.com/<you>/discovery  (or Calendly) — baked in at build time
    npx @cloudflare/next-on-pages
    npx wrangler pages deploy .vercel/output/static --project-name="$PAGES_PROJECT" --commit-dirty=true --branch=main
  )
  cat <<EOF

  If this was the first Pages deploy, attach the custom domain once in the dashboard:
    Workers & Pages → $PAGES_PROJECT → Custom domains → Add → $HOST
  (Cloudflare creates the DNS record; the /hub, /task and /crm Workers Routes
   then resolve on the same hostname.)
EOF
}

set_secrets() {
  step "Secrets — the same SESSION_SECRET must go to BOTH workers"
  echo "Generate one with:  openssl rand -base64 48"
  for cfg in wrangler.worker.toml wrangler.crm.toml; do
    echo; echo "--- $cfg: SESSION_SECRET"
    npx wrangler secret put SESSION_SECRET --config "$cfg"
  done
  echo; echo "--- wrangler.crm.toml: FORM_WEBHOOK_TOKEN (bearer for generic/Zapier booking webhooks; openssl rand -hex 32)"
  npx wrangler secret put FORM_WEBHOOK_TOKEN --config wrangler.crm.toml
  echo; echo "--- wrangler.crm.toml: CAL_WEBHOOK_SECRET (leave empty + Ctrl-C to skip if you use Calendly)"
  npx wrangler secret put CAL_WEBHOOK_SECRET --config wrangler.crm.toml || true
  echo; echo "--- wrangler.crm.toml: CALENDLY_WEBHOOK_SIGNING_KEY (Ctrl-C to skip if you use Cal.com)"
  npx wrangler secret put CALENDLY_WEBHOOK_SIGNING_KEY --config wrangler.crm.toml || true
  echo; echo "Webhook URL to register with Cal.com / Calendly:  https://$HOST/crm/api/webhooks/booking"
}

case "${1:-all}" in
  secrets) set_secrets ;;
  hub)     build_hub_bundle; deploy_hub ;;
  crm)     build_hub_bundle; deploy_crm ;;
  site)    deploy_site ;;
  all)
    build_hub_bundle
    deploy_hub
    deploy_crm
    deploy_site
    step "Done"
    echo "Hub / CRM:   https://$HOST/hub   (first sign-in with hudson@tektone.com.br sets your password)"
    echo "Landing:     https://$HOST/aba?lid=<leadId>&utm_source=cold_email"
    echo "Import CLI:  npm run import:leads -- --commit --api https://$HOST --token <session token> <file.csv>"
    ;;
  *) echo "usage: $0 [all|hub|crm|site|secrets]"; exit 2 ;;
esac
