"""TUI configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _default_cache_path() -> str:
    project_root = Path(__file__).resolve().parents[3]
    return str(project_root / "store" / "tui" / "history-cache.json")


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
    openai_api_key: str = field(
        default_factory=lambda: os.environ.get("OPENAI_API_KEY", "")
    )
    transcription_model: str = field(
        default_factory=lambda: os.environ.get(
            "NANOCLAW_TUI_TRANSCRIPTION_MODEL", "whisper-1"
        )
    )
    history_cache_path: str = field(
        default_factory=lambda: os.environ.get(
            "NANOCLAW_TUI_HISTORY_CACHE", _default_cache_path()
        )
    )
    default_jid: str = "cli:main"
