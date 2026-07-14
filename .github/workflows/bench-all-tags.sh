#!/usr/bin/env bash
set -euo pipefail

BENCHS="${BENCHS:-small,medium,large,wide}"
RUNS_FAST="${RUNS_FAST:-3}" # historical tags
RUNS_SLOW="${RUNS_SLOW:-10}" # newest tag(s)
WARMUP="${WARMUP:-2}"
TAGS_MODE="${TAGS_MODE:-all}" # all | last:N
SKIP_UNSTABLE="${SKIP_UNSTABLE:-false}" # true => only x.y.z tags when auto-selecting tags
BENCH_THIS="${BENCH_THIS:-}" # explicit comma-separated refs to benchmark, overrides tag selection
BASELINE_TAGS="${BASELINE_TAGS:-1}" # how many newest tags get slow runs
INCLUDE_REF="${INCLUDE_REF:-true}" # include the currently checked-out ref (HEAD) as well

# Label for the current ref (branch name in Actions, or "HEAD" locally)
REF_LABEL="${REF_LABEL:-${GITHUB_REF_NAME:-HEAD}}"
REF_COMMIT="$(git rev-parse HEAD)"

sanitize_label() {
  # safe for directory names
  local s="$1"
  s="${s//\//_}"
  s="${s// /_}"
  echo "$s"
}

is_stable_tag() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

ROOT="$(pwd)"
RESULTS_DIR="$ROOT/tests/benchmarks/history"
mkdir -p "$RESULTS_DIR"

# Unpack demo monorepos once
IFS=',' read -ra BENCH_ARR <<< "$BENCHS"
for b in "${BENCH_ARR[@]}"; do
  b="$(echo "$b" | xargs)"
  if [[ ! -d "$ROOT/tests/demo/${b}-monorepo" ]]; then
    7z x "$ROOT/tests/demo/${b}-monorepo.7z" -o"$ROOT/tests/demo"
  fi
done

# Build the list of refs to benchmark :
#   ref:<label>:<commit-ish>
REFS=()
if [[ -n "$BENCH_THIS" ]]; then
  IFS=',' read -ra REQUESTED_REFS <<< "$BENCH_THIS"
  for requested in "${REQUESTED_REFS[@]}"; do
    requested="$(echo "$requested" | xargs)"
    if [[ -n "$requested" ]]; then
      REFS+=("ref:${requested}:${requested}")
    fi
  done
else
  # Collect tags as commit-ish
  mapfile -t TAGS < <(git tag --list --sort=version:refname)

  if [[ "$SKIP_UNSTABLE" == "true" ]]; then
    FILTERED_TAGS=()
    for t in "${TAGS[@]}"; do
      if is_stable_tag "$t"; then
        FILTERED_TAGS+=("$t")
      fi
    done
    TAGS=("${FILTERED_TAGS[@]}")
  fi

  if [[ "$TAGS_MODE" =~ ^last:([0-9]+)$ ]]; then
    N="${BASH_REMATCH[1]}"
    TAGS=("${TAGS[@]: -$N}")
  fi

  for t in "${TAGS[@]}"; do
    REFS+=("tag:${t}:${t}")
  done
  if [[ "$INCLUDE_REF" == "true" ]]; then
    REFS+=("ref:${REF_LABEL}:${REF_COMMIT}")
  fi
fi

# Figure out which refs (tags + optional REF_LABEL) get the "slow" treatment (last N entries)
TOTAL="${#REFS[@]}"
if (( BASELINE_TAGS < 0 )); then
  # Special case : -1 (or any negative) means "treat all as slow"
  SLOW_FROM=0
else
  SLOW_FROM=$(( TOTAL - BASELINE_TAGS ))
  if (( SLOW_FROM < 0 )); then SLOW_FROM=0; fi
fi

echo ""
echo "ℹ️  Benchmarking ${#REFS[@]} refs (ref + tags) :"
printf ' - %s\n' "${REFS[@]}"
echo ""
echo "Fast runs : $RUNS_FAST | Slow runs (newest : $BASELINE_TAGS) : $RUNS_SLOW"

