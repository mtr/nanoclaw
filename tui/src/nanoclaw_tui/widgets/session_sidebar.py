"""Group session sidebar for switching conversations."""

from __future__ import annotations

from typing import Any

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.message import Message
from textual.widgets import Label, OptionList
from textual.widgets.option_list import Option


class GroupSelected(Message):
    """Emitted when a group is selected."""

    def __init__(self, jid: str, name: str) -> None:
        super().__init__()
        self.jid = jid
        self.name = name


class SessionSidebar(Vertical):
    """Sidebar showing available groups."""

    DEFAULT_CSS = """
    SessionSidebar {
        width: 20;
        dock: left;
        border-right: solid $accent;
        padding: 1;
        display: none;
    }

    SessionSidebar.visible {
        display: block;
    }
    """

    def compose(self) -> ComposeResult:
        yield Label("Groups", id="sidebar-title")
        yield OptionList(id="group-list")

    def update_groups(
        self, groups: dict[str, Any], active_jid: str
    ) -> None:
        """Replace the group list with current groups, highlighting the active one."""
        option_list = self.query_one("#group-list", OptionList)
        option_list.clear_options()
        for jid, group in groups.items():
            prefix = "\u25cf " if jid == active_jid else "\u25cb "
            name = group.get("name", jid) if isinstance(group, dict) else jid
            option_list.add_option(Option(f"{prefix}{name}", id=jid))

    def on_option_list_option_selected(
        self, event: OptionList.OptionSelected
    ) -> None:
        if event.option.id:
            self.post_message(
                GroupSelected(
                    jid=str(event.option.id), name=event.option.prompt
                )
            )
