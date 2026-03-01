# Master Duel Autoly

A tool for Yu-Gi-Oh! Master Duel with AI-powered duel advisor, instant win, card reveal, and autopilot features. Uses Frida to hook the game's IL2CPP runtime.

## Features

- **AI Duel Advisor** — Gemini-powered real-time strategy advice. Reads your hand, field, GY, banished, LP, and card effects. Gives step-by-step play recommendations during live duels (Solo & PvP).
- **Instant Win** — Set opponent LP to 0 instantly (toggle or one-shot).
- **Reveal Cards** — See opponent's hand and face-down cards during a duel.
- **Autopilot** — AI vs AI mode for Solo duels (CPU hook).

## Setup

### Requirements

- Python 3.10+
- Yu-Gi-Oh! Master Duel (Steam)
- Windows 10/11

### Install

```
pip install -r requirements.txt
```

### Gemini AI Setup (Optional)

Create a `.env` file in the project root:

```
GEMINI_API_KEY=your_api_key_here
```

Get a free API key from [Google AI Studio](https://aistudio.google.com/apikey).

## Usage

Start the game first, then run:

```
python main.py
```

### Hotkeys

| Key  | Action              |
|------|---------------------|
| F1   | Toggle Instant Win  |
| F2   | Toggle Autopilot    |
| F3   | Toggle Reveal Cards |
| F4   | AI Duel Advisor     |
| F5   | Instant Win (once)  |
| F12  | Quit                |

### AI Advisor

Press **F4** or click the **Ask AI** button during a duel. The advisor reads the full board state including card effects and available commands, then provides strategic advice like:

- Optimal play sequence for your turn
- What to negate or chain to on opponent's turn
- Threat identification and counter-play
- Deck archetype recognition

## Disclaimer

For educational and personal use only. Use at your own risk.
