const namespaceStores = new Map();
const DEFAULT_MAX_ENTRIES = 750;

function getNamespaceStore(namespace) {
  if (!namespaceStores.has(namespace)) {
    namespaceStores.set(namespace, new Map());
  }
  return namespaceStores.get(namespace);
}

function touchEntry(entry, now = Date.now()) {
  if (!entry) return entry;
  return {
    ...entry,
    lastAccessedAt: now,
  };
}

function pruneStore(store, maxEntries = DEFAULT_MAX_ENTRIES) {
  if (store.size <= maxEntries) return;
  const now = Date.now();

  for (const [key, entry] of store.entries()) {
    if (!entry?.promise && Number.isFinite(entry?.staleUntil) && entry.staleUntil <= now) {
      store.delete(key);
    }
  }

  if (store.size <= maxEntries) return;

  const removable = [...store.entries()]
    .filter(([, entry]) => !entry?.promise)
    .sort((left, right) => {
      const leftStamp = left[1]?.lastAccessedAt || left[1]?.createdAt || 0;
      const rightStamp = right[1]?.lastAccessedAt || right[1]?.createdAt || 0;
      return leftStamp - rightStamp;
    });

  while (store.size > maxEntries && removable.length) {
    const [key] = removable.shift();
    store.delete(key);
  }
}

export async function loadWithCache(namespace, cacheKey, options, loader) {
  const {
    ttlMs,
    staleMs = ttlMs,
    allowStaleOnError = true,
    maxEntries = DEFAULT_MAX_ENTRIES,
  } = options || {};

  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return loader();
  }

  const store = getNamespaceStore(namespace);
  const now = Date.now();
  const existing = store.get(cacheKey);

  if (existing?.hasValue && existing.expiresAt > now) {
    store.set(cacheKey, touchEntry(existing, now));
    return existing.value;
  }

  if (existing?.promise) {
    store.set(cacheKey, touchEntry(existing, now));
    return existing.promise;
  }

  const staleSnapshot = existing?.hasValue
    ? {
        value: existing.value,
        staleUntil: existing.staleUntil,
      }
    : null;

  const inFlight = (async () => {
    try {
      const value = await loader();
      const loadedAt = Date.now();
      store.set(cacheKey, {
        hasValue: true,
        value,
        promise: null,
        createdAt: loadedAt,
        expiresAt: loadedAt + ttlMs,
        staleUntil: loadedAt + ttlMs + Math.max(0, staleMs),
        lastAccessedAt: loadedAt,
      });
      pruneStore(store, maxEntries);
      return value;
    } catch (error) {
      const failedAt = Date.now();
      if (allowStaleOnError && staleSnapshot && staleSnapshot.staleUntil > failedAt) {
        store.set(cacheKey, {
          hasValue: true,
          value: staleSnapshot.value,
          promise: null,
          createdAt: existing?.createdAt || failedAt,
          expiresAt: existing?.expiresAt || failedAt,
          staleUntil: staleSnapshot.staleUntil,
          lastAccessedAt: failedAt,
          lastErrorAt: failedAt,
          lastErrorMessage: error instanceof Error ? error.message : String(error),
        });
        return staleSnapshot.value;
      }

      store.delete(cacheKey);
      throw error;
    }
  })();

  store.set(cacheKey, {
    hasValue: Boolean(existing?.hasValue),
    value: existing?.value,
    promise: inFlight,
    createdAt: existing?.createdAt || now,
    expiresAt: existing?.expiresAt || 0,
    staleUntil: existing?.staleUntil || 0,
    lastAccessedAt: now,
  });

  return inFlight;
}

export function peekCacheEntry(namespace, cacheKey) {
  const store = namespaceStores.get(namespace);
  if (!store) return null;

  const entry = store.get(cacheKey);
  if (!entry?.hasValue) return null;

  const now = Date.now();
  const touched = touchEntry(entry, now);
  store.set(cacheKey, touched);

  return {
    value: touched.value,
    createdAt: touched.createdAt || now,
    expiresAt: touched.expiresAt || 0,
    staleUntil: touched.staleUntil || 0,
    lastAccessedAt: touched.lastAccessedAt || now,
    isFresh: Number.isFinite(touched.expiresAt) && touched.expiresAt > now,
    isStaleUsable: Number.isFinite(touched.staleUntil) && touched.staleUntil > now,
  };
}

export function clearNamespaceCache(namespace) {
  if (!namespaceStores.has(namespace)) return;
  namespaceStores.delete(namespace);
}
