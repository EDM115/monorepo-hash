from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

try:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import to_hex, to_rgb
except ImportError as exc:
    raise SystemExit(
        "matplotlib is required to generate benchmark graphs "
        "Install it with `python -m pip install matplotlib`"
    ) from exc

RUNTIMES = ("node", "bun", "go", "rust")
SIZES = ("small", "medium", "large", "wide")
CACHES = ("cold", "warm")
BENCH_HISTORY_DIR = Path(__file__).resolve().parent / "bench-history"
GRAPHS_DIR = BENCH_HISTORY_DIR / "graphs"
ALL_RUNTIME_GROUP = "all"

RUNTIME_COLORS = {
    "node": "#339933",  # green
    "bun": "#F472B6",  # pink
    "go": "#00ADD8",  # cyan
    "rust": "#D34516",  # orange
}
CACHE_COLORS = {
    "cold": "#00A29C",  # aqua
    "warm": "#FDDD00",  # yellow
}
SIZE_COLORS = {
    "small": "#5DC9E2",  # blue
    "medium": "#66CC33",  # green
    "large": "#CE3262",  # fuchsia
    "wide": "#BD93F9",  # purple
}
RUNTIME_EMOJIS = {
    "node": "🌿",
    "bun": "🥟",
    "go": "🐹",
    "rust": "🦀",
    ALL_RUNTIME_GROUP: "🌈",
}


@dataclass(frozen=True)
class BenchPoint:
    version: str
    mean: float


SEMVER_PATTERN = re.compile(
    r"^(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)(?:-(?P<prerelease>[0-9A-Za-z.-]+))?$"
)


def prerelease_sort_key(value: str) -> tuple[object, ...]:
    parts = re.findall(r"\d+|[A-Za-z]+|[^A-Za-z\d]+", value)
    key: list[object] = []

    for part in parts:
        if part.isdigit():
            key.append((0, int(part)))
        elif part.isalpha():
            key.append((1, part.lower()))
        else:
            key.append((2, part))

    return tuple(key)


def version_sort_key(value: str) -> tuple[object, ...]:
    match = SEMVER_PATTERN.fullmatch(value)

    if match:
        prerelease = match.group("prerelease")

        return (
            0,
            int(match.group("major")),
            int(match.group("minor")),
            int(match.group("patch")),
            0 if prerelease is None else 1,
            () if prerelease is None else prerelease_sort_key(prerelease),
        )

    if value == "master":
        return (1, value)

    return (2, prerelease_sort_key(value))


def darken(color: str, factor: float = 0.72) -> str:
    red, green, blue = to_rgb(color)

    return to_hex((red * factor, green * factor, blue * factor))


def read_mean(json_path: Path) -> float | None:
    try:
        parsed = json.loads(json_path.read_text("utf8"))
    except (OSError, json.JSONDecodeError):
        return None

    results = parsed.get("results")
    if not isinstance(results, list) or not results:
        return None

    first = results[0]
    if not isinstance(first, dict):
        return None

    mean = first.get("mean")
    if not isinstance(mean, (int, float)):
        return None

    return float(mean)


def collect_runtime_history(runtime: str) -> dict[str, dict[str, list[BenchPoint]]]:
    runtime_dir = BENCH_HISTORY_DIR / runtime
    history: dict[str, dict[str, list[BenchPoint]]] = {
        size: {cache: [] for cache in CACHES} for size in SIZES
    }

    if not runtime_dir.exists() or not runtime_dir.is_dir():
        return history

    versions = sorted(
        (entry.name for entry in runtime_dir.iterdir() if entry.is_dir()),
        key=version_sort_key,
    )

    for version in versions:
        version_dir = runtime_dir / version
        for size in SIZES:
            for cache in CACHES:
                mean = read_mean(version_dir / f"{size}-{cache}.json")
                if mean is None:
                    continue
                history[size][cache].append(BenchPoint(version=version, mean=mean))

    return history


