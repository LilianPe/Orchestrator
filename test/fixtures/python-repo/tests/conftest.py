import pytest


@pytest.fixture
def audits() -> list[dict[str, str]]:
    return [{"id": "1", "score": "80"}, {"id": "2", "score": "95"}]
