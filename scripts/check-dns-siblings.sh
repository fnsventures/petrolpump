#!/usr/bin/env bash
# Canonical DNS sibling check for F&S Ventures GitHub Pages hosts.
# (fns-cashline/scripts/check-dns-siblings.sh wraps this file from main.)
#
# Usage:
#   ./scripts/check-dns-siblings.sh           # check only
#   ./scripts/check-dns-siblings.sh --fix     # restore missing/wrong CNAMEs via GoDaddy, then recheck
#
# Auto-fix needs:
#   GODADDY_API_KEY
#   GODADDY_API_SECRET
# Create at https://developer.godaddy.com/keys (Production, for domain fnsventures.in).
#
# GitHub Actions: writes fixed_count / check_failed to GITHUB_OUTPUT and a job summary.
set -euo pipefail

DNS_ZONE="fnsventures.in"
EXPECTED_TARGET="fnsventures.github.io"
EXPECTED_CNAME="${EXPECTED_TARGET}."
TTL=600

# Negative-cache / registrar publish can take several minutes after a restore.
DNS_WAIT_ATTEMPTS="${DNS_WAIT_ATTEMPTS:-24}"
DNS_WAIT_SECONDS="${DNS_WAIT_SECONDS:-30}"

# Fully-qualified host → must CNAME to EXPECTED_CNAME
SITES=(
  "bishnupriyafuels.fnsventures.in"
  "fnscashline.fnsventures.in"
)

DO_FIX=0
for arg in "$@"; do
  case "$arg" in
    --fix) DO_FIX=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg (use --fix)" >&2
      exit 2
      ;;
  esac
done

fail=0
fixed=0

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 2
  fi
}

need_cmd dig
need_cmd curl

normalize_cname() {
  local v="$1"
  v="${v%%$'\n'*}"
  v="${v%"${v##*[![:space:]]}"}"
  [[ -n "$v" && "$v" != *. ]] && v="${v}."
  printf '%s' "$v"
}

host_label() {
  local host="$1"
  local suffix=".${DNS_ZONE}"
  if [[ "$host" != *"$suffix" ]]; then
    echo "error: host ${host} is not under ${DNS_ZONE}" >&2
    return 1
  fi
  printf '%s' "${host%"$suffix"}"
}

current_cname() {
  local host="$1"
  local got
  got="$(dig +short CNAME "$host" 2>/dev/null | head -n1 || true)"
  normalize_cname "$got"
}

dns_ok() {
  local host="$1"
  local got
  got="$(current_cname "$host")"
  [[ -n "$got" && "$got" == "$EXPECTED_CNAME" ]]
}

check_cname() {
  local host="$1"
  local got
  got="$(current_cname "$host")"

  if [[ -z "$got" ]]; then
    echo "FAIL  DNS  ${host}  (no CNAME — NXDOMAIN or missing record)"
    fail=1
    return 1
  fi
  if [[ "$got" != "$EXPECTED_CNAME" ]]; then
    echo "FAIL  DNS  ${host}  got=${got} want=${EXPECTED_CNAME}"
    fail=1
    return 1
  fi
  echo "OK    DNS  ${host} → ${got}"
  return 0
}

check_env_js() {
  local host="$1"
  local url="https://${host}/js/env.js"
  local body
  local code

  body="$(mktemp)"
  code="$(curl -sS -L --max-time 20 -o "$body" -w '%{http_code}' "$url" || echo "000")"

  if [[ "$code" != "200" ]]; then
    echo "FAIL  env  ${url}  HTTP ${code}"
    rm -f "$body"
    fail=1
    return 1
  fi

  if ! grep -q 'SUPABASE_URL' "$body"; then
    echo "FAIL  env  ${url}  missing SUPABASE_URL"
    rm -f "$body"
    fail=1
    return 1
  fi
  if grep -q 'YOUR-PROJECT-ID' "$body"; then
    echo "FAIL  env  ${url}  still has placeholder YOUR-PROJECT-ID"
    rm -f "$body"
    fail=1
    return 1
  fi
  if ! grep -Eq 'SUPABASE_ANON_KEY[[:space:]]*:[[:space:]]*"[^"]{20,}"' "$body"; then
    echo "FAIL  env  ${url}  SUPABASE_ANON_KEY missing or too short"
    rm -f "$body"
    fail=1
    return 1
  fi

  echo "OK    env  ${url}"
  rm -f "$body"
  return 0
}

run_checks() {
  fail=0
  echo "Checking sibling GitHub Pages DNS + /js/env.js"
  echo

  for host in "${SITES[@]}"; do
    check_cname "$host" || true
    check_env_js "$host" || true
    echo
  done
}

have_godaddy_creds() {
  [[ -n "${GODADDY_API_KEY:-}" && -n "${GODADDY_API_SECRET:-}" ]]
}

restore_cname() {
  local host="$1"
  local label
  label="$(host_label "$host")"

  local url="https://api.godaddy.com/v1/domains/${DNS_ZONE}/records/CNAME/${label}"
  local body
  body="$(printf '[{"data":"%s","ttl":%s}]' "$EXPECTED_TARGET" "$TTL")"
  local tmp
  tmp="$(mktemp)"
  local code

  echo "FIX   DNS  PUT CNAME ${label}.${DNS_ZONE} → ${EXPECTED_TARGET}"
  code="$(
    curl -sS -o "$tmp" -w '%{http_code}' -X PUT "$url" \
      -H "Authorization: sso-key ${GODADDY_API_KEY}:${GODADDY_API_SECRET}" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json" \
      --data "$body" || echo "000"
  )"

  if [[ "$code" != "200" && "$code" != "204" ]]; then
    echo "FAIL  DNS  GoDaddy API HTTP ${code} for ${label}"
    sed 's/./&/g' "$tmp" | head -c 400
    echo
    rm -f "$tmp"
    return 1
  fi

  rm -f "$tmp"
  echo "OK    DNS  GoDaddy accepted restore for ${label}"
  fixed=$((fixed + 1))
  return 0
}

