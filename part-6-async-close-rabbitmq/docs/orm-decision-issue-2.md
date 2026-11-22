# ORM decision (GitHub issues #1 / #2)

**Repository:** https://github.com/praveenpawar16/codex-course-workshop  
**Decision issue:** https://github.com/praveenpawar16/codex-course-workshop/issues/2  
**Implementation issue:** https://github.com/praveenpawar16/codex-course-workshop/issues/1  

## Outcome for Part 6

Issue #2 asked whether an ORM improves safety. Issue #1 required a Drizzle refactor.

Part 6 now uses **Drizzle** for application data access ([ADR 0010](./adr/0010-drizzle-orm-for-part-6.md)), superseding the provisional “keep plain pg” note in [ADR 0009](./adr/0009-keep-plain-pg-over-orm.md). Safety still rests on Postgres locks, uniqueness constraints, Zod boundaries, and the transactional outbox—expressed through Drizzle rather than raw `pool.query` strings.
