from __future__ import annotations

from textual import on
from textual import events
from textual.app import App, ComposeResult

from nanoclaw_tui.app import NanoClawTui
from nanoclaw_tui.config import TuiConfig
from nanoclaw_tui.widgets.input_bar import MessageInput


class InputHarness(App[None]):
    def __init__(self) -> None:
        super().__init__()
        self.submitted_messages: list[str] = []

    def compose(self) -> ComposeResult:
        yield MessageInput(id="message-input")

    @on(MessageInput.Submitted)
    async def on_message_input_submitted(
        self, event: MessageInput.Submitted
    ) -> None:
        self.submitted_messages.append(event.value)


def test_message_input_includes_escape_binding() -> None:
    keys = {binding.key for binding in MessageInput.BINDINGS}
    assert "alt+backspace" in keys
    assert "escape" in keys


def test_app_includes_ctrl_shift_copy_binding() -> None:
    keys = {binding.key for binding in NanoClawTui.BINDINGS}
    assert "ctrl+shift+c" in keys


async def test_message_input_history_navigation() -> None:
    app = InputHarness()
    async with app.run_test():
        message_input = app.query_one("#message-input", MessageInput)
        message_input.record_submission("first")
        message_input.record_submission("second")
        message_input.record_submission("third")

        message_input.action_history_previous()
        assert message_input.text == "third"

        message_input.action_history_previous()
        assert message_input.text == "second"

        message_input.action_history_previous()
        assert message_input.text == "first"

        # Stay pinned at oldest when going further back.
        message_input.action_history_previous()
        assert message_input.text == "first"

        message_input.action_history_next()
        assert message_input.text == "second"

        message_input.action_history_next()
        assert message_input.text == "third"

        # Reaching newest returns to an empty draft.
        message_input.action_history_next()
        assert message_input.text == ""


async def test_message_input_history_starts_only_when_empty() -> None:
    app = InputHarness()
    async with app.run_test():
        message_input = app.query_one("#message-input", MessageInput)
        message_input.text = "draft"
        message_input.record_submission("one")
        message_input.record_submission("two")

        message_input.action_history_previous()
        assert message_input.text == "draft"


async def test_message_input_esc_clears_value() -> None:
    app = InputHarness()
    async with app.run_test():
        message_input = app.query_one("#message-input", MessageInput)
        message_input.text = "to clear"
        message_input.record_submission("one")
        message_input.action_history_previous()

        message_input.action_clear_message_input()
        assert message_input.text == ""

        # After clearing, pressing down does nothing because history mode reset.
        message_input.action_history_next()
        assert message_input.text == ""


async def test_message_input_supports_multiline_paste() -> None:
    app = InputHarness()
    async with app.run_test():
        message_input = app.query_one("#message-input", MessageInput)
        app.copy_to_clipboard("line one\nline two\nline three")
        message_input.action_paste()
        assert message_input.text == "line one\nline two\nline three"


async def test_message_input_resizes_on_terminal_paste() -> None:
    app = InputHarness()
    async with app.run_test() as pilot:
        message_input = app.query_one("#message-input", MessageInput)
        await message_input._on_paste(events.Paste("a\nb\nc\nd"))
        await pilot.pause()
        assert message_input.text == "a\nb\nc\nd"
        assert message_input.styles.height.value == 6.0


async def test_shift_enter_inserts_newline_and_enter_submits() -> None:
    app = InputHarness()
    async with app.run_test() as pilot:
        message_input = app.query_one("#message-input", MessageInput)
        message_input.focus()

        await pilot.press("h", "i")
        await pilot.press("shift+enter")
        await pilot.press("t", "h", "e", "r", "e")
        assert message_input.text == "hi\nthere"
        assert app.submitted_messages == []

        await pilot.press("enter")
        await pilot.pause()
        assert app.submitted_messages == ["hi\nthere"]


async def test_alt_backspace_deletes_previous_word() -> None:
    app = InputHarness()
    async with app.run_test() as pilot:
        message_input = app.query_one("#message-input", MessageInput)
        message_input.focus()
        message_input.text = "hello world"
        message_input.action_cursor_line_end()

        await pilot.press("alt+backspace")
        assert message_input.text == "hello "


async def test_message_input_height_grows_and_caps() -> None:
    app = InputHarness()
    async with app.run_test() as pilot:
        message_input = app.query_one("#message-input", MessageInput)

        message_input.text = "one"
        await pilot.pause()
        assert message_input.styles.height.value == 3.0

        message_input.text = "\n".join(f"line {n}" for n in range(1, 30))
        await pilot.pause()
        assert (
            message_input.styles.height.value
            == MessageInput.MAX_VISIBLE_CONTENT_LINES
            + MessageInput.BORDER_LINES
        )


async def test_app_focuses_message_input_on_mount(monkeypatch, tmp_path) -> None:
    async def _noop_load_history(self, _chat_view) -> None:  # pragma: no cover
        return None

    def _close_worker_coroutines(self, worker, **_kwargs):
        if hasattr(worker, "close"):
            worker.close()
        return None

    monkeypatch.setattr(NanoClawTui, "_load_history_into_view", _noop_load_history)
    monkeypatch.setattr(NanoClawTui, "run_worker", _close_worker_coroutines)

    app = NanoClawTui(
        TuiConfig(
            api_url="http://localhost:3000",
            api_key="test-key",
            history_cache_path=str(tmp_path / "history.json"),
        )
    )

    async with app.run_test():
        message_input = app.query_one("#message-input", MessageInput)
        assert app.focused is message_input


async def test_app_copy_prefers_screen_selection(monkeypatch, tmp_path) -> None:
    async def _noop_load_history(self, _chat_view) -> None:  # pragma: no cover
        return None

    def _close_worker_coroutines(self, worker, **_kwargs):
        if hasattr(worker, "close"):
            worker.close()
        return None

    monkeypatch.setattr(NanoClawTui, "_load_history_into_view", _noop_load_history)
    monkeypatch.setattr(NanoClawTui, "run_worker", _close_worker_coroutines)

    app = NanoClawTui(
        TuiConfig(
            api_url="http://localhost:3000",
            api_key="test-key",
            history_cache_path=str(tmp_path / "history.json"),
        )
    )

    async with app.run_test():
        monkeypatch.setattr(app.screen, "get_selected_text", lambda: "selected chat text")
        app.action_copy_selection_or_focused_input()
        assert app.clipboard == "selected chat text"


async def test_app_copy_falls_back_to_focused_input(monkeypatch, tmp_path) -> None:
    async def _noop_load_history(self, _chat_view) -> None:  # pragma: no cover
        return None

    def _close_worker_coroutines(self, worker, **_kwargs):
        if hasattr(worker, "close"):
            worker.close()
        return None

    monkeypatch.setattr(NanoClawTui, "_load_history_into_view", _noop_load_history)
    monkeypatch.setattr(NanoClawTui, "run_worker", _close_worker_coroutines)

    app = NanoClawTui(
        TuiConfig(
            api_url="http://localhost:3000",
            api_key="test-key",
            history_cache_path=str(tmp_path / "history.json"),
        )
    )

    async with app.run_test():
        message_input = app.query_one("#message-input", MessageInput)
        message_input.text = "copy me"
        message_input.action_select_all()
        monkeypatch.setattr(app.screen, "get_selected_text", lambda: None)

        app.action_copy_selection_or_focused_input()
        assert app.clipboard == "copy me"
