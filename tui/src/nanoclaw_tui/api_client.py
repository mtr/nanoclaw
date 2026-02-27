"""HTTP + SSE client for NanoClaw API."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx


@dataclass
class SseEvent:
    event: str
    data: dict[str, Any]


class NanoClawClient:
    """Client for the NanoClaw HTTP API."""

    def __init__(self, api_url: str, api_key: str) -> None:
        if not api_key:
            raise ValueError("API key is required")
        self.api_url = api_url.rstrip("/")
        self.api_key = api_key
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        self._client = httpx.AsyncClient(headers=self.headers)
        self._streaming = False

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    async def __aenter__(self) -> NanoClawClient:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    def stop_streaming(self) -> None:
        """Signal the SSE stream loop to stop."""
        self._streaming = False

    async def get_status(self) -> dict[str, Any]:
        resp = await self._client.get(f"{self.api_url}/api/status")
        resp.raise_for_status()
        return resp.json()

    async def send_message(
        self,
        jid: str,
        content: str,
        msg_type: str = "text",
        sender: str = "cli-user",
        sender_name: str = "User",
    ) -> None:
        resp = await self._client.post(
            f"{self.api_url}/api/messages",
            json={
                "jid": jid,
                "content": content,
                "type": msg_type,
                "sender": sender,
                "senderName": sender_name,
            },
        )
        resp.raise_for_status()

    async def send_audio(self, jid: str, audio_data: bytes) -> None:
        resp = await self._client.post(
            f"{self.api_url}/api/messages",
            json={
                "jid": jid,
                "content": base64.b64encode(audio_data).decode(),
                "type": "voice",
            },
        )
        resp.raise_for_status()

    async def get_groups(self) -> dict[str, Any]:
        resp = await self._client.get(f"{self.api_url}/api/groups")
        resp.raise_for_status()
        return resp.json()

    async def get_history(
        self, jid: str, limit: int = 50
    ) -> list[dict[str, Any]]:
        resp = await self._client.get(
            f"{self.api_url}/api/groups/{jid}/history",
            params={"limit": limit},
        )
        resp.raise_for_status()
        return resp.json()

    async def get_cost_summary(self) -> dict[str, Any]:
        resp = await self._client.get(
            f"{self.api_url}/api/cost/summary",
        )
        resp.raise_for_status()
        return resp.json()

    async def set_budget(self, period: str, amount: float) -> None:
        resp = await self._client.post(
            f"{self.api_url}/api/cost/budget",
            json={"period": period, "amount": amount},
        )
        resp.raise_for_status()

    async def download_audio(self, audio_url: str) -> bytes:
        resp = await self._client.get(f"{self.api_url}{audio_url}")
        resp.raise_for_status()
        return resp.content

    async def stream_events(self) -> AsyncIterator[SseEvent]:
        """Connect to SSE stream and yield events. Reconnects on failure."""
        self._streaming = True
        while self._streaming:
            try:
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream(
                        "GET",
                        f"{self.api_url}/api/messages/stream",
                        headers=self.headers,
                    ) as resp:
                        resp.raise_for_status()
                        buffer = ""
                        async for chunk in resp.aiter_text():
                            if not self._streaming:
                                return
                            buffer += chunk
                            while "\n\n" in buffer:
                                raw_event, buffer = buffer.split(
                                    "\n\n", 1
                                )
                                event_type = "message"
                                data_lines: list[str] = []
                                for line in raw_event.strip().split("\n"):
                                    if line.startswith("event: "):
                                        event_type = line[7:]
                                    elif line.startswith("data: "):
                                        data_lines.append(line[6:])
                                data_str = "\n".join(data_lines)
                                if data_str:
                                    yield SseEvent(
                                        event=event_type,
                                        data=json.loads(data_str),
                                    )
            except (
                httpx.ConnectError,
                httpx.ReadError,
                httpx.RemoteProtocolError,
            ):
                if self._streaming:
                    await asyncio.sleep(2)
