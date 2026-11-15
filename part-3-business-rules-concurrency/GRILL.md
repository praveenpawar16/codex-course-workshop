# GRILL.md — Part 3: Business rules & concurrency

Agreed decisions from the design conversation. Glossary: [`CONTEXT.md`](./CONTEXT.md). ADRs: [`docs/adr/`](./docs/adr/).

## Locked decisions

| Topic | Decision |
| --- | --- |
| Baseline | Copy Part 2 into Part 3; leave Part 2 as the unprotected reproduction |
| Concurrency | Serialize bidding in a transaction with a blocking auction-row lock |
| Validation | Read Current amount and validate Minimum bid only after acquiring the lock |
| Stale bids | Reject amounts below the updated Minimum bid; refresh displayed auction/bids/minimum |
| Resubmission | No automatic bid resubmission |
| Clock | Inject an application clock so tests can control time |
| Acceptance time | Evaluate Closing time after acquiring the lock |
| Deadline | Reject Bids at or after the Closing time instant |
| UI | Switch to Ended and disable bidding when the deadline arrives |
| Lock wait | Block on the row lock until the prior bidder commits (no `NOWAIT`) |
| Race delay | Remove Part 3 `BID_RACE_DELAY_MS` instrumentation; Part 2 keeps reproduction delay |
| Tests | Bidding War asserts protected behavior (no duplicate accepted amounts) |
| Scope | No idempotency keys and no extra client retry mechanisms |

## Runtime

- Work only in `part-3-business-rules-concurrency`
- Database `auction_part_3` on host port `55432`
- API `3103`, web `5103`
- Plain `pg` + ordered SQL migrations

## Implementation slices

1. **Serialized bidding and stale-bid recovery** — row lock + post-lock validation; stale-bid rejection refreshes UI state; Bidding War flipped to protected assertions; no race-delay helper in Part 3
2. **Testable clock and closing-time behavior** — injectable clock; reject at/after Closing time under the lock; UI shows Ended and disables bidding when the deadline arrives; clock-controlled tests

Slice 1 and Slice 2 implemented — Part 3 capability complete pending final course checkpoint.
