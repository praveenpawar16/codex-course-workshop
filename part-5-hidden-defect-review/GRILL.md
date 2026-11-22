# GRILL.md — Part 5: Hidden defect review

Part 5 starts as a copy of Part 4 for investigation against runtime evidence.
Part 4 remains the protected baseline and must stay unchanged.

## Locked decisions

| Topic | Decision |
| --- | --- |
| Baseline | Copy Part 4 into Part 5; leave Part 4 untouched |
| Scope | Investigation / review exercise on the Part 5 copy only |
| Runtime | Isolate Part 5 on its own ports and database |
| Commit | Do not commit until the investigation exercise asks for it |
| Tests | For this exercise only, concurrency-exposing helpers (including Bidding War) are removed so remaining checks can pass while the defect remains |

## Runtime

- Work only in `part-5-hidden-defect-review`
- Database `auction_part_5` on host port `55432`
- API `3105`, web `5105`
- Redis `redis://127.0.0.1:56379`
