# Design: CLI TUI Channel with Text-to-Speech

**Date:** 2026-02-27
**Status:** Approved

## Overview

Add a terminal-based user interface (TUI) for interacting with NanoClaw agents, built with Python's Textual framework. Includes bidirectional voice support: speech-to-text input (via existing Whisper integration) and text-to-speech responses (via OpenAI TTS). Communication between the TUI and NanoClaw happens over a local HTTP API with SSE streaming.

## Goals

1. Interactive terminal chat with NanoClaw agents (same capabilities as WhatsApp)
2. Voice input via push-to-talk microphone capture
3. Voice output via OpenAI TTS with configurable voice and affect
4. Rich markdown rendering and syntax-highlighted code blocks
5. Session management across multiple groups
6. Cost monitoring with multi-tier budget controls

## Non-Goals

- Web UI (but the HTTP API enables this later)
- Replacing WhatsApp — both channels coexist
- Real-time voice conversation (not a phone call, just voice messages)

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     NanoClaw (Node.js)                       │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  WhatsApp     │  │  CLI Channel │  │  HTTP API Server │  │
│  │  Channel      │  │  (virtual)   │  │  (localhost:3000) │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                 │                    │             │
│         └────────┬────────┘                    │             │
│                  ▼                             │             │
│         ┌────────────────┐                     │             │
│         │  Orchestrator  │◄────────────────────┘             │
│         │  (index.ts)    │                                   │
│         └───────┬────────┘                                   │
│                 │                                            │
│         ┌───────▼────────┐    ┌────────────────┐            │
│         │  Agent Queue   │───►│  Container      │            │
│         │  (group-queue) │    │  Runner         │            │
│         └────────────────┘    └────────────────┘            │
│                                                             │
│         ┌────────────────┐    ┌────────────────┐            │
│         │  TTS Service   │    │  SQLite DB     │            │
│         │  (OpenAI)      │    │                │            │
│         └────────────────┘    └────────────────┘            │
└─────────────────────────────────────────────────────────────┘
                         ▲
                         │ HTTP + SSE (Bearer token auth)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   Textual TUI (Python)                       │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Chat View    │  │  Input Bar   │  │  Session Sidebar │  │
│  │  (Markdown)   │  │  (readline)  │  │  (group list)    │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Mic Capture  │  │  Audio       │  │  Cost Monitor    │  │
│  │  (push-talk)  │  │  Playback    │  │  Widget          │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### CLI Channel (Virtual)

A ~30-line `Channel` implementation that serves as a routing adapter:

- `ownsJid(jid)` — returns `true` for JIDs in the `cli:` namespace
- `sendMessage(jid, text)` — pushes messages onto the SSE stream (instead of doing direct I/O)
- `connect/disconnect/isConnected` — trivial lifecycle (always connected when API server is running)

This allows the existing orchestrator routing to work for TUI messages without modifying core logic. The HTTP API handles transport; the CLI Channel handles routing.

---

## HTTP API

Runs inside the NanoClaw process on `127.0.0.1` only.

### Authentication

All requests require `Authorization: Bearer <NANOCLAW_API_KEY>`. The key is stored in `.env` and generated on first setup.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/messages` | Send a text or audio message |
| `GET` | `/api/messages/stream` | SSE stream for responses, typing indicators, cost updates |
| `GET` | `/api/groups` | List available groups (registered + unregistered) |
| `POST` | `/api/groups/:jid/select` | Switch active conversation |
| `GET` | `/api/groups/:jid/history` | Fetch message history for a group |
| `GET` | `/api/audio/:id` | Fetch generated audio file |
| `GET` | `/api/status` | Health check |
| `GET` | `/api/cost/summary` | Budget usage summary (daily/weekly/monthly) |
| `POST` | `/api/cost/budget` | Set/update budget thresholds |

### Message Flow

**Text message:**
```
TUI → POST /api/messages { "jid": "cli:main", "content": "Hello Lulu", "type": "text" }
  → API creates NewMessage, calls cliChannel.onMessage()
    → stored in SQLite → poll loop picks up → agent runs
      → cliChannel.sendMessage() → pushes to SSE stream
        → TUI receives: { "type": "message", "content": "Hi!", "audio_url": null }
```

**Voice message:**
```
TUI → POST /api/messages (multipart: audio file)
  → API transcribes via Whisper (reuses transcription.ts)
    → stores "[Voice: transcript]" → same flow as text
      → response includes audio_url if TTS triggered
        → TUI fetches audio, auto-plays + shows text
