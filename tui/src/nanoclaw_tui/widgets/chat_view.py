"""Chat message display widgets."""

from __future__ import annotations

from textual.widgets import Markdown


class UserMessage(Markdown):
    """A message from the user."""

    DEFAULT_CSS = """
    UserMessage {
        margin: 0 0 1 0;
        padding: 0 1;
    }
    """


class AgentMessage(Markdown):
    """A message from the agent."""

    BORDER_TITLE = "Lulu"

    DEFAULT_CSS = """
    AgentMessage {
        margin: 0 0 1 0;
        padding: 0 1;
        border: round $accent;
    }
    """
