# Live probe by the main agent, 2026-10-13 (plugin build 12ffedbd9389 = dist; hub pid 24560 older than dist)

Sandbox frame at (-30000,-30000) on page "IG Motion — Dummy", deleted afterwards.

| Probe | Result |
|---|---|
| 3 tracks in one figma_set_keyframes on a fresh rectangle | all 3 landed |
| 3 tracks again on the same node (overwriting) | all 3 landed |
| 3 tracks + timelineDuration 14.4 on another node | all 3 landed; timeline id = frame id |
| nested container > clipping mask frame with LAYER_BLUR: HEIGHT + effect:0:RADIUS + TRANSLATION_Y | all landed |
| figma_batch: set_keyframes (3 tracks + timelineDuration) + set_keyframes (2 tracks) + move_nodes x,y | all landed, x and y both applied |
| move_nodes x,y on a node with TRANSLATION_X and SCALE tracks | both applied |
| after a figma_export_video of the frame: motion context ids and a 3-track rewrite | ids unchanged, all landed |
| twin id 30:14989 (the old ad's timeline id, readable on 2026-10-09) | now NOT readable; a write says NODE_NOT_FOUND |
| motion context on the new ad today | timeline id = frame id 42:15039 (on 2026-10-09 a builder saw 42:15160) |

Conclusions:
- The multi-track, x/y and batch-move defects do NOT reproduce on a consistent build. On 2026-10-09 the integrator rebuilt dist/ mid-run while the plugin ran the old bundle, and the hub changed process twice (46024 -> 25804 -> 24560, the later ones spawned from the new dist by spikes/mcp-client.mjs). Build skew between hub and plugin is the leading explanation. Guard against it: writes should warn (or refuse) when the hub's build differs from the plugin's.
- Twin ids are real and transient: node.getTopLevelFrame().id and timelines[0].id returned ids (30:14989, 42:15160, 45:xxx, 47:559) that differ from the frame's document id while some Figma state lasted, were readable, and could not be written; after a reload they are gone. figma_get_motion_context reports topLevelFrameId from getTopLevelFrame() — it should walk parents to the page child instead, and report the timeline id as a timeline id, never as a node id. NODE_NOT_FOUND on such an id should hint at this.
- Defensive regardless of cause: set_keyframes reads every written track back and reports any that did not land (notLanded) instead of echoing; move_nodes reads x/y back per item.
- Not reproduced either: "keyframes overwrite the resting value" (a Mask frame keyed HEIGHT 60 at t=0 still reads height 80 at rest). Treat as unconfirmed.
