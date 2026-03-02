from __future__ import annotations

from textual.app import App, ComposeResult

from nanoclaw_tui.app import NanoClawTui
from nanoclaw_tui.config import TuiConfig
from nanoclaw_tui.widgets.input_bar import MessageInput


class InputHarness(App[None]):
    def compose(self) -> ComposeResult:
        yield MessageInput(id="message-input")


def test_message_input_includes_ctrl_shift_copy_paste_bindings() -> None:
    keys = {binding.key for binding in MessageInput.BINDINGS}
    assert "ctrl+shift+v" in keys


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
        assert message_input.value == "third"

        message_input.action_history_previous()
        assert message_input.value == "second"

        message_input.action_history_previous()
        assert message_input.value == "first"

        # Stay pinned at oldest when going further back.
        message_input.action_history_previous()
        assert message_input.value == "first"

        message_input.action_history_next()
        assert message_input.value == "second"

        message_input.action_history_next()
        assert message_input.value == "third"

        # Reaching newest returns to an empty draft.
        message_input.action_history_next()
        assert message_input.value == ""


async def test_message_input_history_starts_only_when_empty() -> None:
    app = InputHarness()
    async with app.run_test():
        message_input = app.query_one("#message-input", MessageInput)
        message_input.value = "draft"
        message_input.record_submission("one")
        message_input.record_submission("two")

        message_input.action_history_previous()
        assert message_input.value == "draft"


async def test_message_input_esc_clears_value() -> None:
    app = InputHarness()
    async with app.run_test():
        message_input = app.query_one("#message-input", MessageInput)
        message_input.value = "to clear"
        message_input.record_submission("one")
        message_input.action_history_previous()

        message_input.action_clear_message_input()
        assert message_input.value == ""

        # After clearing, pressing down does nothing because history mode reset.
        message_input.action_history_next()
        assert message_input.value == ""


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
        message_input.value = "copy me"
        message_input.action_select_all()
        monkeypatch.setattr(app.screen, "get_selected_text", lambda: None)

        app.action_copy_selection_or_focused_input()
        assert app.clipboard == "copy me"
