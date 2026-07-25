import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// loadConfig 读 ~/.step-code/config.toml：把 homedir 指到临时目录，避免碰真实配置。
let fakeHome = '';
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => fakeHome };
});

import { loadConfig } from '../src/config/config.js';

const ENV_KEYS = [
  'STEPFUN_API_KEY',
  'STEP_CODE_API_KEY',
  'STEP_CODE_PROVIDER',
  'STEP_CODE_BASE_URL',
  'STEP_CODE_MODEL',
];
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), 'stepcode-providers-'));
  fakeHome = dir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fakeHome = '';
  rmSync(dir, { recursive: true, force: true });
});

function writeToml(text: string): void {
  const cfgDir = join(dir, '.step-code');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.toml'), text, 'utf8');
}

describe('loadConfig [providers.<id>] 集成', () => {
  it('别名引用自定义渠道 → 展开走渠道合并（provider=渠道 type，端点/密钥取自渠道）', () => {
    writeToml(
      [
        'api_key = "k-top"',
        'model = "fast"',
        '',
        '[providers.gw]',
        'type = "anthropic"',
        'base_url = "https://gw.example.com"',
        'api_key = "k-gw"',
        '',
        '[models.fast]',
        'provider = "gw"',
        'model = "test-model-y"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.baseUrl).toBe('https://gw.example.com');
    expect(cfg.apiKey).toBe('k-gw');
    expect(cfg.model).toBe('test-model-y');
    // 渠道表本身保留在配置里（供 /model 运行时切换查询）
    expect(cfg.providers?.['gw']?.type).toBe('anthropic');
  });

  it('渠道缺省 base_url/api_key → 回落 entry → 顶层/预设', () => {
    writeToml(
      [
        'api_key = "k-top"',
        'model = "fast"',
        '',
        '[providers.gw]',
        'type = "stepfun"',
        '',
        '[models.fast]',
        'provider = "gw"',
        'model = "test-model-x"',
        'api_key = "k-entry"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    // type 与顶层 provider 相同且渠道/entry 未给 base_url → 回落预设（顶层未显式配 base_url 时即预设值）
    expect(cfg.provider).toBe('stepfun');
    expect(cfg.baseUrl).toBe('https://api.stepfun.com');
    expect(cfg.apiKey).toBe('k-entry');
  });

  it('渠道 id 与内置预设同名 → 渠道优先，type 重定义生效', () => {
    writeToml(
      [
        'api_key = "k-top"',
        'model = "claude"',
        '',
        '[providers.stepfun]',
        'type = "anthropic"',
        'base_url = "https://gw.example.com"',
        '',
        '[models.claude]',
        'provider = "stepfun"',
        'model = "test-model-y"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.baseUrl).toBe('https://gw.example.com');
  });

  it('别名仍指内置预设名 → 向后兼容，走原有预设回落', () => {
    writeToml(
      [
        'api_key = "k-top"',
        'model = "claude"',
        '',
        '[models.claude]',
        'provider = "anthropic"',
        'model = "test-model-y"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.baseUrl).toBe('https://api.anthropic.com');
    expect('providers' in cfg).toBe(false);
  });

  it('渠道 type 非法 → 渠道无效；引用它的别名展开失败，顶层 model 原样保留', () => {
    writeToml(
      [
        'api_key = "k-top"',
        'model = "fast"',
        '',
        '[providers.bad]',
        'type = "not-a-real-protocol"',
        '',
        '[models.fast]',
        'provider = "bad"',
        'model = "test-model-x"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    // 全部渠道无效 → providers 键不进结果对象
    expect('providers' in cfg).toBe(false);
    // 无效别名不展开：model 保留别名本身，其余顶层字段不动
    expect(cfg.model).toBe('fast');
    expect(cfg.provider).toBe('stepfun');
  });

  it('未配置 [providers] → providers 键不进结果对象（旧配置零迁移）', () => {
    writeToml(['api_key = "k"', 'model = "step-3.7-flash"', ''].join('\n'));
    const cfg = loadConfig(dir);
    expect('providers' in cfg).toBe(false);
    expect(cfg.model).toBe('step-3.7-flash');
  });

  it('models 条目的 display_name / capabilities 经 TOML 解析透传', () => {
    writeToml(
      [
        'api_key = "k"',
        '',
        '[models.fast]',
        'model = "step-3.7-flash"',
        'display_name = "Step 3.7 Flash"',
        'capabilities = ["thinking", "image_in"]',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.models?.['fast']?.displayName).toBe('Step 3.7 Flash');
    expect(cfg.models?.['fast']?.capabilities).toEqual(['thinking', 'image_in']);
  });
});
