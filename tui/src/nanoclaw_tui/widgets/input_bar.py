"""Input bar with readline-style keybindings."""

from __future__ import annotations

from textual.binding import Binding
from textual.widgets import Input


class MessageInput(Input):
    """Text input with message history."""

    DEFAULT_CSS = """
    MessageInput {
        height: 3;
        margin: 0 0 1 0;
    }
    """
    BINDINGS = [
        *Input.BINDINGS,
        Binding(
            "ctrl+shift+v",
            "paste",
            "Paste clipboard text",
            show=False,
        ),
        Binding("up", "history_previous", "Previous message", show=False),
        Binding("down", "history_next", "Next message", show=False),
        Binding("escape", "clear_message_input", "Clear input", show=False),
    ]

    def __init__(self, **kwargs: object) -> None:
        super().__init__(placeholder="Type a message...", **kwargs)
        self._history: list[str] = []
        self._history_cursor: int = -1

    def record_submission(self, text: str) -> None:
        """Add a submitted message to local input history."""
        normalized = text.strip()
        if not normalized:
            return
        self._history.append(normalized)
        self._history_cursor = -1

    def action_history_previous(self) -> None:
        """Show an older submitted message when history navigation is active."""
        if not self._history:
            return
        if self._history_cursor == -1:
            if self.value:
                return
            self._history_cursor = len(self._history) - 1
        elif self._history_cursor > 0:
            self._history_cursor -= 1

        self.value = self._history[self._history_cursor]
        self.cursor_position = len(self.value)

    def action_history_next(self) -> None:
        """Show a newer submitted message while navigating input history."""
        if self._history_cursor == -1:
            return
        if self._history_cursor < len(self._history) - 1:
            self._history_cursor += 1
            self.value = self._history[self._history_cursor]
        else:
            self._history_cursor = -1
            self.value = ""
        self.cursor_position = len(self.value)

    def action_clear_message_input(self) -> None:
        """Clear the input field and reset history navigation state."""
        self._history_cursor = -1
        self.value = ""
