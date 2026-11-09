import { chat as forgeChat, ForgeLlmError, type Message, type Usage } from '@forge/llm';

/**
 * Model for extraction, judging and sentence rewrites. `claude-sonnet-5` is listed ACTIVE on the Forge LLMs models
 * page (retirement not sooner than 2027-06-30). Haiku 4.5's tentative retirement date (2026-10-15) has passed, so
 * there is no separate cheap model yet; revisit with `list()` from @forge/llm.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. Forge LLM does not enforce it, so callers must validate `args`. */
  parameters: Record<string, unknown>;
}

/** The model answered, but not with a usable tool call. */
export class LlmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmOutputError';
  }
}

export interface ToolResult<T> {
  args: T;
  usage?: Usage;
}

/**
 * Forces the model to call `tool` and returns its (unvalidated) arguments. Only call from queue consumers (900 s
 * timeout), never from UI resolvers. Throws `LlmOutputError` when there is no tool call or the arguments are not a
 * JSON object.
 */
export async function chatTool<T = unknown>(messages: Message[], tool: ToolSpec, options: ChatOptions = {}): Promise<ToolResult<T>> {
  const model = options.model ?? DEFAULT_MODEL;
  const response = await forgeChat({
    model,
    messages,
    temperature: options.temperature ?? 0,
    max_completion_tokens: options.maxTokens ?? 4096,
    tools: [{ type: 'function', function: tool }],
    tool_choice: { type: 'function', function: { name: tool.name } },
  });
  console.info('ripple llm usage', { model, tool: tool.name, usage: response.usage });
  const call = response.choices[0]?.message.tool_calls?.[0];
  if (!call) throw new LlmOutputError(`LLM did not call ${tool.name} (no tool call)`);
  // Typed as object, but the REST API returns a JSON string.
  const raw: unknown = call.function.arguments;
  let args: unknown = raw;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      throw new LlmOutputError(`LLM returned malformed JSON arguments for ${tool.name}`);
    }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new LlmOutputError(`LLM returned non-object arguments for ${tool.name}`);
  return { args: args as T, usage: response.usage };
}

/** True for a Forge LLM 429. `ForgeLlmAPIError` (which carries `status`) is not exported, so read the field directly. */
export function isLlmRateLimited(err: unknown): boolean {
  return err instanceof ForgeLlmError && (err as { status?: number }).status === 429;
}
