"""Main NanoClaw TUI application."""

from __future__ import annotations

import sys

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.widgets import Footer, Header, Static

from nanoclaw_tui.api_client import NanoClawClient
from nanoclaw_tui.config import TuiConfig
from nanoclaw_tui.widgets.chat_view import AgentMessage, UserMessage
from nanoclaw_tui.widgets.input_bar import MessageInput


class NanoClawTui(App[None]):
    """NanoClaw Terminal User Interface."""

    TITLE = "NanoClaw TUI"
    CSS_PATH = "app.tcss"

    BINDINGS = [
        Binding("ctrl+q", "quit", "Quit"),
        Binding("ctrl+g", "toggle_sidebar", "Groups"),
        Binding("ctrl+r", "search", "Search"),
    ]

    def __init__(self, config: TuiConfig | None = None) -> None:
        super().__init__()
        self.config = config or TuiConfig()
        self.client = NanoClawClient(
            api_url=self.config.api_url,
            api_key=self.config.api_key,
        )
        self.current_jid = self.config.default_jid

    def compose(self) -> ComposeResult:
        yield Header()
        with VerticalScroll(id="chat-view"):
            yield Static("Connecting to NanoClaw...", id="status")
        yield MessageInput(id="message-input")
        yield Footer()

    async def on_mount(self) -> None:
        """Start SSE listener and load history."""
        self.run_worker(self._listen_for_events(), exclusive=True)
        try:
            history = await self.client.get_history(self.current_jid)
            chat_view = self.query_one("#chat-view")
            status = self.query_one("#status")
            status.remove()
            for msg in history:
                if msg.get("is_from_me") or msg.get("is_bot_message"):
                    await chat_view.mount(AgentMessage(msg["content"]))
                else:
                    await chat_view.mount(UserMessage(msg["content"]))
            chat_view.scroll_end(animate=False)
        except Exception:
            self.query_one("#status", Static).update(
                "Failed to connect. Is NanoClaw running?"
            )

    async def on_input_submitted(self, event: MessageInput.Submitted) -> None:
        """Handle message submission."""
        text = event.value.strip()
        if not text:
            return
        event.input.value = ""

        chat_view = self.query_one("#chat-view")
        await chat_view.mount(UserMessage(text))
        chat_view.scroll_end(animate=False)

        try:
            await self.client.send_message(self.current_jid, text)
        except Exception as e:
            await chat_view.mount(Static(f"[red]Failed to send: {e}[/red]"))

    async def _listen_for_events(self) -> None:
        """Listen for SSE events from NanoClaw."""
        async for event in self.client.stream_events():
            if event.event == "message":
                chat_view = self.query_one("#chat-view")
                await chat_view.mount(
                    AgentMessage(event.data.get("content", ""))
                )
                chat_view.scroll_end(animate=False)

    def action_toggle_sidebar(self) -> None:
        """Toggle the group sidebar (implemented in Task 9)."""

    def action_search(self) -> None:
        """Open message search (future enhancement)."""


def main() -> None:
    config = TuiConfig()
    if not config.api_key:
        print(
            "Error: NANOCLAW_API_KEY not set. "
            "Set it in your environment or .env file."
        )
        sys.exit(1)
    app = NanoClawTui(config)
    app.run()


if __name__ == "__main__":
    main()