def ensure_graphs_dir() -> None:
    GRAPHS_DIR.mkdir(parents=True, exist_ok=True)


def ensure_graph_group_dir(group: str) -> Path:
    ensure_graphs_dir()
    group_dir = GRAPHS_DIR / group
    group_dir.mkdir(parents=True, exist_ok=True)
    return group_dir


def plot_series(
    *,
    title: str,
    output_path: Path,
    ylabel: str,
    ordered_versions: list[str],
    series: list[tuple[str, str, list[BenchPoint]]],
) -> bool:
    if not ordered_versions or not series:
        return False

    ensure_graphs_dir()
    fig, ax = plt.subplots(figsize=(12, 7), dpi=150)

    version_positions = {
        version: index for index, version in enumerate(ordered_versions)
    }
    plotted_any = False

    for label, color, points in series:
        filtered_points = [
            point for point in points if point.version in version_positions
        ]
        if not filtered_points:
            continue

        x_values = [version_positions[point.version] for point in filtered_points]
        y_values = [point.mean for point in filtered_points]
        ax.plot(
            x_values,
            y_values,
            label=label,
            color=color,
            linewidth=2.2,
            marker="o",
            markersize=4.5,
        )
        plotted_any = True

    if not plotted_any:
        plt.close(fig)
        return False

    ax.set_title(title)
    ax.set_xlabel("Version")
    ax.set_ylabel(ylabel)
    ax.set_xticks(range(len(ordered_versions)))
    ax.set_xticklabels(ordered_versions, rotation=45, ha="right")
    ax.grid(True, axis="y", linestyle="--", alpha=0.35)
    ax.legend()
    fig.tight_layout()
    fig.savefig(output_path, bbox_inches="tight")
    plt.close(fig)
    return True


def versions_from_points(series: Iterable[list[BenchPoint]]) -> list[str]:
    versions = {point.version for points in series for point in points}

    return sorted(versions, key=version_sort_key)


def create_runtime_graphs(
    runtime: str, history: dict[str, dict[str, list[BenchPoint]]]
) -> list[Path]:
    created: list[Path] = []
    runtime_graphs_dir = ensure_graph_group_dir(runtime)

    all_sizes_series: list[tuple[str, str, list[BenchPoint]]] = []

    for size in SIZES:
        cold_points = history[size]["cold"]
        warm_points = history[size]["warm"]
        ordered_versions = versions_from_points([cold_points, warm_points])

        all_sizes_series.append((f"{size} cold", SIZE_COLORS[size], cold_points))
        all_sizes_series.append(
            (f"{size} warm", darken(SIZE_COLORS[size]), warm_points)
        )

        combined_path = runtime_graphs_dir / f"{runtime}-{size}.png"
        if plot_series(
            title=f"{runtime.capitalize()} performance evolution · {size}",
            output_path=combined_path,
            ylabel="Mean runtime (seconds)",
            ordered_versions=ordered_versions,
            series=[
                ("Cold cache", CACHE_COLORS["cold"], cold_points),
                ("Warm cache", CACHE_COLORS["warm"], warm_points),
            ],
        ):
            created.append(combined_path)

        cold_path = runtime_graphs_dir / f"{runtime}-{size}-cold.png"
        if plot_series(
            title=f"{runtime.capitalize()} cold-cache performance evolution · {size}",
            output_path=cold_path,
            ylabel="Mean runtime (seconds)",
            ordered_versions=versions_from_points([cold_points]),
            series=[("Cold cache", CACHE_COLORS["cold"], cold_points)],
        ):
            created.append(cold_path)

        warm_path = runtime_graphs_dir / f"{runtime}-{size}-warm.png"
        if plot_series(
            title=f"{runtime.capitalize()} warm-cache performance evolution · {size}",
            output_path=warm_path,
            ylabel="Mean runtime (seconds)",
            ordered_versions=versions_from_points([warm_points]),
            series=[("Warm cache", CACHE_COLORS["warm"], warm_points)],
        ):
            created.append(warm_path)

    all_sizes_path = runtime_graphs_dir / f"{runtime}-all.png"
    if plot_series(
        title=f"{runtime.capitalize()} performance evolution · all sizes",
        output_path=all_sizes_path,
        ylabel="Mean runtime (seconds)",
        ordered_versions=versions_from_points(
            [points for _, _, points in all_sizes_series]
        ),
        series=all_sizes_series,
    ):
        created.append(all_sizes_path)

    return created


