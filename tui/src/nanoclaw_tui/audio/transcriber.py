"""Voice transcription helper for TUI voice messages."""

from __future__ import annotations

import httpx


class VoiceTranscriber:
    """Transcribe recorded OGG audio using OpenAI's transcription API."""

    def __init__(
        self,
        api_key: str,
        model: str = "whisper-1",
        base_url: str = "https://api.openai.com/v1",
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")

    async def transcribe(self, audio_data: bytes) -> str | None:
        if not self.api_key or not audio_data:
            return None

        headers = {"Authorization": f"Bearer {self.api_key}"}
        data = {"model": self.model, "response_format": "text"}
        files = {"file": ("voice.ogg", audio_data, "audio/ogg")}

        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    f"{self.base_url}/audio/transcriptions",
                    headers=headers,
                    data=data,
                    files=files,
                )
            response.raise_for_status()
        except (httpx.HTTPError, httpx.TimeoutException):
            return None

        transcript = response.text.strip()
        return transcript or None
