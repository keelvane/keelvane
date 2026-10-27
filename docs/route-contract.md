# Route and checkpoint contract (draft 2026-10-26)

Draft for review by the private runtime owner before any field is frozen. Nothing here is wired into Keelvane yet. It describes the shapes a host passes between three parts: the route selector, the lead engine, and the record keeper.

## Roles

- **Record keeper** (the host): owns the conversation id, permissions, checkpoints and results. The conversation id never changes when the route changes.
- **Selector** (`routing.mjs`): picks one lead route per run from the eligible pool. It schedules nothing below the lead.
- **Lead engine**: runs the turn and may use its own native workers only when that engine's confinement test has passed. Until then native workers stay off.

## Route input

```json
{
  "id": "route-a",
  "engine": "claude | codex",
  "capabilities": ["code", "files", "web"],
  "available": true,
  "usage": {
    "remainingPercent": 62,
    "resetsAt": "2026-10-27T05:00:00Z",
    "observedAt": "2026-10-26T22:10:00Z"
  }
}
```

- `usage` may be absent or have `remainingPercent: null`. That route is **unknown**, never guessed.
- A provider may report several windows (for example a rolling window and a weekly one); the tightest window counts.
- `remainingPercent: 0` with a `resetsAt` still in the future means exhausted: the route is excluded.
- An observation older than 15 minutes is treated as unknown, not as current.

## Selection rules

1. Filter: available, has every required capability, on the allowlist, not exhausted.
2. Cost from remaining usage: more remaining means lower cost. Below the low threshold (default 15 percent) the cost rises steeply.
3. Unknown usage ranks with a neutral prior cost of 0.5. It is a ranking device only: the reported `remainingPercent`, `routeCost` and `score` stay `null`.
4. Order: route cost, then score (headroom 0.75, recovery 0.20, freshness 0.05), then bounded task fit, then route id.
5. An external decision (`decide`) wins only if it names a route that passed step 1.

## Route output

```json
{
  "routeId": "route-a",
  "source": "policy | decide | policy_fallback",
  "reason": "lowest_route_cost",
  "routeCost": 0.38,
  "score": 0.71,
  "fit": 1,
  "usage": { "state": "available", "remainingPercent": 62, "resetsAt": "...", "observedAt": "..." }
}
```

`reason` is one of `lowest_route_cost`, `decide_route_selection`, `decide_route_invalid_or_ineligible`, `decide_unavailable`, `no_configured_candidate`, `capacity_or_capability_blocked`. With nothing eligible, `routeId` is `null`. `decide` receives the eligible candidates (`routeId`, `remainingPercent`, `routeCost`, capabilities) and is skipped for private projects.

The host records this with the run so every route change is explainable afterwards.

## Checkpoint (continuity across routes)

When the next run lands on a different engine, provider resume ids do not carry over. The host instead hands the new lead a context packet:

```json
{
  "version": 1,
  "conversationId": "c-123",
  "checkpoint": { "text": "summary of state and open work" },
  "recent": [{ "role": "user | assistant", "text": "scrubbed", "at": "..." }],
  "fromRoute": "route-b",
  "sha256": "..."
}
```

- `sha256` covers the checkpoint and `recent` together. The host verifies it before use and fails closed on a mismatch: the run stops with an error rather than continuing without the packet.
- `recent` holds at most the last 7 messages, at most 5000 characters in total, scrubbed of secrets and paths by the host before it is built.
- The packet is quoted to the new lead as prior context, not as instructions.
- Same-engine runs may still pass the provider resume id; the packet is the fallback, not a replacement.

## Open for the runtime owner

- Exact field mapping from the private checkpoint record to this packet.
- Whether `recent` length is fixed at 7 or a host option.
- Score field names, so a public and private implementation report the same thing.
