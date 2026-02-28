from __future__ import annotations

from nanoclaw_tui.chat_history import (
    ChatMessage,
    HistoryCache,
    merge_messages,
    normalize_history_message,
)


def test_normalize_history_message_prefers_bot_flag() -> None:
    msg = normalize_history_message(
        {
            "id": "m1",
            "content": "hello",
            "timestamp": "2026-02-28T00:00:00.000Z",
            "is_bot_message": True,
        }
    )
    assert msg is not None
    assert msg.role == "assistant"
    assert msg.message_id == "m1"


def test_normalize_history_message_uses_sender_fallback() -> None:
    msg = normalize_history_message(
        {
            "content": "from me",
            "timestamp": "2026-02-28T00:00:00.000Z",
            "sender": "cli-user",
        }
    )
    assert msg is not None
    assert msg.role == "user"


def test_merge_messages_dedupes_by_id() -> None:
    first = [
        ChatMessage(
            role="user",
            content="hi",
            timestamp="2026-02-28T00:00:00.000Z",
            message_id="1",
        )
    ]
    second = [
        ChatMessage(
            role="assistant",
            content="reply",
            timestamp="2026-02-28T00:00:01.000Z",
            message_id="2",
        ),
        ChatMessage(
            role="user",
            content="hi",
            timestamp="2026-02-28T00:00:00.000Z",
            message_id="1",
        ),
    ]
    merged = merge_messages(first, second)
    assert len(merged) == 2
    assert [m.message_id for m in merged] == ["1", "2"]


def test_history_cache_roundtrip(tmp_path) -> None:
    cache = HistoryCache(str(tmp_path / "history.json"))
    jid = "cli:main"
    cache.store(
        jid,
        [
            ChatMessage(
                role="user",
                content="hello",
                timestamp="2026-02-28T00:00:00.000Z",
                message_id="1",
            ),
            ChatMessage(
                role="assistant",
                content="world",
                timestamp="2026-02-28T00:00:01.000Z",
                message_id="2",
            ),
        ],
    )

    loaded = cache.load(jid)
    assert [m.content for m in loaded] == ["hello", "world"]
