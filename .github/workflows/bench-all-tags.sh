#!/usr/bin/env bash
set -euo pipefail

BENCHS="${BENCHS:-small,medium,large,wide}"
RUNS_FAST="${RUNS_FAST:-3}" # historical tags
RUNS_SLOW="${RUNS_SLOW:-10}" # newest tag(s)
WARMUP="${WARMUP:-1}"
TAGS_MODE="${TAGS_MODE:-all}" # all | last:N
BASELINE_TAGS="${BASELINE_TAGS:-1}" # how many newest tags get slow runs

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

# Collect tags
mapfile -t TAGS < <(git tag --list '*' --sort=version:refname)
if [[ "$TAGS_MODE" =~ ^last:([0-9]+)$ ]]; then
  N="${BASH_REMATCH[1]}"
  TAGS=("${TAGS[@]: -$N}")
fi

# Figure out which tags get the "slow" treatment (newest ones)
TOTAL="${#TAGS[@]}"
SLOW_FROM=$(( TOTAL - BASELINE_TAGS ))
if (( SLOW_FROM < 0 )); then SLOW_FROM=0; fi

echo "Benchmarking ${#TAGS[@]} tags : ${TAGS[*]}"
echo "Fast runs : $RUNS_FAST | Slow runs (newest $BASELINE_TAGS) : $RUNS_SLOW"

i=0
for tag in "${TAGS[@]}"; do
  echo ""
  echo "=== TAG $tag ==="

  # Make a worktree per tag
  WT="$ROOT/.worktrees/$tag"
  rm -rf "$WT"
  mkdir -p "$ROOT/.worktrees"
  git worktree add -f "$WT" "$tag" >/dev/null

  pushd "$WT" >/dev/null

  # Reuse pnpm store (best effort; still respects each tag's lockfile)
  pnpm i --frozen-lockfile

  pnpm build

  # Determine JS entry name
  if [[ -f dist/monorepo-hash.js ]]; then
    JS_NAME="monorepo-hash.js"
  else
    JS_NAME="monorepo-hash.mjs"
  fi

  # Determine pm_arg
  if grep -q '(-pm)' src/monorepo-hash.ts; then
    PM_ARG='-pm=pnpm'
  else
    PM_ARG=''
  fi

  # Bun build only if supported in that tag
  BUILD_BUN=false
  if grep -q '"build:bun"' package.json; then
    BUILD_BUN=true
    pnpm build:bun:linux-x64
    chmod +x bun-build/monorepo-hash-linux-x64
  fi

  # Runs count
  RUNS="$RUNS_FAST"
  if (( i >= SLOW_FROM )); then RUNS="$RUNS_SLOW"; fi

  popd >/dev/null

  # Run benchmarks against the same unpacked demo repos
  for b in "${BENCH_ARR[@]}"; do
    b="$(echo "$b" | xargs)"
    DEMO="$ROOT/tests/demo/${b}-monorepo"

    # node
    mkdir -p "$RESULTS_DIR/node/$tag"
    hyperfine \
      --prepare 'sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null' \
      --warmup "$WARMUP" \
      --runs "$RUNS" \
      --export-json "$RESULTS_DIR/node/$tag/${b}-cold.json" \
      "node $WT/dist/$JS_NAME --generate $PM_ARG -s" \
      --workdir "$DEMO"
    hyperfine \
      --warmup "$WARMUP" \
      --runs "$RUNS" \
      --export-json "$RESULTS_DIR/node/$tag/${b}-warm.json" \
      "node $WT/dist/$JS_NAME --generate $PM_ARG -s" \
      --workdir "$DEMO"

    # bun (if that tag supports it)
    if [[ "$BUILD_BUN" == "true" ]]; then
      mkdir -p "$RESULTS_DIR/bun/$tag"
      hyperfine \
        --prepare 'sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null' \
        --warmup "$WARMUP" \
        --runs "$RUNS" \
        --export-json "$RESULTS_DIR/bun/$tag/${b}-cold.json" \
        "$WT/bun-build/monorepo-hash-linux-x64 --generate $PM_ARG -s" \
        --workdir "$DEMO"
      hyperfine \
        --warmup "$WARMUP" \
        --runs "$RUNS" \
        --export-json "$RESULTS_DIR/bun/$tag/${b}-warm.json" \
        "$WT/bun-build/monorepo-hash-linux-x64 --generate $PM_ARG -s" \
        --workdir "$DEMO"
    fi
  done

  # cleanup worktree (avoid filling disk)
  git worktree remove -f "$WT" >/dev/null || true
  i=$((i+1))
done

echo "Done, results in $RESULTS_DIR"
