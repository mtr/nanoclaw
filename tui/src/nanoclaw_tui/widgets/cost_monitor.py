"""TTS cost monitoring widget."""

from __future__ import annotations

from typing import Any

from textual.reactive import reactive
from textual.widgets import Static


class CostMonitor(Static):
    """Displays current TTS spend in the header."""

    DEFAULT_CSS = """
    CostMonitor {
        dock: right;
        width: auto;
        padding: 0 1;
    }

    CostMonitor.ok { color: $success; }
    CostMonitor.info { color: $warning; }
    CostMonitor.warning { color: $error; }
    CostMonitor.critical { color: $error; background: $error-darken-3; }
    CostMonitor.exceeded { color: $text; background: $error; }
    """

    spent: reactive[float] = reactive(0.0)
    budget: reactive[float] = reactive(0.0)
    alert_tier: reactive[str] = reactive("ok")

    def render(self) -> str:
        if self.budget > 0:
            return f"${self.spent:.2f}/${self.budget:.2f}"
        return f"${self.spent:.2f}"

    def watch_alert_tier(self, tier: str) -> None:
        self.remove_class("ok", "info", "warning", "critical", "exceeded")
        self.add_class(tier)

    def update_from_api(self, cost_data: dict[str, Any]) -> None:
        """Update from API cost summary response."""
        usage = cost_data.get("usage", {})
        budget_status = cost_data.get("budget", {})

        today = usage.get("today", {})
        self.spent = today.get("cost", 0.0)

        daily = budget_status.get("daily")
        self.budget = daily.get("budget", 0.0) if daily else 0.0
        self.alert_tier = daily.get("alertTier", "ok") if daily else "ok"
