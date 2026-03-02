"""Input bar with multiline editing and history keybindings."""

from __future__ import annotations

from dataclasses import dataclass

from textual import events
from textual.binding import Binding
from textual.message import Message
from textual.widgets import TextArea


class MessageInput(TextArea):
    """Multiline message editor with submission and history navigation."""

    DEFAULT_CSS = """
    MessageInput {
        height: 3;
        margin: 0 0 1 0;
    }
    """
    BINDINGS = [
        *TextArea.BINDINGS,
        Binding("escape", "clear_message_input", "Clear input", show=False),
    ]
    MIN_VISIBLE_CONTENT_LINES = 1
    MAX_VISIBLE_CONTENT_LINES = 8
    BORDER_LINES = 2

    @dataclass
    class Submitted(Message):
        """Posted when message input should be sent."""

        input: "MessageInput"
        value: str

        @property
        def control(self) -> "MessageInput":
            """Alias for `input`."""
            return self.input

    def __init__(self, **kwargs: object) -> None:
        super().__init__(
            "",
            placeholder="Type a message...",
            show_line_numbers=False,
            highlight_cursor_line=False,
            soft_wrap=True,
            **kwargs,
        )
        self._history: list[str] = []
        self._history_cursor: int = -1

    def on_mount(self) -> None:
        """Initialize with the minimum editor height."""
        self._sync_height_to_content()

    def on_text_area_changed(self, event: TextArea.Changed) -> None:
        """Resize editor as content lines grow and shrink."""
        if event.text_area is self:
            self._sync_height_to_content()

    async def _on_key(self, event: events.Key) -> None:
        """Use up/down for history only when appropriate."""
        if event.key == "enter":
            self.action_submit_message()
            event.stop()
            event.prevent_default()
            return

        if event.key == "shift+enter":
            self.action_insert_newline()
            event.stop()
            event.prevent_default()
            return

        if event.key == "up" and (self._history_cursor != -1 or not self.text):
            self.action_history_previous()
            event.stop()
            event.prevent_default()
            return

        if event.key == "down" and self._history_cursor != -1:
            self.action_history_next()
            event.stop()
            event.prevent_default()
            return

        if self._history_cursor != -1 and event.key not in {"up", "down"}:
            self._history_cursor = -1

        await super()._on_key(event)

    async def _on_paste(self, event: events.Paste) -> None:
        """Handle terminal/system paste and update dynamic editor height."""
        await super()._on_paste(event)
        self._sync_height_to_content()

    def action_submit_message(self) -> None:
        """Submit the current text buffer."""
        self.post_message(self.Submitted(self, self.text))

    def action_insert_newline(self) -> None:
        """Insert newline without submitting."""
        start, end = self.selection
        self.replace("\n", start, end, maintain_selection_offset=False)

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
            if self.text:
                return
            self._history_cursor = len(self._history) - 1
        elif self._history_cursor > 0:
            self._history_cursor -= 1

        self.text = self._history[self._history_cursor]
        self._move_cursor_to_end()

    def action_history_next(self) -> None:
        """Show a newer submitted message while navigating input history."""
        if self._history_cursor == -1:
            return
        if self._history_cursor < len(self._history) - 1:
            self._history_cursor += 1
            self.text = self._history[self._history_cursor]
        else:
            self._history_cursor = -1
            self.text = ""
        self._move_cursor_to_end()

    def action_clear_message_input(self) -> None:
        """Clear the input field and reset history navigation state."""
        self._history_cursor = -1
        self.text = ""

    def _move_cursor_to_end(self) -> None:
        """Place cursor at end of the current buffer."""
        last_row = max(0, self.document.line_count - 1)
        last_col = len(self.document[last_row])
        self.cursor_location = (last_row, last_col)

    def _sync_height_to_content(self) -> None:
        """Expand with text lines up to a fixed max, then rely on internal scroll."""
        visible_lines = max(
            self.MIN_VISIBLE_CONTENT_LINES,
            min(self.MAX_VISIBLE_CONTENT_LINES, self.document.line_count),
        )
        self.styles.height = visible_lines + self.BORDER_LINES