```

---

## TTS (Text-to-Speech) Service

Server-side module in NanoClaw alongside existing `transcription.ts`.

### Voice Configuration

```env
OPENAI_TTS_VOICE=marin
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_INSTRUCTIONS_FILE=config/tts-instructions.txt
OPENAI_TTS_ENABLED=true
```

**`config/tts-instructions.txt`:**
```
Voice Affect: Calm, composed, and reassuring; project quiet authority and confidence.
Tone: Sincere, empathetic, and gently authoritative—express genuine apology while conveying competence.
Pacing: Steady and moderate; unhurried enough to communicate care, yet efficient enough to demonstrate professionalism.
Emotion: Genuine empathy and understanding; speak with warmth, especially during apologies.
Pronunciation: Clear and precise, emphasizing key reassurances ("smoothly," "quickly," "promptly") to reinforce confidence.
Pauses: Brief pauses after offering assistance or requesting details, highlighting willingness to listen and support.
```

### Modality Decision Logic

1. **Input-modality mirroring (default):** voice input → voice + text response; text input → text response
2. **Explicit override:** agent detects phrases like "read aloud", "reply in audio" in text input and generates voice
3. **Agent discretion:** for voice-triggered requests that produce written content (plans, lists), the agent may send a brief spoken summary alongside the text

The modality signal is conveyed via an `<audio>` tag in the agent's response (stripped before delivery, like existing `<internal>` tags).

### Audio Output

- Format: Opus-encoded `.ogg` (compatible with WhatsApp voice notes, efficient for terminal playback)
- Storage: `data/audio/` with random IDs, auto-cleaned after configurable TTL (default: 24h)
- Delivery: both text and audio are sent when voice is triggered

---

## Cost Management

### Budget System

Users configure budgets at any granularity. The system calculates missing tiers:

```env
# Set any combination — system derives the rest
OPENAI_TTS_BUDGET_MONTHLY=10.00   # USD
OPENAI_TTS_BUDGET_WEEKLY=          # auto-calculated if empty
OPENAI_TTS_BUDGET_DAILY=           # auto-calculated if empty
```

If only monthly is set ($10), the system calculates:
- Weekly ≈ $2.31 (monthly ÷ average weeks per month)
- Daily ≈ $0.33 (monthly ÷ average days per month)

The system can analyze historical usage patterns to produce smarter distributions (e.g. heavier weekend usage → allocate more budget to Sat/Sun).

Budgets can also be expressed in tokens (characters) for users who prefer that unit.

### Usage Tracking

**SQLite `tts_usage` table:**

| Column | Type | Purpose |
|--------|------|---------|
| `id` | INTEGER | Primary key |
| `timestamp` | TEXT | ISO 8601 |
| `characters` | INTEGER | Characters sent to TTS |
| `tokens_estimated` | INTEGER | Estimated token count |
| `cost_estimated` | REAL | USD based on current pricing |
| `model` | TEXT | TTS model used |
| `message_id` | TEXT | Link to triggering message |

Characters and cost are stored separately so costs can be retroactively recalculated if pricing changes.

### Alert Tiers

| Threshold | Action |
|-----------|--------|
| 60% of period budget | TUI header cost indicator turns yellow |
| 80% of period budget | Warning notification in chat |
| 95% of period budget | Strong warning: "TTS will be disabled at 100%" |
| 100% of period budget | TTS disabled for that period, text-only fallback |

Enforcement uses the most granular active budget. Hitting the daily limit stops TTS for the day even if the monthly budget has room.

### TUI Budget Commands

| Command | Action |
|---------|--------|
| `/cost` | Show daily, weekly, monthly breakdown with remaining budget |
| `/budget set monthly 15` | Update monthly budget |
| `/budget set daily 0.50` | Update daily budget |
| `/budget list` | Show all active budget thresholds |

---

## Textual TUI Application

### Project Structure

```
tui/
  pyproject.toml
  src/
    nanoclaw_tui/
      __init__.py
      app.py              # Main Textual App
      api_client.py       # HTTP + SSE client
      widgets/
        chat_view.py      # Scrollable message list (Markdown)
        input_bar.py      # Text input with readline keybindings
        session_sidebar.py # Group list + switching
        cost_monitor.py   # TTS cost display
        audio_indicator.py # Recording/playback status
      audio/
        recorder.py       # Microphone capture (push-to-talk)
        player.py         # Audio playback (mpv/ffplay/afplay)
      config.py           # TUI config (API URL, audio player, keybindings)
