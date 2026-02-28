"""Discover solo mode chapter IDs via local ClientWork + targeted API scan.

Run with:  python -m tools.solo_info

Step 1: Read gate IDs from ClientWork (instant, no server calls)
Step 2: Scan each gate's chapter range via Solo_detail (targeted, fast)
"""

from __future__ import annotations

import json
import os
import sys
import time

from memory.frida_il2cpp import FridaIL2CPP

_CHAPTERS_PATH = os.path.join(os.path.dirname(__file__), "solo_chapters.json")


def main() -> None:
    frida = FridaIL2CPP()
    if not frida.attach():
        print("Failed to attach Frida. Is the game running?")
        sys.exit(1)

    print("=" * 60)
    print("Solo Chapter Scanner (local + targeted)")
    print("=" * 60)

    # Step 1: Get all gate IDs from ClientWork (instant)
    print("\nReading gate data from ClientWork...")
    master = frida._api.get_solo_master_data()
    if "error" in master:
        print(f"Error: {master['error']}")
        frida.detach()
        sys.exit(1)

    gate_ids = master["gateIds"]
    print(f"Found {len(gate_ids)} gates: {gate_ids}")

    # Step 2: Scan each gate for chapters via Solo_detail
    print(f"\nScanning {len(gate_ids)} gates for chapters...")
    all_chapters: list[int] = []

    try:
        for i, gate in enumerate(gate_ids):
            base = gate * 10000
            print(f"  [{i+1}/{len(gate_ids)}] Gate {gate}: ", end="", flush=True)

            # Scan chapters 1-50 in this gate
            result = frida._api.scan_chapters(base + 1, base + 50)
            valid = result.get("valid", []) if "error" not in result else []

            if valid:
                all_chapters.extend(valid)
                print(f"{len(valid)} chapters: {valid}")
            else:
                # Might be a high-chapter gate (like 170095+)
                # Use master data hints to find chapter range
                hints = master["gateChapters"].get(str(gate), [])
                if hints:
                    min_ch = min(hints)
                    offset = min_ch - base
                    # Scan around the hinted range
                    start = base + max(1, offset - 5)
                    end = base + offset + 50
                    print(f"(hinted {min_ch}) scanning {start}-{end}...", end=" ", flush=True)
                    result2 = frida._api.scan_chapters(start, end)
                    valid2 = result2.get("valid", []) if "error" not in result2 else []
                    if valid2:
                        all_chapters.extend(valid2)
                        print(f"{len(valid2)} chapters: {valid2}")
                    else:
                        print("0")
                else:
                    print("0")

            time.sleep(1.0)

    except Exception as exc:
        print(f"\nError: {exc}")
    finally:
        frida.detach()

    # Save results
    all_chapters = sorted(set(all_chapters))
    print(f"\n{'=' * 60}")
    print(f"Total: {len(all_chapters)} chapters in {len(gate_ids)} gates")

    gates_map: dict[int, list[int]] = {}
    for cid in all_chapters:
        g = cid // 10000
        gates_map.setdefault(g, []).append(cid)
    for g in sorted(gates_map):
        print(f"  Gate {g}: {gates_map[g]}")

    with open(_CHAPTERS_PATH, "w") as f:
        json.dump({"chapters": all_chapters, "count": len(all_chapters)}, f, indent=2)
    print(f"\nSaved {len(all_chapters)} chapters to {_CHAPTERS_PATH}")
    print("=" * 60)


if __name__ == "__main__":
    main()
