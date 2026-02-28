"""Input bar with readline-style keybindings."""

from __future__ import annotations

from textual.widgets import Input


class MessageInput(Input):
    """Text input with message history."""

    DEFAULT_CSS = """
    MessageInput {
        height: 3;
        margin: 0 0 1 0;
    }
    """

    def __init__(self, **kwargs: object) -> None:
        super().__init__(placeholder="Type a message...", **kwargs)
        self._history: list[str] = []
        self._history_index: int = -1
