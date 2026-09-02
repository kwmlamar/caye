#!/usr/bin/env python3
"""Compare full-test and TypeScript failures on origin/main vs the PR checkout.

The classifier is intentionally conservative. A candidate failure is BASELINE only
when the same normalized signature is observed from the same command on main.
Anything candidate-only, or any non-zero command with no extractable signature,
is a PR_REGRESSION and fails the gate.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ANSI = re.compile(r"\x1b\[[0-9;]*m")
TEST_PREFIX = re.compile(r"^\s*(?:FAIL\s+|❯\s+|×\s+)")
TS_ERROR = re.compile(r"(?:^|\s)([^\n]*?\([^\n]*?\):\s*error\s+TS\d+:.*)$")
LOAD_ERROR = re.compile(r"(?:Error:\s+Failed to load url .*|Failed to load url .*)")
TEST_SUMMARY_FAIL = re.compile(r"^\s*Test Files\s+.*failed", re.I)


@dataclass
class Result:
    label: str
    command: list[str]
    returncode: int
    output: str
    signatures: set[str]


def normalize(line: str, roots: list[Path]) -> str:
    line = ANSI.sub('', line).strip()
    for root in roots:
        root_s = str(root.resolve())
        line = line.replace(root_s, '<repo>')
    line = re.sub(r"/home/runner/work/caye/caye", "<repo>", line)
    line = re.sub(r"\\", "/", line)
    line = re.sub(r"\s+", " ", line)
    return line.strip()


def extract_test_signatures(output: str, roots: list[Path]) -> set[str]:
    signatures: set[str] = set()
    for raw in output.splitlines():
        line = ANSI.sub('', raw)
        if TEST_PREFIX.search(line) or LOAD_ERROR.search(line):
            normalized = normalize(line, roots)
            if normalized:
                signatures.add(normalized)
    return signatures


def extract_tsc_signatures(output: str, roots: list[Path]) -> set[str]:
    signatures: set[str] = set()
    for raw in output.splitlines():
        line = ANSI.sub('', raw)
        if 'error TS' not in line:
            continue
        normalized = normalize(line, roots)
        if normalized:
            signatures.add(normalized)
    return signatures


def run(label: str, cwd: Path, command: list[str], kind: str, roots: list[Path]) -> Result:
    proc = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env={**os.environ, 'CI': 'true', 'FORCE_COLOR': '0'},
    )
    output = proc.stdout or ''
    print(f"\n===== {label}: {' '.join(command)} =====")
    print(output, end='' if output.endswith('\n') else '\n')
    extractor = extract_test_signatures if kind == 'test' else extract_tsc_signatures
    signatures = extractor(output, roots)
    if proc.returncode != 0 and not signatures:
        # Do not silently bless an unparsed failure. The full normalized tail gives
        # reviewers something concrete while forcing the candidate gate red.
        tail = [normalize(x, roots) for x in output.splitlines()[-25:] if normalize(x, roots)]
        signatures.add('UNCLASSIFIED_NONZERO: ' + ' | '.join(tail[-8:]))
    return Result(label, command, proc.returncode, output, signatures)


def classify(kind: str, baseline: Result, candidate: Result) -> int:
    print(f"\n===== {kind.upper()} DELTA =====")
    all_signatures = sorted(baseline.signatures | candidate.signatures)
    regressions = 0
    for signature in all_signatures:
        on_main = signature in baseline.signatures
        on_pr = signature in candidate.signatures
        if on_main and on_pr:
            print(f"BASELINE: {signature}")
        elif on_pr:
            regressions += 1
            print(f"PR_REGRESSION: {signature}")
        else:
            print(f"BASELINE_ONLY_FIXED: {signature}")

    if not all_signatures and baseline.returncode == 0 and candidate.returncode == 0:
        print('CLEAN: both main and PR passed')
    print(f"RESULT {kind}: baseline_exit={baseline.returncode} candidate_exit={candidate.returncode} pr_regressions={regressions}")
    return regressions


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--main', required=True, type=Path)
    parser.add_argument('--candidate', default='.', type=Path)
    args = parser.parse_args()
    main_root = args.main.resolve()
    candidate_root = args.candidate.resolve()
    roots = [main_root, candidate_root]

    main_tests = run('origin/main', main_root, ['npm', 'test', '--', '--run'], 'test', roots)
    pr_tests = run('PR branch', candidate_root, ['npm', 'test', '--', '--run'], 'test', roots)
    main_tsc = run('origin/main', main_root, ['npx', 'tsc', '--noEmit'], 'tsc', roots)
    pr_tsc = run('PR branch', candidate_root, ['npx', 'tsc', '--noEmit'], 'tsc', roots)

    regressions = classify('full tests', main_tests, pr_tests)
    regressions += classify('typecheck', main_tsc, pr_tsc)
    if regressions:
        print(f"CI DELTA GATE: FAIL ({regressions} PR regression signature(s))")
        return 1
    print('CI DELTA GATE: PASS (0 PR-introduced test failures, 0 PR-introduced TypeScript errors)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
