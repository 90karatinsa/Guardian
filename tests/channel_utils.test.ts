import { describe, expect, it } from 'vitest';
import { canonicalChannel, normalizeChannelId } from '../src/utils/channel.js';

describe('ChannelUtils', () => {
  it('ChannelNormalizeHandlesDefaults infers prefixes and canonicalizes casing', () => {
    expect(normalizeChannelId('lobby')).toBe('video:lobby');
    expect(normalizeChannelId('  Lobby  ')).toBe('video:Lobby');
    expect(normalizeChannelId('Mic-1', { defaultType: 'Audio' })).toBe('audio:Mic-1');
    expect(normalizeChannelId('audio:Backstage')).toBe('audio:Backstage');
    expect(normalizeChannelId('VIDEO:Entrance')).toBe('video:Entrance');
    expect(normalizeChannelId(null)).toBe('');
  });

  it('ChannelNormalizeHandlesDefaults canonicalChannel lowercases entire identifier', () => {
    expect(canonicalChannel('Video:Lobby')).toBe('video:lobby');
    expect(canonicalChannel('mic-1', { defaultType: 'Audio' })).toBe('audio:mic-1');
    expect(canonicalChannel(' CUSTOM:Value ')).toBe('custom:value');
    expect(canonicalChannel(undefined)).toBe('');
  });
});
