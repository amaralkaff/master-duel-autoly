# Master Duel Autoly

Instant win tool for Yu-Gi-Oh! Master Duel. Runs in background, no clicking needed.

## Features

- **Instant Win** — kill opponent LP instantly (auto or one-shot)
- **Reveal Cards** — see opponent's hand and face-down cards during a duel

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
| F3 | Toggle reveal cards |
| F5 | Instant win once |
| F12 | Quit |
