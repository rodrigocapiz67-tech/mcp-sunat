import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CACHE_DIR = path.join(os.homedir(), ".sunat-mcp-cache");

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

export function cacheTtlMs(): number {
  const env = process.env.SUNAT_CACHE_TTL_MS;
  if (!env) return DEFAULT_TTL_MS;
  const parsed = Number(env);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

function keyToFile(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return path.join(CACHE_DIR, `${hash}.json`);
}

interface CacheEntry<T> {
  timestamp: number;
  data: T;
}

export async function getCached<T>(key: string, ttlMs: number): Promise<T | null> {
  if (ttlMs <= 0) return null;
  try {
    const raw = await readFile(keyToFile(key), "utf-8");
    const entry = JSON.parse(raw) as CacheEntry<T>;
    if (Date.now() - entry.timestamp > ttlMs) return null;
    return entry.data;
  } catch {
    return null;
  }
}

export async function setCached<T>(key: string, data: T): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const entry: CacheEntry<T> = { timestamp: Date.now(), data };
  await writeFile(keyToFile(key), JSON.stringify(entry), "utf-8");
}

export async function clearCache(): Promise<void> {
  await rm(CACHE_DIR, { recursive: true, force: true });
}

export function cacheDir(): string {
  return CACHE_DIR;
}