```

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  NanoClaw TUI                                    🎤 $0.02  │
├──────────────┬──────────────────────────────────────────────┤
│              │                                              │
│  Groups      │  [You] 10:23 AM                              │
│              │  Hey Lulu, can you help with the API?        │
│  ● Main      │                                              │
│  ○ Work Team │  [Lulu] 10:23 AM                       🔊   │
│  ○ Family    │  Of course! Here's what I found...           │
│              │                                              │
│              │  ```python                                   │
│              │  def handle_request():                       │
│              │      ...                                     │
│              │  ```                                         │
│              │                                              │
├──────────────┴──────────────────────────────────────────────┤
│  > Type a message...                    [Ctrl+Space: 🎤]   │
├─────────────────────────────────────────────────────────────┤
│  Ctrl+R: Search  Ctrl+G: Groups  Ctrl+Q: Quit   F1: Help  │
└─────────────────────────────────────────────────────────────┘
```

### Key Bindings

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Ctrl+Space` | Push-to-talk (hold to record, release to send) |
| `Ctrl+R` | Search previous messages |
| `Ctrl+G` | Toggle group sidebar |
| `Ctrl+Q` | Quit |
| `Ctrl+A` / `Ctrl+E` | Start / end of input line |
| `Ctrl+W` | Delete word backward |
| `Ctrl+K` / `Ctrl+U` | Kill to end / start of line |
| `Up` / `Down` | Scroll through sent message history |
| `F1` | Help / keybinding reference |
| `Ctrl+P` | Command palette |

### Command Palette

Built-in Textual command palette (`Ctrl+P`) with commands:

- Switch to group: [group name]
- Play last audio message
- Toggle voice mode
- Show cost summary
- Set budget
- Clear chat

### Rich Output

- Markdown rendering via Textual's built-in `Markdown` widget
- Syntax-highlighted code blocks via Rich/Pygments
- Audio indicator (🔊) on voice messages
- Typing indicator ("Lulu is thinking...")
- File sharing via `/file <path>` command or drag-and-drop

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| NanoClaw not running | TUI shows "Connecting..." with exponential backoff retry |
| SSE stream drops | Auto-reconnect, re-fetch missed messages from history endpoint |
| Agent container timeout | "Lulu is taking longer than expected..." after 30s, allows cancellation |
| TTS API failure | Fall back to text-only, show "Voice unavailable" notification |
| Microphone unavailable | Disable push-to-talk, show error on first attempt |
| Audio player not found | Fall back to save-to-file mode, suggest installing mpv/ffplay |
| Invalid API key | Clear error message with instructions to check .env |

---

## Configuration Summary

### New `.env` Variables

```env
# HTTP API
NANOCLAW_API_PORT=3000
NANOCLAW_API_KEY=                         # Required, generated on first setup

# TTS
OPENAI_TTS_VOICE=marin
OPENAI_TTS_MODEL=gpt-4o-mini-tts
OPENAI_TTS_INSTRUCTIONS_FILE=config/tts-instructions.txt
OPENAI_TTS_ENABLED=true
OPENAI_TTS_BUDGET_MONTHLY=               # USD (optional)
OPENAI_TTS_BUDGET_WEEKLY=                # USD (optional)
OPENAI_TTS_BUDGET_DAILY=                 # USD (optional)

# TUI (in tui/.env or passed as env vars)
NANOCLAW_API_URL=http://127.0.0.1:3000
AUDIO_PLAYER=auto                        # auto-detect mpv/ffplay/afplay
```

### New Files

| File | Purpose |
|------|---------|
| `src/api-server.ts` | HTTP API server + SSE |
| `src/channels/cli.ts` | Virtual CLI channel (~30 lines) |
| `src/tts.ts` | TTS service (OpenAI TTS API wrapper) |
| `src/cost-tracker.ts` | Budget tracking and enforcement |
| `config/tts-instructions.txt` | Voice affect instructions |
| `tui/` | Entire Textual TUI Python application |

### New SQLite Tables

| Table | Purpose |
|-------|---------|
| `tts_usage` | Per-request TTS usage tracking |
| `tts_budgets` | Budget thresholds (daily/weekly/monthly, tokens + USD) |

### New Dependencies

**Node.js (NanoClaw):** None expected — Node.js has a built-in HTTP server (`node:http`).

**Python (TUI):**
- `textual` — TUI framework
- `httpx` — HTTP client with SSE support
- `sounddevice` or `pyaudio` — microphone capture
