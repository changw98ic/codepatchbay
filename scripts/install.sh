#!/bin/sh
set -eu

PACKAGE="${CPB_NPM_PACKAGE:-codepatchbay}"
NODE="${NODE_BIN:-node}"
NPM="${NPM_BIN:-npm}"
GIT="${GIT_BIN:-git}"
GH="${GH_BIN:-gh}"
CPB="${CPB_BIN:-cpb}"
SETUP_MODE="${CPB_SETUP_MODE:-recommended}"
SKIP_SETUP=0
DRY_RUN=0
GH_AUTH_LOGIN="${CPB_GH_AUTH_LOGIN:-0}"

usage() {
  printf '%s\n' \
    "Usage: sh scripts/install.sh [options]" \
    "" \
    "Install CodePatchBay, prerequisites, and run setup." \
    "" \
    "Options:" \
    "  --recommended       Run: cpb setup --recommended (default)" \
    "  --interactive       Run: cpb setup --interactive" \
    "  --setup-json        Run: cpb setup --json" \
    "  --skip-setup        Install CodePatchBay only" \
    "  --package NAME      npm package to install (default: codepatchbay)" \
    "  --gh-auth-login     Run: gh auth login when gh is not authenticated" \
    "  --dry-run           Print commands without running them" \
    "  -h, --help          Show this help" \
    "" \
    "Environment:" \
    "  CPB_NPM_PACKAGE     npm package name override" \
    "  NODE_BIN            node binary override" \
    "  NPM_BIN             npm binary override" \
    "  GIT_BIN             git binary override" \
    "  GH_BIN              gh binary override" \
    "  CPB_BIN             cpb binary override" \
    "  CPB_SETUP_MODE      recommended|interactive|json" \
    "  CPB_GH_AUTH_LOGIN   1 to run gh auth login without prompting"
}

print_cmd() {
  printf '+'
  for arg in "$@"; do
    printf ' %s' "$arg"
  done
  printf '\n'
}

run() {
  print_cmd "$@"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

is_available() {
  command -v "$1" >/dev/null 2>&1
}

detect_missing_prerequisites() {
  missing=""

  is_available "$NODE" || missing="$missing node"
  is_available "$NPM" || missing="$missing npm"
  is_available "$GIT" || missing="$missing git"
  is_available "$GH" || missing="$missing gh"

  printf '%s' "$missing"
}

detect_package_manager() {
  for manager in brew apt-get dnf yum pacman; do
    if is_available "$manager"; then
      printf '%s' "$manager"
      return 0
    fi
  done
  return 1
}

packages_for_manager() {
  manager="$1"
  missing=" $2 "
  packages=""

  case "$manager" in
    brew)
      case "$missing" in
        *" node "*|*" npm "*) packages="$packages node" ;;
      esac
      case "$missing" in
        *" git "*) packages="$packages git" ;;
      esac
      case "$missing" in
        *" gh "*) packages="$packages gh" ;;
      esac
      ;;
    apt-get|dnf|yum)
      case "$missing" in
        *" node "*|*" npm "*) packages="$packages nodejs npm" ;;
      esac
      case "$missing" in
        *" git "*) packages="$packages git" ;;
      esac
      case "$missing" in
        *" gh "*) packages="$packages gh" ;;
      esac
      ;;
    pacman)
      case "$missing" in
        *" node "*|*" npm "*) packages="$packages nodejs npm" ;;
      esac
      case "$missing" in
        *" git "*) packages="$packages git" ;;
      esac
      case "$missing" in
        *" gh "*) packages="$packages github-cli" ;;
      esac
      ;;
  esac

  printf '%s' "${packages# }"
}

run_privileged() {
  if is_available sudo; then
    run sudo "$@"
  else
    run "$@"
  fi
}

install_prerequisites() {
  missing="$(detect_missing_prerequisites)"
  if [ -z "$missing" ]; then
    return 0
  fi

  echo "Missing prerequisites:${missing}"

  if ! manager="$(detect_package_manager)"; then
    echo "install.sh: could not find a supported package manager (brew, apt-get, dnf, yum, pacman)." >&2
    echo "install.sh: install node, npm, git, and gh, then rerun this script." >&2
    if [ "$DRY_RUN" -eq 1 ]; then
      return 0
    fi
    exit 127
  fi

  packages="$(packages_for_manager "$manager" "$missing")"
  if [ -z "$packages" ]; then
    return 0
  fi

  case "$manager" in
    brew)
      # shellcheck disable=SC2086
      run brew install $packages
      ;;
    apt-get)
      run_privileged apt-get update
      # shellcheck disable=SC2086
      run_privileged apt-get install -y $packages
      ;;
    dnf)
      # shellcheck disable=SC2086
      run_privileged dnf install -y $packages
      ;;
    yum)
      # shellcheck disable=SC2086
      run_privileged yum install -y $packages
      ;;
    pacman)
      # shellcheck disable=SC2086
      run_privileged pacman -Sy --needed --noconfirm $packages
      ;;
  esac
}

assert_prerequisites_available() {
  missing="$(detect_missing_prerequisites)"
  if [ -n "$missing" ]; then
    echo "install.sh: prerequisites still missing after install:${missing}" >&2
    exit 127
  fi
}

verify_gh_auth() {
  if [ "$DRY_RUN" -eq 1 ]; then
    run "$GH" auth status
    return 0
  fi

  print_cmd "$GH" auth status
  if "$GH" auth status >/dev/null 2>&1; then
    echo "GitHub CLI auth: ok"
    return 0
  fi

  echo "GitHub CLI is not authenticated."

  if [ "$GH_AUTH_LOGIN" = "1" ]; then
    run "$GH" auth login
    return 0
  fi

  if [ -t 0 ]; then
    printf '%s' "Run 'gh auth login' now? [y/N] "
    answer=""
    read answer || answer=""
    case "$answer" in
      y|Y|yes|YES)
        run "$GH" auth login
        return 0
        ;;
    esac
  fi

  echo "Run this to connect GitHub before webhook and PR automation:"
  echo "  gh auth login"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --recommended)
      SETUP_MODE="recommended"
      ;;
    --interactive)
      SETUP_MODE="interactive"
      ;;
    --setup-json)
      SETUP_MODE="json"
      ;;
    --skip-setup)
      SKIP_SETUP=1
      ;;
    --package)
      if [ "$#" -lt 2 ]; then
        echo "install.sh: --package requires a value" >&2
        exit 2
      fi
      PACKAGE="$2"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --gh-auth-login)
      GH_AUTH_LOGIN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "install.sh: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

install_prerequisites
if [ "$DRY_RUN" -eq 0 ]; then
  assert_prerequisites_available
fi

run "$NPM" install -g "$PACKAGE"

verify_gh_auth

if [ "$SKIP_SETUP" -eq 1 ]; then
  exit 0
fi

if [ "$DRY_RUN" -eq 0 ]; then
  is_available "$CPB" || {
    echo "install.sh: cpb not found after install: $CPB" >&2
    exit 127
  }
fi

case "$SETUP_MODE" in
  recommended)
    run "$CPB" setup --recommended
    ;;
  interactive)
    run "$CPB" setup --interactive
    ;;
  json)
    run "$CPB" setup --json
    ;;
  *)
    echo "install.sh: invalid CPB_SETUP_MODE: $SETUP_MODE" >&2
    exit 2
    ;;
esac
