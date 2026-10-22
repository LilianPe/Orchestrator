import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/store/pg/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/factory',
  },
  strict: true,
  verbose: true,
});
