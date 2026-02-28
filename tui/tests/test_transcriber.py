from __future__ import annotations

import httpx
import pytest
from nanoclaw_tui.audio.transcriber import VoiceTranscriber


class _FakeResponse:
    def __init__(self, text: str, status_ok: bool = True) -> None:
        self.text = text
        self._status_ok = status_ok

    def raise_for_status(self) -> None:
        if not self._status_ok:
            raise httpx.HTTPStatusError(
                "bad status",
                request=httpx.Request("POST", "https://example.com"),
                response=httpx.Response(status_code=500),
            )


@pytest.mark.asyncio
async def test_transcriber_returns_none_without_key() -> None:
    transcriber = VoiceTranscriber(api_key="")
    result = await transcriber.transcribe(b"audio")
    assert result is None


@pytest.mark.asyncio
async def test_transcriber_success(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_post(*_args, **_kwargs):
        return _FakeResponse("hello from audio")

    class _FakeClient:
        async def __aenter__(self) -> "_FakeClient":
            return self

        async def __aexit__(
            self,
            *_exc: object,
        ) -> None:
            return None

        post = fake_post

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **_kwargs: _FakeClient(),
    )

    transcriber = VoiceTranscriber(api_key="key")
    result = await transcriber.transcribe(b"audio")
    assert result == "hello from audio"


@pytest.mark.asyncio
async def test_transcriber_handles_http_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_post(*_args, **_kwargs):
        return _FakeResponse("", status_ok=False)

    class _FakeClient:
        async def __aenter__(self) -> "_FakeClient":
            return self

        async def __aexit__(
            self,
            *_exc: object,
        ) -> None:
            return None

        post = fake_post

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **_kwargs: _FakeClient(),
    )

    transcriber = VoiceTranscriber(api_key="key")
    result = await transcriber.transcribe(b"audio")
    assert result is None