i=0
for spec in "${REFS[@]}"; do
  kind="${spec%%:*}"
  rest="${spec#*:}"
  label="${rest%%:*}"
  commitish="${rest#*:}"
  safe_label="$(sanitize_label "$label")"

  echo ""
  echo "=== 🔰 ${kind^^} $label ($commitish) 🔰 ==="

  # Make a worktree per tag
  WT="$ROOT/.worktrees/$safe_label"
  rm -rf "$WT"
  mkdir -p "$ROOT/.worktrees"
  # Use detached worktrees so tags/SHAs/branches all behave consistently
  git worktree add -f --detach "$WT" "$commitish" >/dev/null

  pushd "$WT" >/dev/null

  # Reuse PNPM store (best effort, still respects each tag's lockfile)
  pnpm i --frozen-lockfile --reporter=silent

  if grep -q '"build:node"' package.json; then
    pnpm build:node
  else
    pnpm build
  fi

  # Determine JS entry name
  if [[ -f dist/monorepo-hash.js ]]; then
    JS_NAME="monorepo-hash.js"
  else
    JS_NAME="monorepo-hash.mjs"
  fi

  # Determine pm_arg
  if grep -q '(-pm)' "dist/$JS_NAME"; then
    PM_ARG='-pm=pnpm'
  else
    PM_ARG=''
  fi

  # Go build only if supported in that tag
  BUILD_GO=false
  if grep -q '"build:go"' package.json; then
    BUILD_GO=true
    cd src/go && go mod download && cd ../..
    pnpm cli:build-bin -r go -p linux-x64
    chmod +x go-build/monorepo-hash-linux-x64
  fi

  # Rust build only if supported in that tag
  BUILD_RUST=false
  if grep -q '"build:rust"' package.json; then
    BUILD_RUST=true
    cd src/rust && cargo fetch --locked && cd ../..
    pnpm cli:build-bin -r rust -p linux-x64
    chmod +x rust-build/monorepo-hash-linux-x64
  fi

  # Runs count
  RUNS="$RUNS_FAST"
  if (( i >= SLOW_FROM )); then RUNS="$RUNS_SLOW"; fi

  popd >/dev/null

  # Run benchmarks against the same unpacked demo repos
  for b in "${BENCH_ARR[@]}"; do
    b="$(echo "$b" | xargs)"
    DEMO="$ROOT/tests/demo/${b}-monorepo"

    # Node
    mkdir -p "$RESULTS_DIR/node/$safe_label"
    cd "$DEMO"
    echo "  🚦 Node, $b, cold"
    sleep 2
    hyperfine \
      --prepare 'sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null' \
      --runs "$RUNS" \
      --export-json "$RESULTS_DIR/node/$safe_label/${b}-cold.json" \
      "node $WT/dist/$JS_NAME --generate $PM_ARG -s"
    echo "  🚦 Node, $b, warm"
    sleep 2
    hyperfine \
      --warmup "$WARMUP" \
      --runs "$RUNS" \
      --export-json "$RESULTS_DIR/node/$safe_label/${b}-warm.json" \
      "node $WT/dist/$JS_NAME --generate $PM_ARG -s"

    # Go (if that tag supports it)
    if [[ "$BUILD_GO" == "true" ]]; then
      mkdir -p "$RESULTS_DIR/go/$safe_label"
      echo "  🚦 Go, $b, cold"
      sleep 2
      hyperfine \
        --prepare 'sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null' \
        --runs "$RUNS" \
        --export-json "$RESULTS_DIR/go/$safe_label/${b}-cold.json" \
        "$WT/go-build/monorepo-hash-linux-x64 --generate $PM_ARG -s"
      echo "  🚦 Go, $b, warm"
      sleep 2
      hyperfine \
        --warmup "$WARMUP" \
        --runs "$RUNS" \
        --export-json "$RESULTS_DIR/go/$safe_label/${b}-warm.json" \
        "$WT/go-build/monorepo-hash-linux-x64 --generate $PM_ARG -s"
    fi

    # Rust (if that tag supports it)
    if [[ "$BUILD_RUST" == "true" ]]; then
      mkdir -p "$RESULTS_DIR/rust/$safe_label"
      echo "  🚦 Rust, $b, cold"
      sleep 2
      hyperfine \
        --prepare 'sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null' \
        --runs "$RUNS" \
        --export-json "$RESULTS_DIR/rust/$safe_label/${b}-cold.json" \
        "$WT/rust-build/monorepo-hash-linux-x64 --generate $PM_ARG -s"
      echo "  🚦 Rust, $b, warm"
      sleep 2
      hyperfine \
        --warmup "$WARMUP" \
        --runs "$RUNS" \
        --export-json "$RESULTS_DIR/rust/$safe_label/${b}-warm.json" \
        "$WT/rust-build/monorepo-hash-linux-x64 --generate $PM_ARG -s"
    fi
  done

  # cleanup worktree (avoid filling disk)
  git worktree remove -f "$WT" >/dev/null || true
  i=$((i+1))
done

echo "✅ Done, results in $RESULTS_DIR"
