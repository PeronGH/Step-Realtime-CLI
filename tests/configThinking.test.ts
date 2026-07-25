import { describe, expect, it } from 'vitest';
import { resolveThinkingConfig } from '../src/config/config.js';

describe('resolveThinkingConfig', () => {
  it('缺省 → enabled=false，budget 键不进结果对象', () => {
    expect(resolveThinkingConfig(undefined, 32768)).toEqual({ enabled: false });
    expect(resolveThinkingConfig('not-object', 32768)).toEqual({ enabled: false });
    expect(resolveThinkingConfig({}, 32768)).toEqual({ enabled: false });
  });

  it('enabled 非布尔按 false；仅 true 启用', () => {
    expect(resolveThinkingConfig({ enabled: 'yes' }, 32768)).toEqual({ enabled: false });
    expect(resolveThinkingConfig({ enabled: 1 }, 32768)).toEqual({ enabled: false });
    expect(resolveThinkingConfig({ enabled: true }, 32768)).toEqual({ enabled: true });
  });

  it('budget_tokens 取整并 clamp 到 ≥1024', () => {
    expect(resolveThinkingConfig({ budget_tokens: 8192.6 }, 32768)).toEqual({
      enabled: false,
      budgetTokens: 8193,
    });
    expect(resolveThinkingConfig({ budget_tokens: 100 }, 32768)).toEqual({
      enabled: false,
      budgetTokens: 1024,
    });
    expect(resolveThinkingConfig({ enabled: true, budget_tokens: -5 }, 32768)).toEqual({
      enabled: true,
      budgetTokens: 1024,
    });
  });

  it('budget_tokens 非法值不进结果对象', () => {
    expect(resolveThinkingConfig({ enabled: true, budget_tokens: 'x' }, 32768)).toEqual({
      enabled: true,
    });
    expect(resolveThinkingConfig({ budget_tokens: Number.NaN }, 32768)).toEqual({ enabled: false });
  });

  it('启用且未配 budget：合法（请求只带 {type:enabled}），不做余量校验', () => {
    expect(resolveThinkingConfig({ enabled: true }, 4096)).toEqual({ enabled: true });
  });

  it('启用时 max_tokens - budget < 2048 → 抛配置错误并给出调整方向', () => {
    expect(() =>
      resolveThinkingConfig({ enabled: true, budget_tokens: 8192 }, 10000),
    ).toThrow(/max_tokens.*budget_tokens|调大 max_tokens 或调小 budget_tokens/);
    expect(() =>
      resolveThinkingConfig({ enabled: true, budget_tokens: 8192 }, 10000),
    ).toThrow(/调大 max_tokens 或调小 budget_tokens/);
  });

  it('余量恰好 2048 → 通过（边界含等号）', () => {
    expect(resolveThinkingConfig({ enabled: true, budget_tokens: 8192 }, 10240)).toEqual({
      enabled: true,
      budgetTokens: 8192,
    });
  });

  it('未启用时 budget 超余量也不校验（不启用就不发字段）', () => {
    expect(resolveThinkingConfig({ enabled: false, budget_tokens: 30000 }, 32768)).toEqual({
      enabled: false,
      budgetTokens: 30000,
    });
  });
});
