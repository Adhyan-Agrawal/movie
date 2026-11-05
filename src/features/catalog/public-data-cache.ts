export interface PublicDataCacheOptions {
  maxEntries: number;
  maxPending: number;
  positiveTtlMs: number;
  negativeTtlMs: number;
  staleTtlMs: number;
  negativeStaleTtlMs: number;
  errorRetryMs: number;
  now?: () => number;
}

export interface PublicDataReadOptions<T> {
  scope?: object;
  isNegative?: (value: T) => boolean;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  staleTtlMs?: number;
  negativeStaleTtlMs?: number;
}

interface CacheEntry<T> {
  value: T;
  freshUntil: number;
  staleUntil: number;
}

/**
 * Small isolate-local companion to the persistent Next data cache. Entries are
 * resolved public DTO/JSON values only; in-flight promises are bounded and
 * coalesced only within the supplied request scope.
 */
export class PublicDataCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private pending = new WeakMap<object, Map<string, Promise<T>>>();
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly options: PublicDataCacheOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.pending = new WeakMap();
    this.generation++;
  }

  async read(key: string, load: () => Promise<T>, options: PublicDataReadOptions<T> = {}): Promise<T> {
    const scope = options.scope ?? this;
    let pending = this.pending.get(scope);
    if (!pending) {
      pending = new Map();
      this.pending.set(scope, pending);
    }
    const generation = this.generation;
    const now = this.now();
    let stale = this.entries.get(key);
    if (stale && now >= stale.staleUntil) {
      this.entries.delete(key);
      stale = undefined;
    }
    if (stale && now < stale.freshUntil) {
      this.touch(key, stale);
      return stale.value;
    }

    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= this.options.maxPending) {
      if (stale) return stale.value;
      throw new Error('Public data request queue is full');
    }

    const read = Promise.resolve().then(async () => {
      try {
        const value = await load();
        const negative = options.isNegative?.(value) ?? false;
        const freshFor = negative
          ? options.negativeTtlMs ?? this.options.negativeTtlMs
          : options.positiveTtlMs ?? this.options.positiveTtlMs;
        const staleFor = negative
          ? options.negativeStaleTtlMs ?? this.options.negativeStaleTtlMs
          : options.staleTtlMs ?? this.options.staleTtlMs;
        const loadedAt = this.now();
        if (generation === this.generation) {
          this.set(key, {
            value,
            freshUntil: loadedAt + freshFor,
            staleUntil: loadedAt + freshFor + staleFor,
          });
        }
        return value;
      } catch (error) {
        if (stale && this.now() < stale.staleUntil) {
          if (generation === this.generation && this.entries.get(key) === stale) {
            stale.freshUntil = Math.min(this.now() + this.options.errorRetryMs, stale.staleUntil);
            this.touch(key, stale);
          }
          return stale.value;
        }
        throw error;
      } finally {
        if (pending.get(key) === read) pending.delete(key);
      }
    });
    pending.set(key, read);
    return read;
  }

  private touch(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private set(key: string, entry: CacheEntry<T>): void {
    this.touch(key, entry);
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
