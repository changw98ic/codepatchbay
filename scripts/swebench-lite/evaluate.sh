#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/swebench-lite/evaluate.sh --run-dir <dir> [options]

Run the official SWE-bench harness against all_preds.jsonl.

Options:
  --run-dir <dir>          Run directory containing all_preds.jsonl (required)
  --dataset-name <name>    Dataset name (default: SWE-bench/SWE-bench_Lite)
  --split <name>           Dataset split (default: test)
  --run-id <id>            Harness run id (default: manifest/run directory name)
  --max-workers <n>        Harness worker count (default: 8)
  --cache-level <level>    Harness cache level (default: env)
  --timeout <seconds>      Per-instance timeout (default: 1800)
  --local                  Use local Python instead of Docker
  --python <path>          Local Python executable (default: python3)
  --help                   Show this help
USAGE
}

RUN_DIR=""
DATASET_NAME="SWE-bench/SWE-bench_Lite"
SPLIT="test"
RUN_ID=""
MAX_WORKERS="8"
CACHE_LEVEL="env"
TIMEOUT="1800"
USE_DOCKER="1"
PYTHON_BIN="python3"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-dir) RUN_DIR="$2"; shift 2 ;;
    --dataset-name) DATASET_NAME="$2"; shift 2 ;;
    --split) SPLIT="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    --max-workers) MAX_WORKERS="$2"; shift 2 ;;
    --cache-level) CACHE_LEVEL="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --local) USE_DOCKER="0"; shift ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -z "$RUN_DIR" ]]; then
  echo "--run-dir is required" >&2
  usage >&2
  exit 1
fi

RUN_DIR="$(cd "$RUN_DIR" && pwd)"
PREDICTIONS_PATH="$RUN_DIR/all_preds.jsonl"
if [[ ! -f "$PREDICTIONS_PATH" ]]; then
  echo "Missing predictions file: $PREDICTIONS_PATH" >&2
  exit 1
fi

if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(basename "$RUN_DIR")"
fi

if [[ "$USE_DOCKER" == "1" ]]; then
  DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
  if [[ ! -S "$DOCKER_SOCK" && -S "$HOME/.docker/run/docker.sock" ]]; then
    DOCKER_SOCK="$HOME/.docker/run/docker.sock"
  fi
  docker run --rm \
    -v "$DOCKER_SOCK:/var/run/docker.sock" \
    -v "$RUN_DIR:/work" \
    -w /work \
    python:3.12-slim \
    bash -lc "python -m pip install --upgrade pip >/tmp/swebench-pip-upgrade.log && pip install swebench && python -m swebench.harness.run_evaluation --dataset_name '$DATASET_NAME' --split '$SPLIT' --predictions_path /work/all_preds.jsonl --max_workers '$MAX_WORKERS' --run_id '$RUN_ID' --cache_level '$CACHE_LEVEL' --clean false --timeout '$TIMEOUT' --report_dir /work"
else
  "$PYTHON_BIN" -m swebench.harness.run_evaluation \
    --dataset_name "$DATASET_NAME" \
    --split "$SPLIT" \
    --predictions_path "$PREDICTIONS_PATH" \
    --max_workers "$MAX_WORKERS" \
    --run_id "$RUN_ID" \
    --cache_level "$CACHE_LEVEL" \
    --clean false \
    --timeout "$TIMEOUT" \
    --report_dir "$RUN_DIR"
fi
