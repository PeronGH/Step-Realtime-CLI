import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { QuestionPrompt } from '../../src/tui/QuestionPrompt.js';
import type { AskUserRequest, QuestionAnswers } from '../../src/tools/askUser.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const singleReq: AskUserRequest = {
  questions: [
    {
      question: '选哪个部署方案？',
      header: 'Deploy',
      options: [{ label: 'Vercel (Recommended)', description: '零配置' }, { label: '自建服务器' }],
    },
  ],
};

const multiReq: AskUserRequest = {
  questions: [
    {
      question: '要包含哪些模块？',
      options: [{ label: '认证' }, { label: '支付' }, { label: '通知' }],
      multi_select: true,
    },
  ],
};

describe('QuestionPrompt 渲染', () => {
  it('单选：渲染问题、header、选项与自动追加的 Other 项', () => {
    const { lastFrame } = render(
      React.createElement(QuestionPrompt, { req: singleReq, onSubmit: () => {}, onCancel: () => {} }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('选哪个部署方案？');
    expect(out).toContain('Deploy');
    expect(out).toContain('Vercel (Recommended)');
    expect(out).toContain('自建服务器');
    expect(out).toContain('Other');
  });

  it('多选：每项前带复选框，且提示多选', () => {
    const { lastFrame } = render(
      React.createElement(QuestionPrompt, { req: multiReq, onSubmit: () => {}, onCancel: () => {} }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('[ ]');
    expect(out).toContain('多选');
  });

  it('多题：显示进度 (第 1/2 题)', () => {
    const two: AskUserRequest = {
      questions: [
        { question: '问题一', options: [{ label: 'a' }, { label: 'b' }] },
        { question: '问题二', options: [{ label: 'c' }, { label: 'd' }] },
      ],
    };
    const { lastFrame } = render(
      React.createElement(QuestionPrompt, { req: two, onSubmit: () => {}, onCancel: () => {} }),
    );
    expect(lastFrame() ?? '').toContain('第 1/2 题');
  });
});

describe('QuestionPrompt 键盘交互', () => {
  it('单选：数字键 2 直选第二项并回传答案', async () => {
    const onSubmit = vi.fn<(a: QuestionAnswers) => void>();
    const { stdin } = render(
      React.createElement(QuestionPrompt, { req: singleReq, onSubmit, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write('2');
    await delay(20);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual({ '选哪个部署方案？': '自建服务器' });
  });

  it('多选：空格切换勾选后 Enter 提交为数组', async () => {
    const onSubmit = vi.fn<(a: QuestionAnswers) => void>();
    const { stdin, lastFrame } = render(
      React.createElement(QuestionPrompt, { req: multiReq, onSubmit, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write(' '); // 切换当前光标项（认证）
    await delay(20);
    expect(lastFrame() ?? '').toContain('[✓]');
    stdin.write('\r'); // 提交本题
    await delay(20);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual({ '要包含哪些模块？': ['认证'] });
  });

  it('Esc 取消触发 onCancel', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      React.createElement(QuestionPrompt, { req: singleReq, onSubmit: () => {}, onCancel }),
    );
    await delay(20);
    stdin.write('\x1B'); // Esc
    await delay(20);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('多题：逐题回答后一次性汇总回传', async () => {
    const two: AskUserRequest = {
      questions: [
        { question: '问题一', options: [{ label: 'a' }, { label: 'b' }] },
        { question: '问题二', options: [{ label: 'c' }, { label: 'd' }] },
      ],
    };
    const onSubmit = vi.fn<(a: QuestionAnswers) => void>();
    const { stdin } = render(
      React.createElement(QuestionPrompt, { req: two, onSubmit, onCancel: () => {} }),
    );
    await delay(20);
    stdin.write('1'); // 第一题选 a
    await delay(20);
    stdin.write('2'); // 第二题选 d
    await delay(20);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual({ 问题一: 'a', 问题二: 'd' });
  });
});
