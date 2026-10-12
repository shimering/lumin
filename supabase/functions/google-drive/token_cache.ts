// Google access tokens stay in this worker's memory; user permissions are never cached.
export type CachedDriveToken = {value: string; expiresAt: number};
export function tokenLifetime(expiresIn: unknown) {
  const seconds = Number(expiresIn);
  return Number.isFinite(seconds) ? Math.max(0, Math.min(3600, seconds) - 60) * 1000 : 0;
}
export class DriveTokenCache {
  private entries = new Map<string, CachedDriveToken>();
  private pending = new Map<string, Promise<CachedDriveToken>>();
  constructor(public readonly clock = () => Date.now()) {}
  async get(key: string, load: () => Promise<{access_token: string; expires_in?: unknown}>) {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.clock()) return cached;
    this.entries.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const result = await load();
      const entry = {value: result.access_token, expiresAt: this.clock() + tokenLifetime(result.expires_in)};
      if (entry.expiresAt > this.clock()) {
        for (const [id, value] of this.entries) if (value.expiresAt <= this.clock()) this.entries.delete(id);
        if (this.entries.size >= 4) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key, entry);
      }
      return entry;
    })();
    this.pending.set(key, pending);
    try { return await pending; }
    finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
  }
  invalidate(key: string, token: string) {
    if (this.entries.get(key)?.value === token) this.entries.delete(key);
  }
}
