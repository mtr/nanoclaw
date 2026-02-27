from __future__ import annotations

import json

import httpx
import pytest
from nanoclaw_tui.api_client import NanoClawClient, SseEvent


class TestNanoClawClient:
    def test_builds_auth_header(self) -> None:
        client = NanoClawClient(
            api_url="http://localhost:3000", api_key="test-key"
        )
        assert client.headers["Authorization"] == "Bearer test-key"

    def test_raises_on_empty_api_key(self) -> None:
        with pytest.raises(ValueError, match="API key"):
            NanoClawClient(api_url="http://localhost:3000", api_key="")

    def test_shared_client_has_headers(self) -> None:
        client = NanoClawClient(
            api_url="http://localhost:3000", api_key="test-key"
        )
        assert client._client.headers["authorization"] == "Bearer test-key"

    def test_strips_trailing_slash(self) -> None:
        client = NanoClawClient(
            api_url="http://localhost:3000/", api_key="key"
        )
        assert client.api_url == "http://localhost:3000"

    def test_shared_client_is_httpx_async_client(self) -> None:
        client = NanoClawClient(
            api_url="http://localhost:3000", api_key="key"
        )
        assert isinstance(client._client, httpx.AsyncClient)

    async def test_async_context_manager(self) -> None:
        async with NanoClawClient(
            api_url="http://localhost:3000", api_key="key"
        ) as client:
            assert isinstance(client, NanoClawClient)
        assert client._client.is_closed

    async def test_close(self) -> None:
        client = NanoClawClient(
            api_url="http://localhost:3000", api_key="key"
        )
        await client.close()
        assert client._client.is_closed

    def test_stop_streaming_flag(self) -> None:
        client = NanoClawClient(
            api_url="http://localhost:3000", api_key="key"
        )
        assert client._streaming is False
        client._streaming = True
        client.stop_streaming()
        assert client._streaming is False


class TestSseParser:
    """Test SSE event parsing logic extracted from stream_events."""

    @staticmethod
    def _parse_raw_event(raw_event: str) -> SseEvent | None:
        """Replicate the SSE parsing logic from stream_events."""
        event_type = "message"
        data_lines: list[str] = []
        for line in raw_event.strip().split("\n"):
            if line.startswith("event: "):
                event_type = line[7:]
            elif line.startswith("data: "):
                data_lines.append(line[6:])
        data_str = "\n".join(data_lines)
        if data_str:
            return SseEvent(event=event_type, data=json.loads(data_str))
        return None

    def test_single_data_line(self) -> None:
        raw = 'event: chat\ndata: {"msg": "hello"}'
        event = self._parse_raw_event(raw)
        assert event is not None
        assert event.event == "chat"
        assert event.data == {"msg": "hello"}

    def test_multi_line_data_concatenation(self) -> None:
        """Multiple data: lines are joined with newlines per SSE spec."""
        raw = 'event: chat\ndata: {"a": 1,\ndata:  "b": 2}'
        event = self._parse_raw_event(raw)
        assert event is not None
        # data lines joined: '{"a": 1,\n "b": 2}'
        assert event.data == {"a": 1, "b": 2}

    def test_multi_line_data_accumulates_all_lines(self) -> None:
        """Verify all data: lines are captured, not just the last one."""
        raw = 'data: [1,\ndata:  2,\ndata:  3]'
        event = self._parse_raw_event(raw)
        assert event is not None
        assert event.data == [1, 2, 3]

    def test_default_event_type(self) -> None:
        raw = 'data: {"ok": true}'
        event = self._parse_raw_event(raw)
        assert event is not None
        assert event.event == "message"

    def test_empty_data(self) -> None:
        raw = "event: ping"
        event = self._parse_raw_event(raw)
        assert event is None
