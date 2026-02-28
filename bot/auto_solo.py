"""Fully automatic solo bot: completes all solo chapters for XP + gems.

Zero manual interaction -- pure IL2CPP API calls, no mouse/cursor needed.

The bot:
1. Loads the chapter list from tools/solo_chapters.json
2. For each chapter: Solo_start -> wait for duel -> LP=0 instant win
3. Auto-advances past win screen via DuelEndMessage.IsNextButtonClicked
4. Hooks auto-dismiss result/clear screens
5. Speeds everything with Time.timeScale (15x)
6. For non-duel chapters: attempts Solo_skip

Works fully in the background -- game window can be minimized.
"""

from __future__ import annotations

import json
import os
import threading

from memory.frida_il2cpp import FridaIL2CPP
from ui.bot_state import BotState
from bot.session_db import SessionDB
from config import (
    AUTO_SOLO_MAX_SKIP,
    AUTO_SOLO_TIME_SCALE,
)
from utils import logger

_CHAPTERS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "tools", "solo_chapters.json",
)


def _gate_id(chapter_id: int) -> int:
    """Derive gate ID from chapter ID (e.g. 30009 -> 3, 710001 -> 71)."""
    return chapter_id // 10000


class AutoSolo:
    def __init__(self, frida: FridaIL2CPP, state: BotState, **_kw) -> None:
        self.frida = frida
        self.state = state
        self._stop = threading.Event()
        self._current_gate: int = -1
        self._db: SessionDB | None = None

    def stop(self) -> None:
        self._stop.set()

    def reset(self) -> None:
        self._stop.clear()

    # ── Main loop ──

    def run(self) -> None:
        """Pure API-based solo bot. No mouse interaction needed."""
        logger.info("Auto-solo: starting (API mode, no cursor)...")

        # Ensure Frida is alive
        if not self.frida.is_attached():
            self.state.auto_solo_status = "Reconnecting Frida..."
            if not self.frida.reattach():
                logger.error("Frida not attached. Cannot start auto-solo.")
                self._finish()
                return

        # Startup recovery: dismiss error dialogs + clean stuck VCs
        self.state.auto_solo_status = "Startup cleanup..."
        self.frida.dismiss_all_dialogs()
        self._sleep(0.5)
        if not self.frida.clean_vc_stack():
            # VC stack couldn't be cleaned — reboot the game
            logger.warn("Startup: game in bad state, rebooting...")
            self._reboot_and_reattach()
            if not self.frida.is_attached():
                logger.error("Startup reboot failed. Cannot start.")
                self._finish()
                return

        # Install result-screen auto-dismiss hooks
        self.frida.hook_result_screens()

        # Load chapter list + session DB
        all_chapters = self._load_chapters()
        if not all_chapters:
            logger.error("No chapters to process.")
            self._finish()
            return

        self._db = SessionDB()
        completed = self._db.get_completed()
        chapters = [c for c in all_chapters if c not in completed]

        db_stats = self._db.stats()
        logger.info(
            f"Session ({self._db.user_id}): "
            f"{len(completed)} done previously, "
            f"{len(chapters)} remaining "
            f"(of {len(all_chapters)} total)"
        )

        self.state.auto_solo_total = len(all_chapters)
        self.state.auto_solo_done = len(completed)
        self.state.auto_solo_skipped = db_stats.get("skipped", 0)

        # Speed up the game
        self.frida.set_time_scale(AUTO_SOLO_TIME_SCALE)

        consecutive_fails = 0

        for i, chapter_id in enumerate(chapters):
            if self._stopped():
                break

            # Re-check Frida health periodically
            if not self.frida.is_attached():
                self.state.auto_solo_status = "Reconnecting Frida..."
                if not self.frida.reattach():
                    logger.error("Frida reconnect failed. Stopping.")
                    break
                # Re-install hooks after reattach
                self.frida.hook_result_screens()
                self.frida.set_time_scale(AUTO_SOLO_TIME_SCALE)

            self.state.auto_solo_chapter_id = chapter_id
            self.state.auto_solo_status = (
                f"Chapter {chapter_id} ({i + 1}/{len(chapters)})"
            )
            logger.info(f"--- Chapter {chapter_id} ({i + 1}/{len(chapters)}) ---")

            result = self._try_chapter(chapter_id)

            if result == "won":
                self.state.auto_solo_duels_won += 1
                self.state.auto_solo_done += 1
                consecutive_fails = 0
                self._db.mark(chapter_id, "won")
                logger.ok(
                    f"Chapter {chapter_id} WON "
                    f"(total: {self.state.auto_solo_duels_won})"
                )
            elif result == "skipped":
                # Story chapter — skipped via Solo_skip, no recovery needed
                self.state.auto_solo_skipped += 1
                self.state.auto_solo_done += 1
                consecutive_fails = 0
                self._db.mark(chapter_id, "skipped")
            else:
                # Duel failed — need recovery
                self.state.auto_solo_duels_failed += 1
                consecutive_fails += 1
                logger.warn(
                    f"Chapter {chapter_id} failed — recovering..."
                )
                self._dismiss_and_recover()

            # Brief pause between chapters to let the game breathe
            self._sleep(1.0)

            if consecutive_fails >= AUTO_SOLO_MAX_SKIP:
                logger.warn(
                    f"Too many consecutive failures ({AUTO_SOLO_MAX_SKIP}). "
                    "Stopping."
                )
                break

        self._finish()

    # ── Chapter processing ──

    def _try_chapter(self, chapter_id: int) -> str:
        """Try to complete a single chapter.

        Strategy:
        1. Solo_skip — handles already-completed chapters
        2. Server-side completion (Solo_start -> Duel_begin -> Duel_end)
           - If Duel_begin fails: story chapter, try Solo_skip again
           - If Duel_end rejected: real duel, use RetryDuel + LP=0
        3. RetryDuel + instant win — only for confirmed duel chapters

        Returns "won", "skipped", or "failed".
        """
        gate = _gate_id(chapter_id)
        if gate != self._current_gate:
            logger.info(f"Switching to gate {gate}...")
            self.frida.call_solo_api_fire_and_forget("Solo_gate_entry", gate)
            self._sleep(1.0)
            self._current_gate = gate

        # Step 1: Try Solo_skip (already completed chapters)
        self.state.auto_solo_status = f"Skip({chapter_id})..."
        skip_result = self.frida.call_api_with_result("Solo_skip", chapter_id)
        if skip_result and skip_result.get("code") == 0:
            logger.info(f"Chapter {chapter_id} skipped via Solo_skip")
            self._sleep(0.3)
            return "skipped"

        # Step 2: Probe chapter type
        self.state.auto_solo_status = f"Probing({chapter_id})..."
        is_duel = self._probe_chapter_type(chapter_id, gate)

        if not is_duel:
            # Not a duel chapter — try Solo_skip again
            skip2 = self.frida.call_api_with_result("Solo_skip", chapter_id)
            if skip2 and skip2.get("code") == 0:
                logger.info(f"Chapter {chapter_id} completed via skip")
                self._sleep(0.3)
                return "skipped"
            logger.info(f"Chapter {chapter_id} is not a duel, can't skip — skipping")
            return "skipped"

        # Step 3: Confirmed duel chapter — use RetryDuel + instant win
        self.state.auto_solo_status = f"RetryDuel({chapter_id})..."
        retry_ok = self.frida.retry_solo_duel(chapter_id, is_rental=True)
        if not retry_ok:
            logger.debug(f"RetryDuel failed for {chapter_id}")
            return "failed"

        # Wait for the duel engine to become active
        self.state.auto_solo_status = f"Waiting for duel ({chapter_id})..."
        if not self._wait_for_duel(timeout=15.0):
            logger.warn(f"Duel didn't start for {chapter_id} — treating as done")
            self.frida.clean_vc_stack()
            return "skipped"

        # Wait for LP to initialize, then instant-win
        self._sleep(2.0)
        self.state.auto_solo_status = f"LP=0 ({chapter_id})..."
        self._do_instant_win()

        # Auto-advance the duel end message
        self.state.auto_solo_status = f"Advancing ({chapter_id})..."
        self._advance_duel_end_loop(timeout=30.0)

        # Wait for duel engine to go inactive (scene transition)
        if not self._wait_for_duel_end(timeout=60.0):
            logger.warn(f"Duel didn't end for chapter {chapter_id}")
            return "failed"

        # Wait for result screens to auto-dismiss via hooks + timeScale
        self.state.auto_solo_status = f"Results ({chapter_id})..."
        self._sleep(5.0)

        # Clean up any leftover result VCs from the stack
        self.frida.clean_vc_stack()
        self._sleep(1.0)

        return "won"

    def _probe_chapter_type(self, chapter_id: int, gate: int) -> bool:
        """Probe whether a chapter is a duel (lightweight, no state change).

        Uses Solo_set_use_deck_type as probe:
        - code=0  -> chapter accepts a deck = duel chapter
        - code!=0 -> story/dialog chapter (no deck needed)

        Returns True for duel, False for story.
        """
        result = self.frida.call_api_two_args(
            "Solo_set_use_deck_type", chapter_id, 1
        )
        if result and result.get("code") == 0:
            logger.info(f"Chapter {chapter_id}: duel chapter (deck type OK)")
            return True

        code = result.get("code") if result else "rpc_fail"
        logger.info(f"Chapter {chapter_id}: story chapter (deck code={code})")
        return False

    # ── Duel helpers ──

    def _do_instant_win(self) -> None:
        """Set opponent LP to 0. Retries a few times."""
        for attempt in range(10):
            if self._stopped() or not self.frida.is_duel_active():
                break
            if self.frida.instant_win():
                break
            self._sleep(0.5)

    def _advance_duel_end_loop(self, timeout: float = 30.0) -> None:
        """Repeatedly set DuelEndMessage.IsNextButtonClicked = true.

        Runs until the duel engine goes inactive or timeout.
        """
        elapsed = 0.0
        while elapsed < timeout and not self._stopped():
            if not self.frida.is_duel_active():
                break
            self.frida.advance_duel_end()
            self.frida.dismiss_all_dialogs()
            self._sleep(0.3)
            elapsed += 0.3

    # ── Wait helpers ──

    def _wait_for_duel(self, timeout: float = 20.0) -> bool:
        """Wait until the duel engine becomes active."""
        elapsed = 0.0
        while elapsed < timeout and not self._stopped():
            if self.frida.is_duel_active():
                return True
            self.frida.dismiss_all_dialogs()
            self._sleep(0.5)
            elapsed += 0.5
        return False

    def _wait_for_duel_end(self, timeout: float = 60.0) -> bool:
        """Wait until the duel engine becomes inactive."""
        elapsed = 0.0
        while elapsed < timeout and not self._stopped():
            if not self.frida.is_duel_active():
                logger.info("Duel engine inactive.")
                return True
            self.frida.dismiss_all_dialogs()
            self._sleep(0.5)
            elapsed += 0.5
        return False

    # ── Error recovery ──

    def _dismiss_and_recover(self) -> None:
        """Recover from a failed chapter.

        Strategy: dismiss dialogs + clean VC stack (no reboot).
        Falls back to reboot + reattach only if cleaning fails.
        """
        self.state.auto_solo_status = "Recovering..."

        # Step 1: Dismiss error dialogs
        self.frida.dismiss_all_dialogs()
        self._sleep(0.5)

        # Step 2: Clean the VC stack (remove stuck SSPVs)
        if self.frida.clean_vc_stack():
            logger.ok("Recovery: VC stack cleaned successfully.")
            self._sleep(0.5)
            return

        # Step 3: If cleaning failed, try reboot as last resort
        logger.warn("Recovery: VC stack clean failed, rebooting...")
        self._reboot_and_reattach()

    def _reboot_and_reattach(self) -> None:
        """Reboot the game and reattach Frida."""
        self.state.auto_solo_status = "Rebooting game..."
        self.frida.force_reboot()

        self.state.auto_solo_status = "Waiting for game restart..."
        self._sleep(30.0)

        self.state.auto_solo_status = "Reattaching Frida..."
        for attempt in range(5):
            if self._stopped():
                return
            logger.info(f"Reattach attempt {attempt + 1}/5...")
            if self.frida.reattach():
                break
            self._sleep(5.0)

        if not self.frida.is_attached():
            logger.error("Failed to reattach Frida after reboot.")
            return

        # Re-install everything
        self.frida.hook_result_screens()
        self.frida.set_time_scale(AUTO_SOLO_TIME_SCALE)
        self._current_gate = -1
        logger.ok("Reboot recovery complete — Frida reattached.")

    # ── Utilities ──

    def _load_chapters(self) -> list[int]:
        """Load chapter IDs from tools/solo_chapters.json."""
        if not os.path.exists(_CHAPTERS_PATH):
            logger.error(f"Chapter list not found: {_CHAPTERS_PATH}")
            return []
        try:
            with open(_CHAPTERS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            chapters = data.get("chapters", [])
            logger.info(f"Loaded {len(chapters)} chapter IDs.")
            return chapters
        except Exception as exc:
            logger.error(f"Failed to load chapters: {exc}")
            return []

    def _stopped(self) -> bool:
        return self._stop.is_set() or self.state.stop_event.is_set()

    def _sleep(self, seconds: float) -> None:
        self._stop.wait(seconds)

    def _finish(self) -> None:
        """Clean up when the bot stops."""
        self.frida.set_time_scale(1.0)
        if self._db:
            stats = self._db.stats()
            logger.info(
                f"Auto-solo stopped: {self.state.auto_solo_duels_won} won, "
                f"{self.state.auto_solo_duels_failed} failed, "
                f"{self.state.auto_solo_skipped} skipped | "
                f"DB total: {stats}"
            )
            self._db.close()
            self._db = None
        else:
            logger.info(
                f"Auto-solo stopped: {self.state.auto_solo_duels_won} won, "
                f"{self.state.auto_solo_duels_failed} failed, "
                f"{self.state.auto_solo_skipped} skipped"
            )
        self.state.auto_solo_status = "Stopped"
        self.state.auto_solo_enabled = False
