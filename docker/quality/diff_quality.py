"""`factory/qualité-diff` (ORC-280): crapper and dryer on the files a branch changes, as JSON on stdout.

Run by `verify` in the commands' sandbox, without network, with crapper's and dryer's own interpreter (`python -I`, so
nothing of the checkout is imported), from the root of the checkout:

    diff_quality.py [--coverage <dir>] [--covered <language>,...] -- <path>...

The paths are the files the diff adds lines to. Functions: crapper's, in those files, test files left out, with CC, and
for a language in `--covered` the coverage of the LCOV reports under `--coverage` and the CRAP score. Pairs: dryer's,
each with a function of those files on one side, compared with every function of the repository in the same language.
Both tools only parse: neither runs anything of the checkout, nor reads the network.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from crapper.coverage import CoverageBundle, parse_lcov
from crapper.crap import crap_score
from crapper.discover import is_test_file as crapper_test, language_of as crapper_language
from crapper.languages import functions_in_file
from dryer.discover import is_test_file as dryer_test, iter_source_files, language_of as dryer_language
from dryer.scan import scan_files
from dryer.shape import jaccard

# dryer's defaults: its threshold, and the forms too small to be worth a pair.
THRESHOLD = 0.82
MIN_LINES = 4
MIN_NODES = 20


def parse(argv: list[str]) -> tuple[Path | None, set[str], list[str]]:
    coverage: Path | None = None
    covered: set[str] = set()
    i = 0
    while i < len(argv) and argv[i] != "--":
        if argv[i] == "--coverage":
            coverage = Path(argv[i + 1])
        elif argv[i] == "--covered":
            covered = {c for c in argv[i + 1].split(",") if c}
        else:
            raise SystemExit(f"unknown option {argv[i]}")
        i += 2
    return coverage, covered, argv[i + 1 :]


def own_files(root: Path, paths: list[str]) -> list[Path]:
    """The regular files of the checkout among `paths`: a link is not followed, nor a path out of the root."""

    found = []
    for p in paths:
        path = root / p
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
            continue
        found.append(path)
    return found


def lcov(coverage: Path | None) -> dict:
    merged: dict = {}
    if coverage is None or not coverage.is_dir():
        return merged
    for report in sorted([*coverage.rglob("lcov.info"), *coverage.rglob("*.lcov")]):
        if report.is_file() and not report.is_symlink():
            merged.update(parse_lcov(report.read_text(encoding="utf-8", errors="replace")))
    return merged


def functions(root: Path, files: list[Path], coverage: Path | None, covered: set[str]) -> list[dict]:
    sources = [f for f in files if crapper_language(f) and not crapper_test(f.relative_to(root))]
    rel = [f.relative_to(root).as_posix() for f in sources]
    lines = lcov(coverage) if covered else {}
    # No report read: the coverage is not known, never 0 %.
    bundle = CoverageBundle(lcov=lines, root=root) if lines else None
    if bundle:
        bundle.bind_sources(rel)
    out = []
    for path, file in zip(rel, sources):
        language = crapper_language(file)
        for fn in functions_in_file(language, file.read_text(encoding="utf-8", errors="replace"), path, str(root)):
            pct = None
            if bundle and language in covered:
                pct = bundle.percent_for(fn)
                pct = 0.0 if pct is None else round(pct, 1)
            crap = crap_score(fn.complexity, pct)
            out.append({"path": path, "name": fn.name, "start": fn.start_line, "end": fn.end_line, "cc": fn.complexity, "coverage": pct, "crap": None if crap is None else round(crap, 1)})
    return out


def pairs(root: Path, files: list[Path]) -> list[dict]:
    changed = [f for f in files if dryer_language(f) and not dryer_test(f.relative_to(root))]
    if not changed:
        return []
    mine, _ = scan_files(changed, root, MIN_LINES, MIN_NODES)
    corpus = {p.resolve() for p in iter_source_files([root])} | {f.resolve() for f in changed}
    every, _ = scan_files(sorted(corpus), root, MIN_LINES, MIN_NODES)
    span = lambda e: (e.file, e.start_line, e.end_line)  # noqa: E731
    seen: set = set()
    out = []
    for left in mine:
        for right in every:
            if right.language != left.language or span(right) == span(left):
                continue
            key = frozenset((span(left), span(right)))
            if key in seen:
                continue
            score = jaccard(left.fingerprints, right.fingerprints)
            if score < THRESHOLD:
                continue
            seen.add(key)
            out.append({"score": round(score, 2), "left": {"path": left.file, "start": left.start_line, "end": left.end_line}, "right": {"path": right.file, "start": right.start_line, "end": right.end_line}})
    return out


def main(argv: list[str]) -> None:
    coverage, covered, paths = parse(argv)
    root = Path.cwd().resolve()
    files = own_files(root, paths)
    json.dump({"functions": functions(root, files, coverage, covered), "pairs": pairs(root, files)}, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1:])
