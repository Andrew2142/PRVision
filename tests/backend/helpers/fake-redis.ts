/**
 * In-memory Redis subset (sheet 14 §5.4.11): the commands 04's QueueService uses for the cancel flag
 * (get / set EX / del / exists / ttl). Expiry follows the injectable clock.
 */
export class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();
  readonly commands: Array<{ name: string; args: unknown[] }> = [];
  now: () => number = () => Date.parse("2026-01-01T00:00:00Z");

  get(key: string): Promise<string | null> {
    this.commands.push({ name: "get", args: [key] });
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  set(key: string, value: string, mode?: "EX", seconds?: number): Promise<"OK"> {
    this.commands.push({ name: "set", args: [key, value, mode, seconds] });
    this.store.set(key, { value, expiresAt: mode === "EX" && seconds ? this.now() + seconds * 1000 : null });
    return Promise.resolve("OK");
  }

  del(...keys: string[]): Promise<number> {
    this.commands.push({ name: "del", args: keys });
    return Promise.resolve(keys.filter((key) => this.store.delete(key)).length);
  }

  exists(key: string): Promise<number> {
    this.commands.push({ name: "exists", args: [key] });
    return Promise.resolve(this.live(key) ? 1 : 0);
  }

  ttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) {
      return Promise.resolve(-2);
    }
    return Promise.resolve(entry.expiresAt === null ? -1 : Math.ceil((entry.expiresAt - this.now()) / 1000));
  }

  quit(): Promise<void> {
    return Promise.resolve();
  }

  /** The entry for key, or undefined when missing or expired (expired entries are evicted). */
  private live(key: string): { value: string; expiresAt: number | null } | undefined {
    const entry = this.store.get(key);
    if (entry !== undefined && entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }
}