fix_dns() {
  local host
  local any=0

  echo "Attempting GoDaddy auto-fix for missing/wrong CNAMEs…"
  echo

  if ! have_godaddy_creds; then
    echo "FAIL  fix  GODADDY_API_KEY / GODADDY_API_SECRET not set."
    echo "      Add them as GitHub Actions secrets on petrolpump (scheduled job), or export locally."
    echo "      Keys: https://developer.godaddy.com/keys"
    return 1
  fi

  for host in "${SITES[@]}"; do
    if dns_ok "$host"; then
      continue
    fi
    any=1
    restore_cname "$host" || true
  done

  if [[ "$any" -eq 0 ]]; then
    echo "No DNS records needed restore (env.js may still be failing — that needs a redeploy, not DNS)."
    return 0
  fi

  local max_wait=$((DNS_WAIT_ATTEMPTS * DNS_WAIT_SECONDS))
  echo
  echo "Waiting for DNS to publish (up to ~$((max_wait / 60)) minutes; negative cache can linger)…"
  local attempt
  local pending
  for attempt in $(seq 1 "$DNS_WAIT_ATTEMPTS"); do
    pending=0
    for host in "${SITES[@]}"; do
      if ! dns_ok "$host"; then
        pending=1
      fi
    done
    if [[ "$pending" -eq 0 ]]; then
      echo "OK    DNS  all sibling CNAMEs visible (attempt ${attempt}/${DNS_WAIT_ATTEMPTS})"
      return 0
    fi
    sleep "$DNS_WAIT_SECONDS"
  done

  echo "WARN  DNS  still not fully visible after ~${max_wait}s — recheck may fail until TTL/negative cache expires"
  return 0
}

write_ci_outputs() {
  local check_failed="$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    {
      echo "fixed_count=${fixed}"
      echo "check_failed=${check_failed}"
    } >> "$GITHUB_OUTPUT"
  fi

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    local mode="check-only"
    [[ "$DO_FIX" -eq 1 ]] && mode="fix"
    {
      echo "## DNS sibling check"
      echo
      echo "| Metric | Value |"
      echo "|--------|-------|"
      echo "| Fixed CNAMEs | ${fixed} |"
      echo "| Check failed | ${check_failed} |"
      echo "| Mode | ${mode} |"
      echo
      if [[ "$fixed" -gt 0 ]]; then
        echo "### Auto-fix applied"
        echo
        echo "Restored **${fixed}** sibling CNAME record(s) to \`${EXPECTED_TARGET}\`."
        echo
        echo "Hosts:"
        for host in "${SITES[@]}"; do
          echo "- \`${host}\`"
        done
      fi
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  if [[ "$fixed" -gt 0 ]]; then
    echo "::notice title=DNS auto-fix::Restored ${fixed} sibling CNAME record(s) to ${EXPECTED_TARGET}"
  fi
}

echo "Rule: add new CNAMEs; never edit/remove sibling rows for other apps."
echo "Zone: ${DNS_ZONE} → ${EXPECTED_TARGET}"
echo

run_checks

if [[ "$fail" -eq 0 ]]; then
  echo "All sibling sites OK."
  write_ci_outputs 0
  exit 0
fi

if [[ "$DO_FIX" -ne 1 ]]; then
  echo "DNS sibling check failed."
  echo "Re-run with --fix to restore CNAMEs via GoDaddy (needs API secrets),"
  echo "or fix manually at the registrar. See docs/OPERATIONS.md § DNS safety net."
  write_ci_outputs 1
  exit 1
fi

echo "────────────────────────────────────────"
fix_dns || true
echo "────────────────────────────────────────"
echo "Re-checking after fix attempt…"
echo
run_checks

if [[ "$fail" -ne 0 ]]; then
  echo "Still failing after auto-fix (fixed_records=${fixed})."
  echo "If DNS is OK but env.js fails: redeploy that app (Actions → Deploy → prod)."
  echo "If DNS still fails: confirm GoDaddy API key can edit ${DNS_ZONE}, nameservers are GoDaddy,"
  echo "and wait for negative-cache TTL, then re-run."
  write_ci_outputs 1
  exit 1
fi

if [[ "$fixed" -gt 0 ]]; then
  echo "All sibling sites OK after auto-fix (restored ${fixed} CNAME record(s))."
else
  echo "All sibling sites OK."
fi
write_ci_outputs 0
