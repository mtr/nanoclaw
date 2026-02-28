"""Message normalization and local cache for TUI chat replay."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Literal

Role = Literal["user", "assistant"]


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    if isinstance(value, str):
        return value.lower() in {"1", "true", "yes", "on"}
    return False


def _parse_ts(timestamp: str) -> datetime | None:
    if not timestamp:
        return None
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed
    except ValueError:
        return None


def _content_from_payload(payload: dict[str, Any]) -> str:
    raw = (
        payload.get("content")
        or payload.get("text")
        or payload.get("message")
        or payload.get("body")
    )
    if isinstance(raw, str):
        return raw.strip()
    if isinstance(raw, dict):
        nested = raw.get("content") or raw.get("text")
        return nested.strip() if isinstance(nested, str) else ""
    return ""


def _infer_role(payload: dict[str, Any], assistant_name: str) -> Role:
    if _as_bool(payload.get("is_bot_message")) or _as_bool(
        payload.get("isBotMessage")
    ):
        return "assistant"
    if _as_bool(payload.get("is_from_me")) or _as_bool(
        payload.get("isFromMe")
    ):
        return "user"
    if _as_bool(payload.get("from_me")) or _as_bool(payload.get("fromMe")):
        return "user"

    role = str(payload.get("role", "")).strip().lower()
    if role in {"assistant", "agent", "bot", "ai", assistant_name.lower()}:
        return "assistant"
    if role in {"user", "human", "client"}:
        return "user"

    direction = str(payload.get("direction", "")).strip().lower()
    if direction in {"outbound", "assistant", "bot"}:
        return "assistant"
    if direction in {"inbound", "user"}:
        return "user"

    sender = str(payload.get("sender", "")).strip().lower()
    sender_name = str(
        payload.get("sender_name") or payload.get("senderName") or ""
    ).strip().lower()

    if sender in {"cli-user", "user"} or sender_name in {"cli-user", "user"}:
        return "user"
    if sender_name == assistant_name.lower() or sender.startswith("bot"):
        return "assistant"
    if sender_name in {"assistant", "bot"}:
        return "assistant"

    return "user"


@dataclass(frozen=True)
class ChatMessage:
    """Normalized chat message used by the TUI."""

    role: Role
    content: str
    timestamp: str
    message_id: str | None = None

    def key(self) -> str:
        if self.message_id:
            return f"id:{self.message_id}"
        return f"{self.timestamp}|{self.role}|{self.content}"

    def to_dict(self) -> dict[str, str]:
        data = {
            "role": self.role,
            "content": self.content,
            "timestamp": self.timestamp,
        }
        if self.message_id:
            data["id"] = self.message_id
        return data


def normalize_history_message(
    payload: dict[str, Any], assistant_name: str = "Lulu"
) -> ChatMessage | None:
    """Normalize potentially variant history payloads to one UI model."""
    content = _content_from_payload(payload)
    if not content:
        return None

    timestamp = str(
        payload.get("timestamp")
        or payload.get("created_at")
        or payload.get("createdAt")
        or payload.get("time")
        or utc_now_iso()
    )

    message_id = payload.get("id") or payload.get("message_id")
    if message_id is not None:
        message_id = str(message_id)

    return ChatMessage(
        role=_infer_role(payload, assistant_name=assistant_name),
        content=content,
        timestamp=timestamp,
        message_id=message_id,
    )


def merge_messages(
    primary: list[ChatMessage], secondary: list[ChatMessage]
) -> list[ChatMessage]:
    """Merge and dedupe two message lists, then sort by timestamp."""
    merged: dict[str, ChatMessage] = {}

    for message in primary:
        merged[message.key()] = message
    for message in secondary:
        merged.setdefault(message.key(), message)

    ordered = list(merged.values())
    ordered.sort(
        key=lambda message: (
            _parse_ts(message.timestamp) is None,
            _parse_ts(message.timestamp) or datetime.max.replace(
                tzinfo=timezone.utc
            ),
            message.timestamp,
        )
    )
    return ordered


class HistoryCache:
    """Simple per-chat JSON cache for message replay between TUI runs."""

    def __init__(self, path: str) -> None:
        self.path = Path(path)

    def load(self, jid: str) -> list[ChatMessage]:
        payload = self._read_all()
        raw_messages = payload.get(jid, [])
        messages: list[ChatMessage] = []
        if not isinstance(raw_messages, list):
            return messages

        for item in raw_messages:
            if not isinstance(item, dict):
                continue
            role = item.get("role")
            content = item.get("content")
            timestamp = item.get("timestamp")
            if role not in {"user", "assistant"}:
                continue
            if not isinstance(content, str) or not content.strip():
                continue
            if not isinstance(timestamp, str) or not timestamp:
                continue
            message_id = item.get("id")
            if message_id is not None:
                message_id = str(message_id)
            messages.append(
                ChatMessage(
                    role=role,
                    content=content,
                    timestamp=timestamp,
                    message_id=message_id,
                )
            )

        return messages

    def store(self, jid: str, messages: list[ChatMessage]) -> None:
        merged = merge_messages(messages, [])
        payload = self._read_all()
        payload[jid] = [m.to_dict() for m in merged[-500:]]
        self._write_all(payload)

    def append(self, jid: str, message: ChatMessage) -> None:
        messages = self.load(jid)
        messages.append(message)
        self.store(jid, messages)

    def _read_all(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write_all(self, payload: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_suffix(".tmp")
        tmp_path.write_text(
            json.dumps(payload, ensure_ascii=True, indent=2),
            encoding="utf-8",
        )
        tmp_path.replace(self.path)
