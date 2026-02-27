"""Main NanoClaw TUI application."""

from __future__ import annotations

import sys

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.widgets import Footer, Header, Static

from nanoclaw_tui.api_client import NanoClawClient
from nanoclaw_tui.audio.player import play_audio
from nanoclaw_tui.audio.recorder import AudioRecorder
from nanoclaw_tui.config import TuiConfig
from nanoclaw_tui.widgets.chat_view import AgentMessage, UserMessage
from nanoclaw_tui.widgets.cost_monitor import CostMonitor
from nanoclaw_tui.widgets.input_bar import MessageInput
from nanoclaw_tui.widgets.session_sidebar import GroupSelected, SessionSidebar


class NanoClawTui(App[None]):
    """NanoClaw Terminal User Interface."""

    TITLE = "NanoClaw TUI"
    CSS_PATH = "app.tcss"

    BINDINGS = [
        Binding("ctrl+q", "quit", "Quit"),
        Binding("ctrl+g", "toggle_sidebar", "Groups"),
        Binding("ctrl+r", "search", "Search"),
        Binding("ctrl+space", "toggle_recording", "Voice", show=True),
    ]

    def __init__(self, config: TuiConfig | None = None) -> None:
        super().__init__()
        self.config = config or TuiConfig()
        self.client = NanoClawClient(
            api_url=self.config.api_url,
            api_key=self.config.api_key,
        )
        self.current_jid = self.config.default_jid
        self.recorder = AudioRecorder()

    def compose(self) -> ComposeResult:
        yield Header()
        yield CostMonitor()
        yield SessionSidebar()
        with VerticalScroll(id="chat-view"):
            yield Static("Connecting to NanoClaw...", id="status")
        yield MessageInput(id="message-input")
        yield Footer()

    async def on_mount(self) -> None:
        """Start SSE listener, cost polling, and load history."""
        self.run_worker(self._listen_for_events(), exclusive=True)
        self.run_worker(self._poll_cost(), exclusive=False)
        try:
            history = await self.client.get_history(self.current_jid)
            chat_view = self.query_one("#chat-view")
            status = self.query_one("#status")
            status.remove()
            for msg in history:
                if msg.get("is_from_me") or msg.get("is_bot_message"):
                    await chat_view.mount(AgentMessage(msg.get("content", "")))
                else:
                    await chat_view.mount(UserMessage(msg.get("content", "")))
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
            if event.event == "message" and event.data.get("jid") == self.current_jid:
                chat_view = self.query_one("#chat-view")
                await chat_view.mount(
                    AgentMessage(event.data.get("content", ""))
                )
                chat_view.scroll_end(animate=False)
            elif (
                event.event == "audio"
                and event.data.get("jid") == self.current_jid
            ):
                audio_url = event.data.get("audioUrl", "")
                if audio_url:
                    self.run_worker(self._play_audio(audio_url))

    async def on_unmount(self) -> None:
        """Clean up client resources."""
        self.client.stop_streaming()
        await self.client.close()

    def action_toggle_sidebar(self) -> None:
        """Toggle the group sidebar visibility and refresh group list."""
        sidebar = self.query_one(SessionSidebar)
        sidebar.toggle_class("visible")
        if sidebar.has_class("visible"):
            self.run_worker(self._refresh_groups())

    async def _refresh_groups(self) -> None:
        """Fetch groups from the API and update the sidebar."""
        try:
            groups = await self.client.get_groups()
            sidebar = self.query_one(SessionSidebar)
            sidebar.update_groups(groups, self.current_jid)
        except Exception:
            self.notify("Failed to load groups", severity="error")

    async def on_group_selected(self, event: GroupSelected) -> None:
        """Switch to the selected group conversation."""
        self.current_jid = event.jid
        chat_view = self.query_one("#chat-view")
        await chat_view.remove_children()
        try:
            history = await self.client.get_history(self.current_jid)
            for msg in history:
                content = msg.get("content", "")
                if msg.get("is_from_me") or msg.get("is_bot_message"):
                    await chat_view.mount(AgentMessage(content))
                else:
                    await chat_view.mount(UserMessage(content))
            chat_view.scroll_end(animate=False)
        except Exception:
            await chat_view.mount(Static("Failed to load history."))

    def action_toggle_recording(self) -> None:
        """Toggle push-to-talk recording on Ctrl+Space."""
        if self.recorder.is_recording:
            try:
                audio_data = self.recorder.stop()
            except Exception as e:
                self.notify(f"Recording failed: {e}", severity="error")
                return
            if audio_data:
                self.run_worker(self._send_voice(audio_data))
        else:
            try:
                self.recorder.start()
            except Exception as e:
                self.notify(f"Microphone error: {e}", severity="error")
                return
            self.notify("Recording... Press Ctrl+Space to stop")

    async def _send_voice(self, audio_data: bytes) -> None:
        """Send recorded audio to NanoClaw."""
        chat_view = self.query_one("#chat-view")
        await chat_view.mount(Static("[dim]Sending voice message...[/dim]"))
        chat_view.scroll_end(animate=False)
        try:
            await self.client.send_audio(self.current_jid, audio_data)
        except Exception as e:
            await chat_view.mount(
                Static(f"[red]Failed to send voice: {e}[/red]")
            )

    async def _play_audio(self, audio_url: str) -> None:
        """Download and play an audio file from the server."""
        try:
            audio_data = await self.client.download_audio(audio_url)
            player = (
                None
                if self.config.audio_player == "auto"
                else self.config.audio_player
            )
            await play_audio(audio_data, player)
        except Exception:
            self.notify("Failed to play audio", severity="warning")

    async def _poll_cost(self) -> None:
        """Poll cost summary every 30 seconds."""
        import asyncio

        while True:
            try:
                cost_data = await self.client.get_cost_summary()
                cost_monitor = self.query_one(CostMonitor)
                cost_monitor.update_from_api(cost_data)
            except Exception:
                pass
            await asyncio.sleep(30)

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
