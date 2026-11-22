#!/usr/bin/env bash
# One-time GitHub repository settings for the release pipeline. Needs repo admin:
#   gh auth login   (as an admin of the repo)
#   ./scripts/setup-github.sh            # show what would change
#   APPLY=yes ./scripts/setup-github.sh  # apply
#
# Safe to re-run: every call sets the full desired state.
#
#  1. main + staging: PRs only, the PR-check jobs must pass, code-owner review, no force push.
#  2. Environment prod-migrations: a required reviewer approves each production migration.
#  3. Environment prod: only workflows running on main can read prod secrets.
#  4. Secret scanning + push protection (blocks a push that contains a known key format).
#  5. Workflow GITHUB_TOKEN defaults to read-only; each workflow asks for what it needs.
#
# Options (env):
#   REPO=owner/name          default: fnsventures/petrolpump
#   REVIEWER=<login>         prod-migrations reviewer, default: privatefnsventures-maker
#   APPROVALS=1              required PR approvals. GitHub never lets you approve your own PR,
#                            so a solo maintainer who opens their own PRs needs APPROVALS=0.
#   ENFORCE_ADMINS=true      false lets admins push past the rules in an emergency.
set -euo pipefail

REPO="${REPO:-fnsventures/petrolpump}"
REVIEWER="${REVIEWER:-privatefnsventures-maker}"
APPROVALS="${APPROVALS:-1}"
ENFORCE_ADMINS="${ENFORCE_ADMINS:-true}"
APPLY="${APPLY:-}"

# Job names in .github/workflows/pr-checks.yml (the `name:` of each job). Keep in sync.
REQUIRED_CHECKS=(
  "Build site + JS syntax + doc links"
  "Migration names + order + function sources"
  "Secret scan"
  "Database (schema drift, pgTAP, types)"
)

command -v gh >/dev/null || { echo "gh CLI is required." >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required." >&2; exit 1; }

admin="$(gh api "repos/${REPO}" --jq '.permissions.admin')"
if [[ "${admin}" != "true" ]]; then
  echo "You are not an admin of ${REPO} ($(gh api user --jq .login)). Log in as an admin: gh auth login" >&2
  exit 1
fi

call() {
  local method="$1" path="$2" body="${3:-}"
  if [[ "${APPLY}" != "yes" ]]; then
    echo "would ${method} ${path}"
    [[ -n "${body}" ]] && jq . <<<"${body}" | sed 's/^/    /'
    return 0
  fi
  if [[ -n "${body}" ]]; then
    gh api -X "${method}" "${path}" --input - <<<"${body}" >/dev/null
  else
    gh api -X "${method}" "${path}" >/dev/null
  fi
  echo "ok ${method} ${path}"
}

checks_json="$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | jq -R . | jq -s 'map({context: .})')"

echo "==> 1. Branch protection (main, staging)"
for branch in main staging; do
  body="$(jq -n \
    --argjson checks "${checks_json}" \
    --argjson approvals "${APPROVALS}" \
    --argjson admins "${ENFORCE_ADMINS}" '{
      required_status_checks: { strict: false, checks: $checks },
      enforce_admins: $admins,
      required_pull_request_reviews: {
        required_approving_review_count: $approvals,
        require_code_owner_reviews: ($approvals > 0),
        dismiss_stale_reviews: true
      },
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      required_conversation_resolution: true
    }')"
  call PUT "repos/${REPO}/branches/${branch}/protection" "${body}"
done

echo "==> 2. Environment prod-migrations (required reviewer: ${REVIEWER})"
reviewer_id="$(gh api "users/${REVIEWER}" --jq .id)"
body="$(jq -n --argjson id "${reviewer_id}" '{
  reviewers: [{ type: "User", id: $id }],
  prevent_self_review: false,
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }
}')"
call PUT "repos/${REPO}/environments/prod-migrations" "${body}"

echo "==> 3. Environment prod: main only"
body='{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
call PUT "repos/${REPO}/environments/prod" "${body}"
existing="$(gh api "repos/${REPO}/environments/prod/deployment-branch-policies" --jq '.branch_policies[].name' 2>/dev/null || true)"
if ! grep -qx main <<<"${existing}"; then
  call POST "repos/${REPO}/environments/prod/deployment-branch-policies" '{"name":"main","type":"branch"}'
fi

echo "==> 4. Secret scanning + push protection"
call PATCH "repos/${REPO}" '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}'

echo "==> 5. Default workflow token: read-only"
call PUT "repos/${REPO}/actions/permissions/workflow" '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}'

if [[ "${APPLY}" != "yes" ]]; then
  echo
  echo "Dry run only. Apply with: APPLY=yes $0"
fi
