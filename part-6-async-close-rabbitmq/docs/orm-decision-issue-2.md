# ORM decision (GitHub issue #2)

**Repository:** https://github.com/praveenpawar16/codex-course-workshop  
**Issue:** https://github.com/praveenpawar16/codex-course-workshop/issues/2  
**Related:** https://github.com/praveenpawar16/codex-course-workshop/issues/1 (Drizzle implementation — deferred)

## Question

Should we replace the application's SQL with an ORM to improve safety?

## Recommendation

**No — keep plain `pg` and explicit SQL.** Documented in [ADR 0009](./adr/0009-keep-plain-pg-over-orm.md).

## Why this is safer for this app

1. **Concurrency is SQL-shaped.** Bid acceptance and auction close claim rows with `FOR UPDATE` / `SKIP LOCKED`. Those are Postgres locking semantics; an ORM does not make them safer and often makes them less visible.
2. **Invariants are already in the database.** One close, one outbox event, and one notification per recipient are enforced with uniqueness and `CHECK` constraints. ORM models would still rely on the same DDL.
3. **Boundary validation is already Zod.** Input safety at HTTP edges does not require an ORM.
4. **Multi-process surface.** API, close worker, and notification worker share the same SQL patterns; a half-migrated ORM increases dual-write risk during transition (exactly what #1 would force).

## What we are not deciding

We are not implementing Drizzle (#1 remains closed/deferred). This is the **product/architecture decision** only.
