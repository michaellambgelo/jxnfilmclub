from __future__ import annotations

from pathlib import Path

import pytest

from jxnfilm_tui.settings import Settings, find_repo_root

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text()


@pytest.fixture
def repo_root() -> Path:
    return find_repo_root()


@pytest.fixture
def settings(repo_root: Path) -> Settings:
    return Settings(repo_root=repo_root, env_name="production")
