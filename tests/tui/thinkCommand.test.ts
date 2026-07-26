import { describe, expect, it } from 'vitest';
import { DEFAULT_THINKING_LEVELS, type ThinkingConfig } from '../../src/config/config.js';
import {
  parseThinkArgs,
  thinkLevelsOf,
  thinkStatusLabel,
  thinkStreamParam,
  thinkingAvailable,
} from '../../src/tui/thinkCommand.js';

const LEVELS = { low: 1024, medium: 4096, high: 32000 };

describe('parseThinkArgs', () => {
  it('空参 → show', () => {
    expect(parseThinkArgs('', LEVELS)).toEqual({ kind: 'show' });
    expect(parseThinkArgs('   ', LEVELS)).toEqual({ kind: 'show' });
  });

  it('off → 会话级关闭', () => {
    expect(parseThinkArgs('off', LEVELS)).toEqual({ kind: 'set', override: 'off' });
    expect(parseThinkArgs(' off ', LEVELS)).toEqual({ kind: 'set', override: 'off' });
  });

  it('命中档位名 → 切换该档', () => {
    expect(parseThinkArgs('high', LEVELS)).toEqual({ kind: 'set', override: 'high' });
  });

  it('未知档位 → invalid 并带回原样档位名（含大小写敏感）', () => {
    expect(parseThinkArgs('ultra', LEVELS)).toEqual({ kind: 'invalid', name: 'ultra' });
    expect(parseThinkArgs('High', LEVELS)).toEqual({ kind: 'invalid', name: 'High' });
    expect(parseThinkArgs('OFF', LEVELS)).toEqual({ kind: 'invalid', name: 'OFF' });
  });
});

describe('thinkStreamParam', () => {
  it('undefined → undefined（provider 用构造默认）', () => {
    expect(thinkStreamParam(undefined, LEVELS)).toBeUndefined();
  });

  it('off → null（本次抑制 thinking 字段）', () => {
    expect(thinkStreamParam('off', LEVELS)).toBeNull();
  });

  it('档位名 → 对应 budget 的对象覆盖', () => {
    expect(thinkStreamParam('high', LEVELS)).toEqual({ budgetTokens: 32000 });
  });

  it('档位名不在表内 → undefined（防御，不发明知非法的覆盖）', () => {
    expect(thinkStreamParam('ghost', LEVELS)).toBeUndefined();
  });
});

describe('thinkStatusLabel', () => {
  it('off 覆盖 → off；档位覆盖 → 档位名', () => {
    expect(thinkStatusLabel('off', { enabled: true, levels: LEVELS })).toBe('off');
    expect(thinkStatusLabel('high', { enabled: false, levels: LEVELS })).toBe('high');
  });

  it('无覆盖：启用且配了 default_level → 档位名；否则不显示', () => {
    expect(thinkStatusLabel(undefined, { enabled: true, levels: LEVELS, defaultLevel: 'medium' })).toBe('medium');
    // 未启用时构造默认不带 thinking 参数，展示 default_level 是撒谎
    expect(thinkStatusLabel(undefined, { enabled: false, levels: LEVELS, defaultLevel: 'medium' })).toBeUndefined();
    expect(thinkStatusLabel(undefined, { enabled: true, levels: LEVELS })).toBeUndefined();
    expect(thinkStatusLabel(undefined, undefined)).toBeUndefined();
  });
});

describe('thinkingAvailable 门控', () => {
  const enabled: ThinkingConfig = { enabled: true, levels: LEVELS };
  const disabled: ThinkingConfig = { enabled: false, levels: LEVELS };

  it('anthropic 预设：sendThinking 恒 true，未配 [thinking] 也可用（会话级开启）', () => {
    expect(thinkingAvailable('anthropic', undefined)).toBe(true);
    expect(thinkingAvailable('anthropic', disabled)).toBe(true);
  });

  it('stepfun 预设：仅当 [thinking] enabled=true 时可用', () => {
    expect(thinkingAvailable('stepfun', enabled)).toBe(true);
    expect(thinkingAvailable('stepfun', disabled)).toBe(false);
    expect(thinkingAvailable('stepfun', undefined)).toBe(false);
  });

  it('openai 系协议：即使 [thinking] enabled 也不可用（协议无 thinking 字段）', () => {
    expect(thinkingAvailable('openai', enabled)).toBe(false);
    expect(thinkingAvailable('openai_responses', enabled)).toBe(false);
  });

  it('未知渠道 → 不可用', () => {
    expect(thinkingAvailable('ghost', enabled)).toBe(false);
  });
});

describe('thinkLevelsOf', () => {
  it('config 缺省/缺 levels → 内置默认表；有 levels → 原样返回', () => {
    expect(thinkLevelsOf(undefined)).toEqual(DEFAULT_THINKING_LEVELS);
    expect(thinkLevelsOf({ enabled: false, levels: { deep: 8192 } })).toEqual({ deep: 8192 });
  });
});
