"""`factory/qualité-diff` (ORC-280): crapper and dryer on the files a branch changes, as JSON on stdout.

Run by `verify` in the commands' sandbox, without network, with crapper's and dryer's own interpreter (`python -I`, so
nothing of the checkout is imported), from the root of the checkout:

    diff_quality.py <coverage dir> <covered languages, comma-separated> <similarity> -- <path>...

The paths are the files the diff adds lines to. Functions: crapper's, in those files, test files left out, with CC, and
for a covered language the coverage of the LCOV reports under the coverage dir and the CRAP score. Pairs: dryer's, each
with a function of those files on one side, compared with every function of the repository in the same language.
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

# dryer's defaults for the forms too small to be worth a pair.
MIN_LINES = 4
MIN_NODES = 20


def r1(x: float | None) -> float | None:
    return None if x is None else round(x, 1)


def own_files(root: Path, paths: list[str]) -> list[Path]:
    """The regular files of the checkout among `paths`: a link is not followed, nor a path out of the root."""

    found = []
    for p in paths:
        path = root / p
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root):
            continue
        found.append(path)
    return found


def lcov(coverage: Path) -> dict:
    merged: dict = {}
    for report in sorted(coverage.rglob("*")) if coverage.is_dir() else []:
        if (report.name == "lcov.info" or report.suffix == ".lcov") and report.is_file() and not report.is_symlink():
            merged.update(parse_lcov(report.read_text(encoding="utf-8", errors="replace")))
    return merged


def functions(root: Path, files: list[Path], coverage: Path, covered: set[str]) -> list[dict]:
    sources = [(f.relative_to(root).as_posix(), f, crapper_language(f)) for f in files]
    sources = [s for s in sources if s[2] and not crapper_test(s[0])]
    lines = lcov(coverage) if covered else {}
    # No report read: the coverage is not known, never 0 %.
    bundle = CoverageBundle(lcov=lines, root=root) if lines else None
    if bundle:
        bundle.bind_sources([path for path, _, _ in sources])
    out = []
    for path, file, language in sources:
        for fn in functions_in_file(language, file.read_text(encoding="utf-8", errors="replace"), path, str(root)):
            # None: no report names the file (another package's tests, an `include`): unknown, never 0 %.
            pct = r1(bundle.percent_for(fn)) if bundle and language in covered else None
            out.append({"path": path, "name": fn.name, "start": fn.start_line, "end": fn.end_line, "cc": fn.complexity, "coverage": pct, "crap": r1(crap_score(fn.complexity, pct))})
    return out


def pairs(root: Path, files: list[Path], similarity: float) -> list[dict]:
    changed = {f.relative_to(root).as_posix() for f in files if dryer_language(f) and not dryer_test(f.relative_to(root))}
    if not changed:
        return []
    corpus = {p.resolve() for p in iter_source_files([root])} | {(root / p).resolve() for p in changed}
    every, _ = scan_files(sorted(corpus), root, MIN_LINES, MIN_NODES)
    by_language: dict[str, list] = {}
    for e in every:
        by_language.setdefault(e.language, []).append(e)
    span = lambda e: (e.file, e.start_line, e.end_line)  # noqa: E731
    seen: set = set()
    out = []
    for left in (e for e in every if e.file in changed):
        here = span(left)
        for right in by_language[left.language]:
            there = span(right)
            key = frozenset((here, there))
            if there == here or key in seen:
                continue
            score = jaccard(left.fingerprints, right.fingerprints)
            if score < similarity:
                continue
            seen.add(key)
            out.append({"score": round(score, 2), "left": {"path": left.file, "start": left.start_line, "end": left.end_line}, "right": {"path": right.file, "start": right.start_line, "end": right.end_line}})
    return out


def main(argv: list[str]) -> None:
    coverage, covered, similarity, sep, *paths = argv
    if sep != "--":
        raise SystemExit("usage: diff_quality.py <coverage dir> <covered> <similarity> -- <path>...")
    root = Path.cwd().resolve()
    files = own_files(root, paths)
    out = {"functions": functions(root, files, Path(coverage), {c for c in covered.split(",") if c}), "pairs": pairs(root, files, float(similarity))}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1:])
