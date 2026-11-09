from app.export import to_csv


def test_empty() -> None:
    assert to_csv([]) == ""


def test_header_then_rows(audits: list[dict[str, str]]) -> None:
    assert to_csv(audits) == "id,score\n1,80\n2,95\n"
