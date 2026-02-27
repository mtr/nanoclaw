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

    async def get_status(self) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.api_url}/api/status", headers=self.headers
            )
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
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.api_url}/api/messages",
                headers=self.headers,
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
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.api_url}/api/messages",
                headers=self.headers,
                json={
                    "jid": jid,
                    "content": base64.b64encode(audio_data).decode(),
                    "type": "voice",
                },
            )
            resp.raise_for_status()

    async def get_groups(self) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.api_url}/api/groups", headers=self.headers
            )
            resp.raise_for_status()
            return resp.json()

    async def get_history(
        self, jid: str, limit: int = 50
    ) -> list[dict[str, Any]]:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.api_url}/api/groups/{jid}/history",
                headers=self.headers,
                params={"limit": limit},
            )
            resp.raise_for_status()
            return resp.json()

    async def get_cost_summary(self) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.api_url}/api/cost/summary", headers=self.headers
            )
            resp.raise_for_status()
            return resp.json()

    async def set_budget(self, period: str, amount: float) -> None:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{self.api_url}/api/cost/budget",
                headers=self.headers,
                json={"period": period, "amount": amount},
            )
            resp.raise_for_status()

    async def download_audio(self, audio_url: str) -> bytes:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{self.api_url}{audio_url}", headers=self.headers
            )
            resp.raise_for_status()
            return resp.content

    async def stream_events(self) -> AsyncIterator[SseEvent]:
        """Connect to SSE stream and yield events. Reconnects on failure."""
        while True:
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
                            buffer += chunk
                            while "\n\n" in buffer:
                                raw_event, buffer = buffer.split("\n\n", 1)
                                event_type = "message"
                                data_str = ""
                                for line in raw_event.strip().split("\n"):
                                    if line.startswith("event: "):
                                        event_type = line[7:]
                                    elif line.startswith("data: "):
                                        data_str = line[6:]
                                if data_str:
                                    yield SseEvent(
                                        event=event_type,
                                        data=json.loads(data_str),
                                    )
            except (httpx.ConnectError, httpx.ReadError):
                await asyncio.sleep(2)
