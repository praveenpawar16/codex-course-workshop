# Keep plain `pg` instead of adopting an ORM

**Status:** superseded by [ADR 0010](./0010-drizzle-orm-for-part-6.md) after issue [#1](https://github.com/praveenpawar16/codex-course-workshop/issues/1) was reopened and implemented for Part 6.

Issue [#2](https://github.com/praveenpawar16/codex-course-workshop/issues/2) originally asked whether replacing application SQL with an ORM would improve safety. ADR 0009 recorded a provisional “keep plain `pg`” decision. That product decision is superseded for Part 6 by the explicit Drizzle refactor in #1; locking and uniqueness semantics remain Postgres-enforced and are expressed through Drizzle’s query API (`for('update')`, `skipLocked`, unique indexes).
