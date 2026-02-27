"""Microphone capture for push-to-talk."""

from __future__ import annotations

import io

import numpy as np


class AudioRecorder:
    """Records audio from the default microphone."""

    def __init__(
        self, sample_rate: int = 16000, channels: int = 1
    ) -> None:
        self.sample_rate = sample_rate
        self.channels = channels
        self._recording = False
        self._frames: list[np.ndarray] = []
        self._stream: object | None = None

    def start(self) -> None:
        """Start recording from the microphone."""
        import sounddevice as sd

        self._frames = []
        self._recording = True
        self._stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=self.channels,
            dtype="int16",
            callback=self._callback,
        )
        self._stream.start()  # type: ignore[union-attr]

    def stop(self) -> bytes:
        """Stop recording and return OGG audio data as bytes."""
        import soundfile as sf

        self._recording = False
        if self._stream is not None:
            self._stream.stop()  # type: ignore[union-attr]
            self._stream.close()  # type: ignore[union-attr]
            self._stream = None

        if not self._frames:
            return b""

        audio_data = np.concatenate(self._frames)
        buffer = io.BytesIO()
        sf.write(
            buffer,
            audio_data,
            self.sample_rate,
            format="OGG",
            subtype="VORBIS",
        )
        return buffer.getvalue()

    @property
    def is_recording(self) -> bool:
        return self._recording

    def _callback(
        self,
        indata: np.ndarray,
        _frames: int,
        _time_info: object,
        _status: object,
    ) -> None:
        if self._recording:
            self._frames.append(indata.copy())
