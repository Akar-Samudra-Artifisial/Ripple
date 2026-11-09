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
import { chatTool, DEFAULT_MODEL, isLlmRateLimited, LlmOutputError } from '../src/llm';

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
    expect(r).toEqual({ args: { facts: [] }, usage: { total_tokens: 3 } });
    expect(llm.chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: DEFAULT_MODEL, temperature: 0, tool_choice: { type: 'function', function: { name: tool.name } } }),
    );
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5');
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
