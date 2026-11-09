import { beforeEach, describe, expect, it, vi } from 'vitest';

const llm = vi.hoisted(() => ({ chat: vi.fn() }));

vi.mock('@forge/llm', () => ({
  chat: llm.chat,
  ForgeLlmError: class ForgeLlmError extends Error {
    constructor(readonly status?: number) {
      super('llm error');
    }
  },
}));

import { ForgeLlmError } from '@forge/llm';
import { chatTool, DEFAULT_MODEL, FALLBACK_MODEL, isLlmRateLimited, LlmOutputError } from '../src/llm';

const tool = { name: 'extract_facts', description: 'Extract facts', parameters: { type: 'object' } };
const reply = (args: unknown) => ({ choices: [{ message: { tool_calls: [{ function: { name: tool.name, arguments: args } }] } }], usage: { total_tokens: 3 } });

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  llm.chat.mockReset();
});

describe('chatTool', () => {
  it('forces the tool on the default model and parses string arguments', async () => {
    llm.chat.mockResolvedValue(reply('{"facts":[]}'));
    const r = await chatTool([{ role: 'user', content: 'hi' }], tool);
    expect(r).toEqual({ args: { facts: [] }, model: DEFAULT_MODEL, usage: { total_tokens: 3 } });
    expect(llm.chat).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_MODEL, tool_choice: { type: 'function', function: { name: tool.name } } }));
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5');
  });

  it('omits temperature for claude-sonnet-5 (rejected by the platform) but sends it for older models', async () => {
    llm.chat.mockResolvedValue(reply('{}'));
    await chatTool([], tool);
    expect(llm.chat.mock.calls[0]?.[0]).not.toHaveProperty('temperature');
    await chatTool([], tool, { model: FALLBACK_MODEL });
    expect(llm.chat.mock.calls[1]?.[0]).toMatchObject({ model: FALLBACK_MODEL, temperature: 0 });
  });

  it('falls back to an ACTIVE model, with a log, when the default model is rejected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const Err = ForgeLlmError as unknown as new (status?: number) => Error;
    llm.chat.mockRejectedValueOnce(new Err(404)).mockResolvedValueOnce(reply('{"ok":true}'));
    const r = await chatTool([], tool);
    expect(r.model).toBe(FALLBACK_MODEL);
    expect(llm.chat.mock.calls[1]?.[0]).toMatchObject({ model: FALLBACK_MODEL });
    expect(warn).toHaveBeenCalledWith('ripple llm: default model unavailable, using fallback', expect.objectContaining({ fallback: FALLBACK_MODEL }));
  });

  it('does not fall back on other errors or when the caller picked the model', async () => {
    const Err = ForgeLlmError as unknown as new (status?: number) => Error;
    llm.chat.mockRejectedValueOnce(new Err(500));
    await expect(chatTool([], tool)).rejects.toBeInstanceOf(Err);
    llm.chat.mockRejectedValueOnce(new Err(404));
    await expect(chatTool([], tool, { model: 'claude-opus-5' })).rejects.toBeInstanceOf(Err);
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing tool call, malformed JSON and non-object arguments', async () => {
    llm.chat.mockResolvedValueOnce({ choices: [{ message: {} }] });
    await expect(chatTool([], tool)).rejects.toBeInstanceOf(LlmOutputError);
    llm.chat.mockResolvedValueOnce(reply('{not json'));
    await expect(chatTool([], tool)).rejects.toThrow('malformed JSON');
    llm.chat.mockResolvedValueOnce(reply('[1]'));
    await expect(chatTool([], tool)).rejects.toThrow('non-object');
  });
});

describe('isLlmRateLimited', () => {
  it('is true only for a Forge LLM 429', () => {
    const Err = ForgeLlmError as unknown as new (status?: number) => Error;
    expect(isLlmRateLimited(new Err(429))).toBe(true);
    expect(isLlmRateLimited(new Err(500))).toBe(false);
    expect(isLlmRateLimited(new Error('x'))).toBe(false);
  });
});
