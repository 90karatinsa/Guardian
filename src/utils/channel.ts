const KNOWN_PREFIXES = new Set(['video', 'audio']);

export type ChannelKind = string;

export type NormalizeChannelOptions = {
  defaultType?: ChannelKind;
};

function resolveDefaultType(options?: NormalizeChannelOptions): ChannelKind {
  const configured = options?.defaultType;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim().toLowerCase();
  }
  return 'video';
}

function normalizeKnownPrefix(prefix: string): string {
  const lower = prefix.toLowerCase();
  if (KNOWN_PREFIXES.has(lower)) {
    return lower;
  }
  return prefix;
}

export function normalizeChannelId(
  value: string | null | undefined,
  options?: NormalizeChannelOptions
): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return '';
  }

  const match = /^([a-z0-9_-]+):(.*)$/i.exec(trimmed);
  if (match) {
    const [, rawPrefix, remainder] = match;
    const prefix = normalizeKnownPrefix(rawPrefix);
    return `${prefix}:${remainder}`;
  }

  const defaultType = resolveDefaultType(options);
  return `${defaultType}:${trimmed}`;
}

export function canonicalChannel(
  value: string | null | undefined,
  options?: NormalizeChannelOptions
): string {
  const normalized = normalizeChannelId(value, options);
  if (!normalized) {
    return '';
  }
  return normalized.toLowerCase();
}

export function knownChannelPrefixes(): string[] {
  return Array.from(KNOWN_PREFIXES);
}

