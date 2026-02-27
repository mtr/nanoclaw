"""TUI configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass
class TuiConfig:
    api_url: str = field(
        default_factory=lambda: os.environ.get(
            "NANOCLAW_API_URL", "http://127.0.0.1:3000"
        )
    )
    api_key: str = field(
        default_factory=lambda: os.environ.get("NANOCLAW_API_KEY", "")
    )
    audio_player: str = field(
        default_factory=lambda: os.environ.get("AUDIO_PLAYER", "auto")
    )
    default_jid: str = "cli:main"
