"""Audits as CSV."""

import csv
import io


def to_csv(rows: list[dict[str, str]]) -> str:
    """The rows as CSV, their keys as the header; empty without rows."""
    if not rows:
        return ""
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=list(rows[0]), lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue()
