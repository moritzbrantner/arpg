#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / ".artifacts" / "performance-evidence" / "arpg-product-composition.json"
PERFORMANCE_EVIDENCE_REVISION = "c137f34e627451817d46343eabd5cc04580db474"
COLLECTOR_VERSION = "1.0.0"


def run(*args: str) -> str:
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def sha256_json(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def measurement(name: str, value: int, unit: str, measurement_type: str, description: str) -> dict[str, object]:
    return {
        "name": name,
        "value": value,
        "unit": unit,
        "measurement_type": measurement_type,
        "description": description,
    }


def main() -> None:
    raw_output = run(
        "cargo",
        "run",
        "--locked",
        "--release",
        "--quiet",
        "-p",
        "arpg-core",
        "--example",
        "performance_probe",
    )
    result = json.loads(raw_output.splitlines()[-1])
    if result.get("deterministic") is not True:
        raise RuntimeError("performance probe did not establish deterministic repeated output")

    source_revision = os.environ.get("GITHUB_SHA") or run("git", "rev-parse", "HEAD")
    source_dirty = bool(run("git", "status", "--porcelain"))
    rustc = run("rustc", "--version")
    environment_payload = {
        "os": platform.system().lower(),
        "arch": platform.machine().lower(),
        "rustc": rustc,
        "collector": f"arpg-performance-evidence/{COLLECTOR_VERSION}",
        "performance_evidence_revision": PERFORMANCE_EVIDENCE_REVISION,
    }

    workload_parameters = {
        "players": result["players"],
        "ticks": result["ticks"],
        "runs": result["runs"],
        "snapshot_interval_ticks": 60,
        "attack_interval_ticks": 90,
        "movement_change_interval_ticks": 300,
    }

    evidence = {
        "schema_version": "1.0.0",
        "scenario": {
            "id": "arpg/product-composition-v1",
            "description": (
                "Drive four authoritative players through deterministic movement, combat, "
                "physics stepping and sampled snapshots for one simulated minute."
            ),
            "workload": {
                "id": "four-player-combat-3600-ticks",
                "hash": sha256_json(workload_parameters),
                "seed": result["seed"],
                "parameters": workload_parameters,
            },
        },
        "source": {
            "repository": "https://github.com/moritzbrantner/arpg",
            "revision": source_revision,
            "dirty": source_dirty,
        },
        "environment": {
            "fingerprint": sha256_json(environment_payload),
            "platform": {
                "os": environment_payload["os"],
                "arch": environment_payload["arch"],
            },
            "toolchain": {
                "rustc": rustc,
                "performance_evidence_revision": PERFORMANCE_EVIDENCE_REVISION,
            },
            "collector": {
                "name": "arpg-performance-evidence",
                "version": COLLECTOR_VERSION,
            },
        },
        "measurements": {
            "useful_work": [
                measurement(
                    "arpg.simulation_ticks",
                    result["ticks"],
                    "tick",
                    "counter",
                    "Authoritative simulation ticks requested by the scenario.",
                ),
                measurement(
                    "arpg.commands_submitted",
                    result["commands_submitted"],
                    "command",
                    "counter",
                    "Versioned player commands submitted by the scenario.",
                ),
                measurement(
                    "arpg.snapshots_requested",
                    result["snapshots_requested"],
                    "snapshot",
                    "counter",
                    "Authoritative snapshots explicitly requested by the scenario.",
                ),
            ],
            "induced_work": [
                measurement(
                    "arpg.snapshot_entities_materialized",
                    result["snapshot_entities_materialized"],
                    "entity",
                    "counter",
                    "Entities materialized into explicitly requested authoritative snapshots.",
                )
            ],
            "outcomes": [
                measurement(
                    "time.elapsed_median",
                    result["median_elapsed_ns"],
                    "ns",
                    "duration",
                    "Median elapsed time across repeated release-mode runs; advisory on shared runners.",
                ),
                measurement(
                    "arpg.final_players",
                    result["final_players"],
                    "player",
                    "gauge",
                    "Players present in the final authoritative snapshot.",
                ),
                measurement(
                    "arpg.final_monsters",
                    result["final_monsters"],
                    "monster",
                    "gauge",
                    "Monsters represented in the final authoritative snapshot.",
                ),
            ],
        },
        "extensions": {
            "arpg.determinism": {
                "repeated_final_snapshot_identical": True,
                "timing_blocking": False,
            }
        },
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(OUTPUT.relative_to(ROOT))


if __name__ == "__main__":
    main()
