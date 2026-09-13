import "dotenv/config";
import { readFile } from "node:fs/promises";
import pg from "pg";
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before running migrations.");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(await readFile(new URL("../migrations/001_session_memory.sql", import.meta.url), "utf8"));
  console.log("Session memory migration applied.");
} finally { await pool.end(); }
