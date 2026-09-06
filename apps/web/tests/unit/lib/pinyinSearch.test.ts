import { describe, expect, it } from 'vitest';
import { matchPinyin } from '@/lib/pinyinSearch';

describe('matchPinyin', () => {
  it('matches by pinyin initials', () => {
    expect(matchPinyin('蒋志国', 'jzg')).toBe(true);
    expect(matchPinyin('蒋志国', 'JZG')).toBe(true);
  });

  it('matches by full pinyin without tones', () => {
    expect(matchPinyin('蒋志国', 'jiangzhiguo')).toBe(true);
    expect(matchPinyin('蒋志国', 'zhi')).toBe(true);
  });

  it('matches by raw text including partial names', () => {
    expect(matchPinyin('蒋志国', '蒋志')).toBe(true);
    expect(matchPinyin('蒋志国', '志国')).toBe(true);
  });

  it('handles mixed Chinese-Latin names', () => {
    expect(matchPinyin('前端开发John', 'qdkf')).toBe(true);
    expect(matchPinyin('前端开发John', 'john')).toBe(true);
  });

  it('matches ü-names typed with v', () => {
    expect(matchPinyin('吕布', 'lv')).toBe(true);
    expect(matchPinyin('吕布', 'lü')).toBe(true);
  });

  it('AND-matches whitespace-separated tokens', () => {
    expect(matchPinyin('蒋志国', 'jiang zhi')).toBe(true);
    expect(matchPinyin('蒋志国', '蒋 zhi')).toBe(true);
    expect(matchPinyin('蒋志国', 'jiang zhang')).toBe(false);
  });

  it('rejects non-matching queries', () => {
    expect(matchPinyin('蒋志国', 'zhangsan')).toBe(false);
    expect(matchPinyin('蒋志国', 'zs')).toBe(false);
  });

  it('empty or whitespace queries match everything', () => {
    expect(matchPinyin('蒋志国', '')).toBe(true);
    expect(matchPinyin('蒋志国', '   ')).toBe(true);
  });
});
