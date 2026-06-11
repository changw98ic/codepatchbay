# SWE-bench Lite External Runner

These scripts run SWE-bench Lite against CPB without adding benchmark-specific
commands to CPB itself. CPB is treated as a black-box CLI:

- `cpb init` registers a temporary benchmark repository.
- `cpb run` enqueues the issue text.
- `cpb review-bundle --json` exports the public diff and artifacts.
- The official SWE-bench harness scores `all_preds.jsonl`.

Gold patches and test patches are not passed to CPB during inference.

## 1. Enqueue Instances

Start with a smoke run:

```bash
node scripts/swebench-lite/run.js \
  --run-dir /tmp/cpb-swe-lite-runs/smoke \
  --instance-ids psf__requests-1963 \
  --agent codex \
  --start-hub
```

For the full Lite split, omit `--instance-ids` and `--limit`:

```bash
node scripts/swebench-lite/run.js \
  --run-dir /data/cpb-swe-lite-runs/20260606-cpb-codex \
  --run-id 20260606-cpb-codex \
  --agent codex \
  --workflow standard \
  --plan-mode light \
  --start-hub
```

The runner writes `manifest.json` as it goes. Each manifest entry records the
SWE-bench instance id, CPB project id, queue id, job id, and repo checkout path.

## 2. Collect Predictions

After CPB workers finish, collect review bundles and create predictions:

```bash
node scripts/swebench-lite/collect.js \
  --run-dir /data/cpb-swe-lite-runs/20260606-cpb-codex \
  --model-name cpb-codex-20260606 \
  --wait
```

Outputs:

- `all_preds.jsonl`: official prediction file
- `bundles/*.json`: CPB review bundles
- `patches/*.patch`: per-instance generated patches
- `trajs/*.md`: public execution traces derived from review bundles
- `collection-summary.json`: status counts

Use `--allow-partial` to write predictions before every job reaches a terminal
state. Pending instances receive empty patches and will score unresolved.

## 3. Score with SWE-bench Harness

The default evaluator runs the official harness inside `python:3.12-slim` and
mounts Docker so the harness can create evaluation containers:

```bash
scripts/swebench-lite/evaluate.sh \
  --run-dir /data/cpb-swe-lite-runs/20260606-cpb-codex \
  --run-id cpb-codex-20260606 \
  --max-workers 8
```

On a Linux host with a working local harness, use `--local`:

```bash
scripts/swebench-lite/evaluate.sh \
  --run-dir /data/cpb-swe-lite-runs/20260606-cpb-codex \
  --run-id cpb-codex-20260606 \
  --max-workers 8 \
  --local \
  --python python3
```

The final score is:

```text
resolved_instances / 300
```

## 4. Package for Leaderboard PR

Fork and clone `SWE-bench/experiments`, then package the run:

```bash
node scripts/swebench-lite/pack.js \
  --run-dir /data/cpb-swe-lite-runs/20260606-cpb-codex \
  --experiments-dir /data/SWE-bench-experiments \
  --submission-name 20260606_cpb_codex \
  --model-name "CPB Codex"
```

Then run the experiments repository cleanup/result script:

```bash
cd /data/SWE-bench-experiments
python -m analysis.get_results evaluation/lite/20260606-cpb-codex
```

Open a pull request to `SWE-bench/experiments` with the generated
`evaluation/lite/<submission>` directory.

## Operational Notes

- Use a Linux x86_64 machine for the full run when possible. Arm64 Docker
  support works for some cases but is experimental upstream.
- Keep at least 120GB of free Docker storage for official evaluation.
- CPB project ids include the run id to avoid collisions across repeated runs.
- `cpb init` and CPB workers may create benchmark metadata in the temporary
  repository. The collector uses only review-bundle diffs and validates through
  the official harness, so benchmark patches remain external artifacts.
