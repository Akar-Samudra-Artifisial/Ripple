import { chat as forgeChat, ForgeLlmError, type Message, type Prompt, type Usage } from '@forge/llm';

/**
 * Model for extraction, judging and sentence rewrites. `claude-sonnet-5` is listed ACTIVE on the Forge LLMs models
 * page (retirement not sooner than 2027-06-30). Haiku 4.5's tentative retirement date (2026-10-15) has passed, so
 * there is no separate cheap model; revisit with `list()` from @forge/llm.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';
/** ACTIVE fallback (retirement not sooner than 2027-02-17), used when the platform rejects `DEFAULT_MODEL`. */
export const FALLBACK_MODEL = 'claude-sonnet-4-6';

/** Models that reject `temperature`/`top_p` (Forge LLMs API reference, validation rules). */
const NO_SAMPLING_PARAMS = new Set(['claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-7', 'claude-opus-4-8']);

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
  model: string;
  usage?: Usage;
}

const statusOf = (err: unknown): number | undefined => (err instanceof ForgeLlmError ? (err as { status?: number }).status : undefined);

/** True when the platform refused the model itself (unknown or retired model), not the request content. */
export function isModelUnavailable(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 404) return true;
  return status === 400 && err instanceof Error && /model/i.test(err.message);
}

/** Request for `model`; sampling params are left out for models that reject them. */
function promptFor(model: string, messages: Message[], tool: ToolSpec, options: ChatOptions): Prompt {
  return {
    model,
    messages,
    ...(NO_SAMPLING_PARAMS.has(model) ? {} : { temperature: options.temperature ?? 0 }),
    max_completion_tokens: options.maxTokens ?? 4096,
    tools: [{ type: 'function', function: tool }],
    tool_choice: { type: 'function', function: { name: tool.name } },
  };
}

/**
 * Forces the model to call `tool` and returns its (unvalidated) arguments. Only call from queue consumers (900 s
 * timeout), never from UI resolvers. When the platform rejects the default model, retries once on
 * `FALLBACK_MODEL` and logs it. Throws `LlmOutputError` when there is no tool call or the arguments are not a
 * JSON object.
 */
export async function chatTool<T = unknown>(messages: Message[], tool: ToolSpec, options: ChatOptions = {}): Promise<ToolResult<T>> {
  let model = options.model ?? DEFAULT_MODEL;
  let response;
  try {
    response = await forgeChat(promptFor(model, messages, tool, options));
  } catch (err) {
    if (options.model || !isModelUnavailable(err)) throw err;
    console.warn('ripple llm: default model unavailable, using fallback', { model, fallback: FALLBACK_MODEL, status: statusOf(err) });
    model = FALLBACK_MODEL;
    response = await forgeChat(promptFor(model, messages, tool, options));
  }
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
  return { args: args as T, model, usage: response.usage };
}

/** True for a Forge LLM 429. `ForgeLlmAPIError` (which carries `status`) is not exported, so read the field directly. */
export function isLlmRateLimited(err: unknown): boolean {
  return statusOf(err) === 429;
}

/** 429 or 5xx from Forge LLM: worth retrying later (the queue backs off). */
export function isLlmRetryable(err: unknown): boolean {
  const status = statusOf(err);
  return status === 429 || (status !== undefined && status >= 500);
}

/** Any error from the Forge LLM API (as opposed to our own code or storage). */
export const isLlmApiError = (err: unknown): boolean => err instanceof ForgeLlmError;
