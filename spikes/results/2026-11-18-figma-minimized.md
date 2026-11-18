# Figxel while Figma desktop is minimized — 2026-11-18

Measured on Windows 11 with Figma desktop 126.11.9, the plugin connected to a team's hub (Figxel Cloud), in a test file. A small MCP client started the Figxel server over stdio, timed each call, and minimized and restored Figma's main window itself (`ShowWindow`), so nobody touched the window during a run.

## Light calls, no switches (Figma started the usual way)

A read (`figma_get_node`), a scan (`figma_scan_nodes_by_types`), a write (`figma_rename_node` to the same name) and a PNG render (`figma_export_node`), every minute for 8 minutes while minimized. The plugin stayed connected the whole time.

| | read | scan | write | render |
|---|---|---|---|---|
| restored | 303 ms | 799 ms | 561 ms | 272 ms |
| minimized, minutes 0–8 | 260–290 ms | 468–521 ms | 213–270 ms | 268–932 ms |

A second run left Figma minimized for 30 minutes with no calls. The plugin was signed out at the end, but the hub had restarted during the run and the hub then ran 0.3.0, which did not read a plugin's browser sign-in back after a restart (fixed in 0.4.0). That run says nothing about minimizing.

## Heavy work and a video, with Chromium's background switches

Figma started from a shortcut whose target is `%LOCALAPPDATA%\Figma\Figma.exe` with:

```text
--disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows
```

Figma's main process carried all three switches, and every renderer process carried `--disable-background-timer-throttling` (`Get-CimInstance Win32_Process`).

A frame of 3,000 rectangles in 50 auto-layout frames, then four calls that walk it, timed restored and again after 7 minutes minimized with no calls in between:

| | scan (`types: RECTANGLE`) | `figma_check_layout` | `figma_get_design_context` (4,000 nodes) | `figma_export_node` |
|---|---|---|---|---|
| restored | 545 ms | 3,390 ms | 3,477 ms | 1,223 ms |
| after 7 min minimized | 592 ms | 6,725 ms | 3,650 ms | 1,188 ms |

A video export (`figma_export_video`, a 1080 × 1350 animated frame at 540 px wide, MP4, 24 fps, job mode), restored and after 7 minutes minimized:

| | render |
|---|---|
| restored | 17.6 s |
| after 7 min minimized | 10.3 s |

The rollback at the end of the heavy run was refused (`ROLLBACK_BLOCKED`); the frame was deleted by its id instead. Why a rollback after a 3,000-layer build is refused is not yet investigated.

## Not measured yet

- Heavy work and a video export after more than 5 minutes minimized **without** the switches.
- Minimized for longer than 8 minutes.
- macOS.