def create_all_runtime_graphs(
    runtime_histories: dict[str, dict[str, dict[str, list[BenchPoint]]]],
) -> list[Path]:
    created: list[Path] = []
    all_graphs_dir = ensure_graph_group_dir(ALL_RUNTIME_GROUP)

    for size in SIZES:
        combined_series: list[tuple[str, str, list[BenchPoint]]] = []
        cold_series: list[tuple[str, str, list[BenchPoint]]] = []
        warm_series: list[tuple[str, str, list[BenchPoint]]] = []

        for runtime in RUNTIMES:
            history = runtime_histories.get(runtime)
            if history is None:
                continue

            base_color = RUNTIME_COLORS[runtime]
            cold_points = history[size]["cold"]
            warm_points = history[size]["warm"]

            combined_series.append((f"{runtime} cold", base_color, cold_points))
            combined_series.append((f"{runtime} warm", darken(base_color), warm_points))
            cold_series.append((runtime, base_color, cold_points))
            warm_series.append((runtime, darken(base_color), warm_points))

        combined_path = all_graphs_dir / f"all-{size}.png"
        if plot_series(
            title=f"All runtimes performance evolution · {size}",
            output_path=combined_path,
            ylabel="Mean runtime (seconds)",
            ordered_versions=versions_from_points(
                [points for _, _, points in combined_series]
            ),
            series=combined_series,
        ):
            created.append(combined_path)

        cold_path = all_graphs_dir / f"all-{size}-cold.png"
        if plot_series(
            title=f"All runtimes cold-cache performance evolution · {size}",
            output_path=cold_path,
            ylabel="Mean runtime (seconds)",
            ordered_versions=versions_from_points(
                [points for _, _, points in cold_series]
            ),
            series=cold_series,
        ):
            created.append(cold_path)

        warm_path = all_graphs_dir / f"all-{size}-warm.png"
        if plot_series(
            title=f"All runtimes warm-cache performance evolution · {size}",
            output_path=warm_path,
            ylabel="Mean runtime (seconds)",
            ordered_versions=versions_from_points(
                [points for _, _, points in warm_series]
            ),
            series=warm_series,
        ):
            created.append(warm_path)

    return created


def print_group_status(group: str, label: str, created_files: list[Path]) -> None:
    print(f"\n{RUNTIME_EMOJIS[group]} Processing {label} data")

    if not created_files:
        print("  Nothing to process")
        return

    for graph_path in created_files:
        print(f"  · Wrote {graph_path.name}")


def main() -> int:
    print("🏁 Generating benchmark graphs...")

    runtime_histories = {
        runtime: collect_runtime_history(runtime)
        for runtime in RUNTIMES
        if (BENCH_HISTORY_DIR / runtime).exists()
    }

    created_files: list[Path] = []
    for runtime in RUNTIMES:
        history = runtime_histories.get(runtime)
        if history is None:
            ensure_graph_group_dir(runtime)
            print_group_status(runtime, runtime.capitalize(), [])
            continue
        runtime_created_files = create_runtime_graphs(runtime, history)
        created_files.extend(runtime_created_files)
        print_group_status(runtime, runtime.capitalize(), runtime_created_files)

    all_created_files = create_all_runtime_graphs(runtime_histories)
    created_files.extend(all_created_files)
    print_group_status(ALL_RUNTIME_GROUP, "combined", all_created_files)

    if not created_files:
        print("No benchmark data found to plot", file=sys.stderr)
        return 1

    print(f"\n✅ Done, created {len(created_files)} graphs in {GRAPHS_DIR}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
