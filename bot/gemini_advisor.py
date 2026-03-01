"""Gemini AI advisor for duel strategy.

Reads the full board state (hand, field, GY, banished, deck counts, LP)
and provides strategic advice via the F4 Assist hotkey/button.
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING

from config import GEMINI_API_KEY, GEMINI_MODEL
from utils import logger

if TYPE_CHECKING:
    from memory.frida_il2cpp import FridaIL2CPP

# Action type names for readability
ACTION_NAMES = {0x08: "Activate", 0x10: "Summon", 0x40: "SetMonster", 0x80: "SetSpell"}
PHASE_NAMES = {0: "Draw", 1: "Standby", 2: "Main1", 3: "Battle", 4: "Main2", 5: "End"}

ADVISOR_PROMPT = """\
You are an expert Yu-Gi-Oh! Master Duel coach. The player is asking for your advice \
during a live duel. Analyze the board state and give clear, actionable advice.

RULES:
- Keep your response SHORT (3-5 lines max). The player needs to act fast.
- Tell the player exactly what to do step by step.
- Identify the opponent's deck archetype if possible from their cards.
- Warn about threats (cards that could negate, destroy, or disrupt).
- Suggest which hand traps to save and when to use them.
- If it's the player's turn: suggest the optimal play sequence.
- If it's the opponent's turn: suggest what to negate/chain to.
- Be direct. No fluff. Example: "1. Summon X  2. Activate Y targeting Z  3. Go to Battle"
"""


class GeminiAdvisor:
    """Gemini-powered duel advisor. Reads board state and gives strategy tips."""

    def __init__(self) -> None:
        self._client = None
        self._types = None
        self._last_call = 0.0
        self._min_interval = 2.0  # min seconds between API calls
        self._init_client()

    def _init_client(self) -> None:
        if not GEMINI_API_KEY:
            logger.warn("Gemini: no API key configured (set GEMINI_API_KEY in .env)")
            return
        try:
            from google import genai
            from google.genai import types
            self._client = genai.Client(api_key=GEMINI_API_KEY)
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
            f"BOARD STATE:\n{json.dumps(board, indent=2)}\n\n"
            f"CURRENT PHASE: {phase_name}\n"
            f"MY TURN: {my_turn}\n\n"
            f"AVAILABLE COMMANDS:\n{cmd_list}\n\n"
            "What should I do? Give me a short, step-by-step game plan."
        )

        self._last_call = time.time()
        try:
            resp = self._client.models.generate_content(
                model=GEMINI_MODEL,
                contents=prompt,
                config=self._types.GenerateContentConfig(
                    system_instruction=ADVISOR_PROMPT,
                    temperature=0.5,
                    max_output_tokens=2048,
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

        def card_info(cards: list) -> list[dict]:
            """Return card name + description for each card."""
            result = []
            for c in cards:
                name = c.get("name") or f"Unknown(id={c.get('cardId', '?')})"
                entry = {"name": name}
                desc = c.get("desc")
                if desc:
                    entry["effect"] = desc
                result.append(entry)
            return result

        def card_names_only(cards: list) -> list[str]:
            """Just names for GY/banished (descriptions would be too long)."""
            return [c.get("name") or f"Unknown(id={c.get('cardId', '?')})" for c in cards]

        def field_summary(field: dict) -> dict:
            return {
                "monsters": card_info(field.get("monsters", [])),
                "spells": card_info(field.get("spells", [])),
                "extraMonsters": card_info(field.get("extraMonsters", [])),
            }

        return {
            "myLP": gs.get("myLP", "?"),
            "rivalLP": gs.get("rivalLP", "?"),
            "myHand": card_info(gs.get("myHand", [])),
            "myField": field_summary(gs.get("myField", {})),
            "rivalField": field_summary(gs.get("rivalField", {})),
            "myGY": card_names_only(gs.get("myGY", [])),
            "rivalGY": card_names_only(gs.get("rivalGY", [])),
            "myBanished": card_names_only(gs.get("myBanished", [])),
            "rivalBanished": card_names_only(gs.get("rivalBanished", [])),
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
