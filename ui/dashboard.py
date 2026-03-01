"""Rich-based live terminal dashboard for Master Duel Bot."""

from __future__ import annotations

from rich.live import Live
from rich.panel import Panel
from rich.text import Text

from memory.frida_il2cpp import FridaIL2CPP
from ui.bot_state import BotState
from ui.log_handler import TuiLogBuffer
from config import TUI_REFRESH_RATE, HOTKEY_INSTANT_WIN, HOTKEY_WIN_NOW, STOP_HOTKEY


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
        status = self.frida.get_duel_status() if (attached and duel_active) else None

        if status:
            myself = status.get("myself", 0)
            rival = status.get("rival", 1)
            my_lp = status["lp"][myself]
            rival_lp = status["lp"][rival]
            lines.append_text(Text.from_markup(f"  Duel Active: [green]Yes[/]\n"))
            lines.append_text(Text.from_markup(f"  My LP:       {my_lp}\n"))
            lines.append_text(Text.from_markup(f"  Rival LP:    {rival_lp}\n"))
            lines.append_text(Text.from_markup(f"  Rival:       Player {rival}\n"))
        else:
            lines.append_text(Text.from_markup(f"  Duel Active: [dim]No[/]\n"))
            lines.append_text(Text.from_markup(f"  My LP:       --\n"))
            lines.append_text(Text.from_markup(f"  Rival LP:    --\n"))

        # -- Features section --
        lines.append_text(Text.from_markup("\n  [bold]-- Features --[/bold]\n"))
        iw = self.state.instant_win_enabled
        iw_label = "[green]ON[/]" if iw else "[red]OFF[/]"
        lines.append_text(Text.from_markup(
            f"  \\[{HOTKEY_INSTANT_WIN}] Instant Win:  {iw_label}\n"
        ))

        # -- Controls section --
        lines.append_text(Text.from_markup("\n  [bold]-- Controls --[/bold]\n"))
        lines.append_text(Text.from_markup(f"  {HOTKEY_INSTANT_WIN}   Toggle instant win\n"))
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
            width=56,
        )

    def run(self) -> None:
        """Block main thread, refreshing the dashboard until stop is set."""
        interval = 1.0 / TUI_REFRESH_RATE
        with Live(self._build_layout(), refresh_per_second=TUI_REFRESH_RATE) as live:
            while not self.state.stop_event.is_set():
                live.update(self._build_layout())
                self.state.stop_event.wait(interval)


def _markup_safe(text: str) -> str:
    """Escape rich markup characters in log text."""
    return text.replace("[", "\\[")
