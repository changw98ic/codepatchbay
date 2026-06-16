#!/usr/bin/env bash
# common.sh - Shared shell functions for phase bridge scripts

# rtk_verifier_job - Generate verifier prompt for job-id based verification
# Usage: rtk_verifier_job <project> <job-id> <verdict-file>
rtk_verifier_job() {
  local project="$1"
  local job_id="$2"
  local verdict_file="$3"

  cat <<PROMPT
You are CodePatchbay Verifier performing job-based verification.

## Verification Context
- Project: ${project}
- Job ID: ${job_id}
- Verdict output: ${verdict_file}

## Key Principle
Executor deliverables are optional audit context. The verifier should reconstruct the task
goal from the job event log and current project state, not depend on a specific deliverable file.
If data is missing, return a diagnostic verdict instead of crashing.

## Instructions
1. Inspect the job event log and current project state.
2. MANDATORY: Run \`node --check\` on every relevant compiled .js file.
3. MANDATORY: If a package.json with a "test" script exists, run \`npm test\`.
4. Write the verdict to: ${verdict_file}
PROMPT
}

# rtk_verifier - Generate verifier prompt for deliverable-based verification
# Usage: rtk_verifier <project> <deliverable-id> <verdict-file>
rtk_verifier() {
  local project="$1"
  local deliverable_id="$2"
  local verdict_file="$3"

  echo "Verifying deliverable-${deliverable_id} for project ${project}."
  echo "Write the verdict to: ${verdict_file}"
}
