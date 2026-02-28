# Master Duel Autoly

Auto farm solo mode and instant win for Yu-Gi-Oh! Master Duel. Runs in background, no clicking needed.

## Features

- **Instant Win** — kill opponent LP instantly
- **Auto Solo Farm** (in development) — auto completes solo chapters for gems and XP
- **Session Save** — remembers progress per account, picks up after crash

## Setup

```
pip install frida frida-tools keyboard pywin32 colorama rich
```

## Run

Start the game first, then:

```
python main.py
```

| Key | What |
|-----|------|
| F1 | Toggle instant win |
| F2 | Start/stop auto solo |
| F5 | Instant win once |
| F12 | Quit |

First time? Run `python -m tools.solo_info` to scan chapters.

## Roadmap

- Reveal enemy cards (see opponent's hand/set cards)
