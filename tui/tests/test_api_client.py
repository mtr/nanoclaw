from __future__ import annotations

import pytest
from nanoclaw_tui.api_client import NanoClawClient


class TestNanoClawClient:
    def test_builds_auth_header(self) -> None:
        client = NanoClawClient(
            api_url="http://localhost:3000", api_key="test-key"
        )
        assert client.headers["Authorization"] == "Bearer test-key"

    def test_raises_on_empty_api_key(self) -> None:
        with pytest.raises(ValueError, match="API key"):
            NanoClawClient(api_url="http://localhost:3000", api_key="")
