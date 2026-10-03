# Drizzle Kit Migrations

## CRITICAL: No Environment Variable Prefixes

```bash
# CORRECT - Environment from .env and drizzle.config.ts
bunx drizzle-kit generate --config=apps/catpod/api/drizzle.config.ts
bunx drizzle-kit push --config=apps/catpod/api/drizzle.config.ts
bunx drizzle-kit migrate --config=apps/catpod/api/drizzle.config.ts

# WRONG - NEVER prefix with environment variables
POSTGRES_USER=user POSTGRES_PASSWORD=pass bunx drizzle-kit generate
DATABASE_URL=xyz bunx drizzle-kit push
```

**Why**: Drizzle Kit loads environment variables from `.env` files and `drizzle.config.ts`. Prefixing commands can cause conflicts.

## Drizzle Kit Commands

```bash
# Generate migrations from schema changes
bunx drizzle-kit generate --config=drizzle.config.ts

# Push schema directly to database (prototyping only)
bunx drizzle-kit push --config=drizzle.config.ts

# Apply migrations
bunx drizzle-kit migrate --config=drizzle.config.ts

# Open Drizzle Studio
bunx drizzle-kit studio --config=drizzle.config.ts

# Introspect existing database
bunx drizzle-kit introspect --config=drizzle.config.ts
```

## Drizzle Config File

```typescript
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql', // 'postgresql' | 'mysql' | 'sqlite'
  schema: './src/db/schema.ts', // or glob: './src/db/schema/*.ts'
  out: './drizzle', // migrations output folder
  dbCredentials: {
    url: process.env.DATABASE_URL!,
    // Or individual params:
    // host: process.env.DB_HOST,
    // port: Number(process.env.DB_PORT),
    // user: process.env.DB_USER,
    // password: process.env.DB_PASSWORD,
    // database: process.env.DB_NAME,
  },
  // Optional filters
  tablesFilter: ['*'], // or specific tables: ['users', 'posts']
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
});
```

## Database Connection

```typescript
// PostgreSQL with node-postgres
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

// Neon serverless
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });

// SQLite with better-sqlite3
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';

const sqlite = new Database('sqlite.db');
export const db = drizzle(sqlite, { schema });
```

## Common Migration Patterns (SQL)

```sql
-- Add column with default
ALTER TABLE users ADD COLUMN status text DEFAULT 'active';

-- Add index
CREATE INDEX idx_users_email ON users (email);

-- Add foreign key
ALTER TABLE posts
  ADD CONSTRAINT fk_posts_author
  FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE CASCADE;

-- Rename column
ALTER TABLE users RENAME COLUMN name TO full_name;
```
