# NanoClaw TUI

A terminal-based interface for NanoClaw built with [Textual](https://textual.textualize.io/). Connects to NanoClaw's HTTP API server to send messages, receive streaming responses, and manage voice interactions.

## Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/) package manager
- A running NanoClaw instance with the HTTP API enabled

## Installation

```bash
cd tui
uv sync
```

## Running

From the project root:

```bash
npm run tui
```

Or directly:

```bash
cd tui
uv run nanoclaw-tui
```

## Configuration

The TUI reads environment variables from the project root `.env` file (loaded automatically by the launch script) or from your shell environment.

### Server-side variables (in `.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `NANOCLAW_API_PORT` | `3000` | HTTP API server port |
| `NANOCLAW_API_KEY` | _(required)_ | Shared secret between server and TUI |
| `NANOCLAW_API_ENABLED` | `true` | Must be `true` for the TUI to connect |

### TUI-side variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NANOCLAW_API_URL` | `http://127.0.0.1:3000` | Full URL of the NanoClaw API |
| `NANOCLAW_API_KEY` | _(required)_ | Must match the server's key |
| `AUDIO_PLAYER` | `auto` | Audio player: `auto`, `mpv`, `ffplay`, `afplay`, `aplay` |

`NANOCLAW_API_KEY` is required. The TUI will exit with an error if it is not set.

## Keybindings

| Key | Action |
|-----|--------|
| `Ctrl+Q` | Quit |
| `Ctrl+G` | Toggle group sidebar |
| `Ctrl+R` | Search (future) |
| `Ctrl+Space` | Push-to-talk voice recording |

## Voice Setup

Voice support requires:

1. **System audio player** -- at least one of: `mpv`, `ffplay`, `afplay` (macOS), or `aplay` (Linux). The TUI auto-detects an available player unless you set `AUDIO_PLAYER` explicitly.

2. **TTS enabled on the server** -- set `OPENAI_TTS_ENABLED=true` in `.env`.

### Recording

Press `Ctrl+Space` to start recording from your microphone. Press `Ctrl+Space` again to stop and send the audio to NanoClaw. The server transcribes it via Whisper and responds with both text and (if TTS is enabled) synthesised audio that plays back automatically.

## Cost Management

The TUI header displays a CostMonitor widget showing daily TTS spend pulled from the NanoClaw API every 30 seconds.

### Budget configuration

Set daily TTS budget via the API:

```bash
curl -X POST http://localhost:3000/api/cost/budget \
  -H "Authorization: Bearer $NANOCLAW_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"period": "daily", "amount": 1.00}'
```

Or set budget variables in `.env`:

| Variable | Description |
|----------|-------------|
| `OPENAI_TTS_BUDGET_DAILY` | Daily TTS spend limit (USD) |
| `OPENAI_TTS_BUDGET_WEEKLY` | Weekly TTS spend limit (USD) |
| `OPENAI_TTS_BUDGET_MONTHLY` | Monthly TTS spend limit (USD) |

### Alert tiers

| Tier | Threshold | Meaning |
|------|-----------|---------|
| ok | < 60% | Normal |
| info | 60--80% | Approaching budget |
| warning | 80--95% | Nearing limit |
| critical | 95--100% | Almost exhausted |
| exceeded | > 100% | Over budget |

## Project Structure

```
tui/
  pyproject.toml              # Python project config (dependencies, entry point)
  uv.lock                     # Locked dependencies
  src/nanoclaw_tui/
    app.py                    # Main Textual application
    app.tcss                  # Stylesheet
    api_client.py             # HTTP + SSE client
    config.py                 # Environment-based configuration
    audio/
      player.py               # Audio playback
      recorder.py             # Microphone capture
    widgets/
      chat_view.py            # Message display
      cost_monitor.py         # TTS cost header widget
      input_bar.py            # Message input
      session_sidebar.py      # Group list sidebar
```
