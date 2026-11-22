import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';

import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function createDb(pool: pg.Pool | pg.PoolClient): Db {
  return drizzle(pool as pg.Pool, { schema });
}
