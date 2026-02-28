"""Main NanoClaw TUI application."""

from __future__ import annotations

import asyncio
import sys

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual.widgets import Footer, Header, Static

from nanoclaw_tui.api_client import NanoClawClient
from nanoclaw_tui.audio.player import play_audio
from nanoclaw_tui.audio.recorder import AudioRecorder
from nanoclaw_tui.audio.transcriber import VoiceTranscriber
from nanoclaw_tui.chat_history import (
    ChatMessage,
    HistoryCache,
    merge_messages,
    normalize_history_message,
    utc_now_iso,
)
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
        self.history_cache = HistoryCache(self.config.history_cache_path)
        self.transcriber = VoiceTranscriber(
            api_key=self.config.openai_api_key,
            model=self.config.transcription_model,
        )

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
        chat_view = self.query_one("#chat-view", VerticalScroll)
        status = self.query_one("#status", Static)
        status.remove()
        try:
            await self._load_history_into_view(chat_view)
        except Exception:
            await chat_view.mount(
                Static("Failed to connect. Is NanoClaw running?")
            )

    async def on_input_submitted(self, event: MessageInput.Submitted) -> None:
        """Handle message submission."""
        text = event.value.strip()
        if not text:
            return
        event.input.value = ""

        await self._append_local_message(
            ChatMessage(
                role="user",
                content=text,
                timestamp=utc_now_iso(),
            )
        )

        try:
            await self.client.send_message(self.current_jid, text)
        except Exception as e:
            chat_view = self.query_one("#chat-view", VerticalScroll)
            await chat_view.mount(Static(f"[red]Failed to send: {e}[/red]"))

    async def _listen_for_events(self) -> None:
        """Listen for SSE events from NanoClaw."""
        async for event in self.client.stream_events():
            if (
                event.event == "message"
                and event.data.get("jid") == self.current_jid
            ):
                content = str(event.data.get("content", "")).strip()
                if not content:
                    continue
                await self._append_local_message(
                    ChatMessage(
                        role="assistant",
                        content=content,
                        timestamp=str(
                            event.data.get("timestamp") or utc_now_iso()
                        ),
                        message_id=(
                            str(event.data["id"])
                            if event.data.get("id")
                            else None
                        ),
                    )
                )
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
        chat_view = self.query_one("#chat-view", VerticalScroll)
        await chat_view.remove_children()
        try:
            await self._load_history_into_view(chat_view)
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
        chat_view = self.query_one("#chat-view", VerticalScroll)
        status = Static("[dim]Transcribing voice message...[/dim]")
        await chat_view.mount(status)
        chat_view.scroll_end(animate=False)
        transcript = await self.transcriber.transcribe(audio_data)
        status.remove()
        if not transcript:
            await chat_view.mount(
                Static(
                    "[red]Voice transcription failed. "
                    "Set OPENAI_API_KEY to enable voice sending.[/red]"
                )
            )
            self.notify("Voice transcription failed", severity="error")
            return

        await self._append_local_message(
            ChatMessage(
                role="user",
                content=f"[Voice transcript] {transcript}",
                timestamp=utc_now_iso(),
            )
        )
        try:
            await self.client.send_message(
                self.current_jid, transcript, msg_type="voice"
            )
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
        while True:
            try:
                cost_data = await self.client.get_cost_summary()
            except Exception:
                await asyncio.sleep(30)
                continue
            cost_monitor = self.query_one(CostMonitor)
            cost_monitor.update_from_api(cost_data)
            await asyncio.sleep(30)

    def action_search(self) -> None:
        """Open message search (future enhancement)."""

    async def _load_history_into_view(
        self, chat_view: VerticalScroll
    ) -> None:
        raw_history = await self.client.get_history(self.current_jid)
        api_messages: list[ChatMessage] = []
        for payload in raw_history:
            if not isinstance(payload, dict):
                continue
            message = normalize_history_message(payload)
            if message is not None:
                api_messages.append(message)

        cached = self.history_cache.load(self.current_jid)
        merged = merge_messages(api_messages, cached)

        for message in merged:
            await self._mount_chat_message(chat_view, message)
        chat_view.scroll_end(animate=False)
        self.history_cache.store(self.current_jid, merged)

    async def _append_local_message(self, message: ChatMessage) -> None:
        chat_view = self.query_one("#chat-view", VerticalScroll)
        await self._mount_chat_message(chat_view, message)
        chat_view.scroll_end(animate=False)
        self.history_cache.append(self.current_jid, message)

    async def _mount_chat_message(
        self, chat_view: VerticalScroll, message: ChatMessage
    ) -> None:
        if message.role == "assistant":
            await chat_view.mount(AgentMessage(message.content))
            return
        await chat_view.mount(UserMessage(message.content))


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
