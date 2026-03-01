"""Rich-based live terminal dashboard for Master Duel Bot."""

from __future__ import annotations

from rich.live import Live
from rich.panel import Panel
from rich.text import Text

from memory.frida_il2cpp import FridaIL2CPP
from ui.bot_state import BotState
from ui.log_handler import TuiLogBuffer
from config import (
    TUI_REFRESH_RATE, HOTKEY_INSTANT_WIN, HOTKEY_AUTOPILOT,
    HOTKEY_REVEAL, HOTKEY_WIN_NOW, STOP_HOTKEY,
)


class Dashboard:
    """Live-updating terminal dashboard."""

    def __init__(
        self,
        frida_session: FridaIL2CPP,
        hwnd: int,
        bot_state: BotState,
        log_buf: TuiLogBuffer,
    ) -> None:
        self.frida = frida_session
        self.hwnd = hwnd
        self.state = bot_state
        self.log_buf = log_buf

    def _build_layout(self) -> Panel:
        lines = Text()

        # -- Status section --
        attached = self.frida.is_attached()
        dot_attach = "[green]@[/]" if attached else "[red]@[/]"
        lines.append_text(Text.from_markup(
            f"  Status: {dot_attach} {'Attached' if attached else 'Detached'}\n"
        ))
        lines.append_text(Text.from_markup(
            f"  Window: masterduel (HWND: {hex(self.hwnd)})\n"
        ))
        dot_frida = "[green]@[/]" if attached else "[red]@[/]"
        lines.append_text(Text.from_markup(
            f"  Frida:  {dot_frida} {'Connected' if attached else 'Disconnected'}\n"
        ))

        # -- Duel section --
        lines.append_text(Text.from_markup("\n  [bold]-- Duel --[/bold]\n"))

        duel_active = self.frida.is_duel_active() if attached else False
        gs = self.frida.get_game_state() if (attached and duel_active) else None

        if gs:
            lines.append_text(Text.from_markup(f"  Duel Active: [green]Yes[/]\n"))
            lines.append_text(Text.from_markup(f"  My LP:       {gs['myLP']}\n"))
            lines.append_text(Text.from_markup(f"  Rival LP:    {gs['rivalLP']}\n"))
            phase_name = _phase_name(gs.get("phase", -1))
            turn_who = "Mine" if gs.get("turnPlayer") == gs.get("myself") else "Rival"
            lines.append_text(Text.from_markup(
                f"  Turn {gs.get('turnNum', '?')} | {phase_name} | {turn_who}'s turn\n"
            ))

            # -- My Hand --
            my_hand = gs.get("myHand", [])
            lines.append_text(Text.from_markup(
                f"\n  [bold]-- My Hand ({len(my_hand)}) --[/bold]\n"
            ))
            if my_hand:
                for c in my_hand:
                    label = c.get("name") or str(c.get("cardId", "?"))
                    lines.append_text(Text.from_markup(
                        f"    {_markup_safe(label)}\n"
                    ))
            else:
                lines.append_text(Text.from_markup("    [dim](empty)[/]\n"))

            # -- My Field --
            my_field = gs.get("myField", {})
            my_mons = my_field.get("monsters", [])
            my_sp = my_field.get("spells", [])
            my_em = my_field.get("extraMonsters", [])
            total_field = len(my_mons) + len(my_sp) + len(my_em)
            lines.append_text(Text.from_markup(
                f"\n  [bold]-- My Field ({total_field}) --[/bold]\n"
            ))
            for c in my_mons + my_em:
                label = c.get("name") or str(c.get("cardId", "?"))
                pos = "ATK" if c.get("face") else "SET"
                lines.append_text(Text.from_markup(
                    f"    \\[{c.get('zone','?')}] {_markup_safe(label)} ({pos})\n"
                ))
            for c in my_sp:
                label = c.get("name") or str(c.get("cardId", "?"))
                pos = "UP" if c.get("face") else "SET"
                lines.append_text(Text.from_markup(
                    f"    \\[{c.get('zone','?')}] {_markup_safe(label)} ({pos})\n"
                ))
            if total_field == 0:
                lines.append_text(Text.from_markup("    [dim](empty)[/]\n"))

            # -- Rival Field --
            r_field = gs.get("rivalField", {})
            r_mons = r_field.get("monsters", [])
            r_sp = r_field.get("spells", [])
            r_em = r_field.get("extraMonsters", [])
            r_total = len(r_mons) + len(r_sp) + len(r_em)
            lines.append_text(Text.from_markup(
                f"\n  [bold]-- Rival Field ({r_total}) --[/bold]\n"
            ))
            for c in r_mons + r_em:
                label = c.get("name") or str(c.get("cardId", "?"))
                pos = "ATK" if c.get("face") else "SET"
                lines.append_text(Text.from_markup(
                    f"    \\[{c.get('zone','?')}] {_markup_safe(label)} ({pos})\n"
                ))
            for c in r_sp:
                label = c.get("name") or str(c.get("cardId", "?"))
                pos = "UP" if c.get("face") else "SET"
                lines.append_text(Text.from_markup(
                    f"    \\[{c.get('zone','?')}] {_markup_safe(label)} ({pos})\n"
                ))
            if r_total == 0:
                lines.append_text(Text.from_markup("    [dim](empty)[/]\n"))

            # -- GY summary --
            my_gy = gs.get("myGY", [])
            rival_gy = gs.get("rivalGY", [])
            lines.append_text(Text.from_markup(
                f"\n  [bold]-- GY --[/bold]\n"
            ))
            lines.append_text(Text.from_markup(
                f"  My GY ({len(my_gy)}): "
                f"{_markup_safe(', '.join(c.get('name') or str(c.get('cardId','?')) for c in my_gy[:5]))}"
                f"{'...' if len(my_gy) > 5 else ''}\n"
            ))
            lines.append_text(Text.from_markup(
                f"  Rival GY ({len(rival_gy)}): "
                f"{_markup_safe(', '.join(c.get('name') or str(c.get('cardId','?')) for c in rival_gy[:5]))}"
                f"{'...' if len(rival_gy) > 5 else ''}\n"
            ))

            # -- Deck counts --
            lines.append_text(Text.from_markup(
                f"  Deck: {gs.get('myDeckCount', '?')} | "
                f"Extra: {gs.get('myExtraDeckCount', '?')} | "
                f"Rival Deck: {gs.get('rivalDeckCount', '?')}\n"
            ))
        else:
            lines.append_text(Text.from_markup(f"  Duel Active: [dim]No[/]\n"))
            lines.append_text(Text.from_markup(f"  My LP:       --\n"))
            lines.append_text(Text.from_markup(f"  Rival LP:    --\n"))

        # -- Features section --
        lines.append_text(Text.from_markup("\n  [bold]-- Features --[/bold]\n"))
        ap = self.state.autopilot_enabled
        ap_label = "[green]ON (AI)[/]" if ap else "[red]OFF[/]"
        lines.append_text(Text.from_markup(
            f"  \\[{HOTKEY_AUTOPILOT}] Autopilot:    {ap_label}\n"
        ))
        iw = self.state.instant_win_enabled
        iw_label = "[green]ON[/]" if iw else "[red]OFF[/]"
        lines.append_text(Text.from_markup(
            f"  \\[{HOTKEY_INSTANT_WIN}] Instant Win:  {iw_label}\n"
        ))
        rv = self.state.reveal_enabled
        rv_label = "[green]ON[/]" if rv else "[red]OFF[/]"
        lines.append_text(Text.from_markup(
            f"  \\[{HOTKEY_REVEAL}] Reveal Cards: {rv_label}\n"
        ))

        # -- Controls section --
        lines.append_text(Text.from_markup("\n  [bold]-- Controls --[/bold]\n"))
        lines.append_text(Text.from_markup(f"  {HOTKEY_AUTOPILOT}   Toggle autopilot\n"))
        lines.append_text(Text.from_markup(f"  {HOTKEY_INSTANT_WIN}   Toggle instant win\n"))
        lines.append_text(Text.from_markup(f"  {HOTKEY_REVEAL}   Toggle reveal cards\n"))
        lines.append_text(Text.from_markup(f"  {HOTKEY_WIN_NOW}   Instant win NOW (one-shot)\n"))
        lines.append_text(Text.from_markup(f"  {STOP_HOTKEY}  Quit\n"))

        # -- Log section --
        lines.append_text(Text.from_markup("\n  [bold]-- Log --[/bold]\n"))
        log_lines = self.log_buf.get_lines()
        if log_lines:
            for line in log_lines[-10:]:
                lines.append_text(Text.from_markup(f"  {_markup_safe(line)}\n"))
        else:
            lines.append_text(Text.from_markup("  [dim](no log entries yet)[/]\n"))

        return Panel(
            lines,
            title="[bold]Master Duel Bot[/bold]",
            border_style="blue",
            width=64,
        )

    def run(self) -> None:
        """Block main thread, refreshing the dashboard until stop is set."""
        interval = 1.0 / TUI_REFRESH_RATE
        with Live(self._build_layout(), refresh_per_second=TUI_REFRESH_RATE) as live:
            while not self.state.stop_event.is_set():
                live.update(self._build_layout())
                self.state.stop_event.wait(interval)


_PHASE_NAMES = {
    0: "Draw",
    1: "Standby",
    2: "Main1",
    3: "Battle",
    4: "Main2",
    5: "End",
}


def _phase_name(phase: int) -> str:
    return _PHASE_NAMES.get(phase, f"Phase({phase})")


def _markup_safe(text: str) -> str:
    """Escape rich markup characters in log text."""
    return text.replace("[", "\\[")
