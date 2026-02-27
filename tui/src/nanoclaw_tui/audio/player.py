"""Audio playback using system audio players."""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path


def detect_player() -> str | None:
    """Auto-detect an available audio player."""
    for player in ("mpv", "ffplay", "afplay", "aplay"):
        if shutil.which(player):
            return player
    return None


async def play_audio(
    audio_data: bytes, player: str | None = None
) -> Path:
    """Play audio data and return the file path for later replay.

    Uses asyncio.create_subprocess_exec (not shell) for safe invocation.
    """
    player = player or detect_player()

    fd, tmp_str = tempfile.mkstemp(suffix=".ogg")
    os.close(fd)
    tmp = Path(tmp_str)
    tmp.write_bytes(audio_data)

    if player:
        cmd_map: dict[str, list[str]] = {
            "mpv": ["mpv", "--no-video", "--really-quiet", str(tmp)],
            "ffplay": [
                "ffplay",
                "-nodisp",
                "-autoexit",
                "-loglevel",
                "quiet",
                str(tmp),
            ],
            "afplay": ["afplay", str(tmp)],
            "aplay": ["aplay", str(tmp)],
        }
        cmd = cmd_map.get(player, [player, str(tmp)])
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()

    return tmp
