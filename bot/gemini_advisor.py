"""Gemini AI advisor for duel strategy.

Reads the full board state (hand, field, GY, banished, deck counts, LP)
and provides strategic advice via the F4 Assist hotkey/button.
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING

import os

from config import GEMINI_API_KEY, GEMINI_MODEL
from utils import logger

if TYPE_CHECKING:
    from memory.frida_il2cpp import FridaIL2CPP

# Action type names for readability
ACTION_NAMES = {0x08: "Activate", 0x10: "Summon", 0x40: "SetMonster", 0x80: "SetSpell"}
PHASE_NAMES = {0: "Draw", 1: "Standby", 2: "Main1", 3: "Battle", 4: "Main2", 5: "End"}

ADVISOR_PROMPT = """\
Yu-Gi-Oh! Master Duel coach. Give quick tactical advice.
Be VERY brief (2-3 lines). Just numbered steps.
Example: "1. Summon X 2. Activate Y on Z 3. Battle"
If opponent's turn: what to negate/chain.
"""


class GeminiAdvisor:
    """Gemini-powered duel advisor. Reads board state and gives strategy tips."""

    def __init__(self) -> None:
        self._client = None
        self._types = None
        self._model = GEMINI_MODEL
        self._last_call = 0.0
        self._min_interval = 2.0  # min seconds between API calls
        self._init_client()

    @property
    def has_client(self) -> bool:
        return self._client is not None

    @property
    def model(self) -> str:
        return self._model

    def set_api_key(self, key: str) -> bool:
        """Update the API key at runtime and re-initialize the client."""
        os.environ["GEMINI_API_KEY"] = key
        self._client = None
        self._types = None
        self._init_client(key or None)
        return self.has_client

    def set_model(self, model: str) -> None:
        """Change the model used for queries."""
        self._model = model
        os.environ["GEMINI_MODEL"] = model
        logger.info(f"Gemini model set to: {model}")

    def list_models(self) -> list[str]:
        """Fetch available generateContent models from the API."""
        if not self._client:
            return []
        try:
            models = []
            for m in self._client.models.list():
                if any(a == "generateContent" for a in (m.supported_actions or [])):
                    # Strip "models/" prefix if present
                    name = m.name
                    if name.startswith("models/"):
                        name = name[7:]
                    models.append(name)
            return sorted(models)
        except Exception as e:
            logger.error(f"Failed to list models: {e}")
            return []

    def _init_client(self, api_key: str | None = None) -> None:
        key = api_key if api_key is not None else GEMINI_API_KEY
        if not key:
            logger.warn("Gemini: no API key configured (set GEMINI_API_KEY in .env)")
            return
        try:
            from google import genai
            from google.genai import types
            self._client = genai.Client(api_key=key)
            self._types = types
            logger.ok("Gemini advisor ready")
        except Exception as e:
            logger.error(f"Gemini init failed: {e}")

    def analyze_board(self, frida: FridaIL2CPP) -> str | None:
        """Analyze the board and return strategic advice as plain text."""
        if not self._client or not self._types:
            return None

        now = time.time()
        if now - self._last_call < self._min_interval:
            return "Please wait a moment before asking again."

        board = self._get_board_state(frida)
        if not board:
            return None

        # Get available commands if in a duel
        cmd_result = frida.get_commands()
        commands = cmd_result.get("commands", []) if isinstance(cmd_result, dict) else []
        cmd_list = self._format_commands(commands) if commands else "  (none)"

        phase = cmd_result.get("phase", -1) if isinstance(cmd_result, dict) else -1
        myself = cmd_result.get("myself", 0) if isinstance(cmd_result, dict) else 0
        turn_player = cmd_result.get("turnPlayer", -1) if isinstance(cmd_result, dict) else -1
        my_turn = (myself == turn_player)
        phase_name = PHASE_NAMES.get(phase, str(phase))

        prompt = (
            f"{json.dumps(board, separators=(',', ':'))}\n"
            f"Phase:{phase_name} MyTurn:{my_turn}\n"
            f"Commands:\n{cmd_list}\n"
            "Quick advice?"
        )

        self._last_call = time.time()
        try:
            resp = self._client.models.generate_content(
                model=self._model,
                contents=prompt,
                config=self._types.GenerateContentConfig(
                    system_instruction=ADVISOR_PROMPT,
                    temperature=0.3,
                    max_output_tokens=512,
                    thinking_config=self._types.ThinkingConfig(thinking_budget=0),
                ),
            )
            return resp.text.strip()
        except Exception as e:
            logger.error(f"Gemini advisor query failed: {e}")
            return None

    # -- Internal helpers --

    def _get_board_state(self, frida: FridaIL2CPP) -> dict | None:
        """Get board state with card descriptions for Gemini context."""
        gs = frida.get_game_state()
        if not gs:
            return None

        def card_detail(cards: list) -> list[dict]:
            """Name + effect text for hand/field cards the AI needs to understand."""
            result = []
            for c in cards:
                name = c.get("name") or f"id:{c.get('cardId', '?')}"
                entry = {"name": name}
                desc = c.get("desc")
                if desc:
                    entry["effect"] = desc
                result.append(entry)
            return result

        def names(cards: list) -> list[str]:
            return [c.get("name") or f"id:{c.get('cardId', '?')}" for c in cards]

        def field_summary(field: dict) -> list[dict]:
            return card_detail(
                field.get("monsters", [])
                + field.get("spells", [])
                + field.get("extraMonsters", [])
            )

        return {
            "myLP": gs.get("myLP", "?"),
            "rivalLP": gs.get("rivalLP", "?"),
            "myHand": card_detail(gs.get("myHand", [])),
            "myField": field_summary(gs.get("myField", {})),
            "rivalField": field_summary(gs.get("rivalField", {})),
            "myGY": names(gs.get("myGY", [])),
            "rivalGY": names(gs.get("rivalGY", [])),
            "myBanished": names(gs.get("myBanished", [])),
            "rivalBanished": names(gs.get("rivalBanished", [])),
            "myDeckCount": gs.get("myDeckCount", "?"),
            "myExtraDeckCount": gs.get("myExtraDeckCount", "?"),
            "rivalDeckCount": gs.get("rivalDeckCount", "?"),
            "turnNum": gs.get("turnNum", "?"),
        }

    def _format_commands(self, commands: list[dict]) -> str:
        """Format commands into readable list for Gemini."""
        lines = []
        for i, cmd in enumerate(commands):
            name = cmd.get("name") or f"Unknown(id={cmd.get('cardId', '?')})"
            actions = []
            mask = cmd["mask"]
            for bit, label in ACTION_NAMES.items():
                if mask & bit:
                    actions.append(label)
            zone_label = self._zone_label(cmd["zone"])
            lines.append(
                f"  [{i}] {name} | zone={zone_label} | actions={','.join(actions)}"
            )
        return "\n".join(lines) if lines else "  (none)"

    @staticmethod
    def _zone_label(zone: int) -> str:
        if zone == 13:
            return "Hand"
        if 1 <= zone <= 5:
            return f"Monster{zone}"
        if 6 <= zone <= 10:
            return f"Spell{zone - 5}"
        if zone in (11, 12):
            return f"ExtraMonster{zone - 10}"
        return str(zone)
