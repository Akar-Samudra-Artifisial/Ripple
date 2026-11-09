import { invoke, view } from '@forge/bridge';
import { useEffect, useState } from 'react';

/** Calls a resolver function and turns `{ error }` replies into thrown errors. */
export async function call<T>(name: string, payload?: Record<string, unknown>): Promise<T> {
  const reply = (await invoke(name, payload)) as T | { error: string } | undefined;
  if (!reply) throw new Error('Ripple returned an empty response.');
  if (typeof reply === 'object' && 'error' in (reply as object)) throw new Error((reply as { error: string }).error);
  return reply as T;
}

export interface Remote<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

/** Loads resolver data once per resolver name. */
export function useRemote<T>(name: string): Remote<T> {
  const [state, setState] = useState<Remote<T>>({ loading: true });
  useEffect(() => {
    let alive = true;
    call<T>(name)
      .then((data) => alive && setState({ data, loading: false }))
      .catch((e: unknown) => alive && setState({ error: e instanceof Error ? e.message : String(e), loading: false }));
    return () => {
      alive = false;
    };
  }, [name]);
  return state;
}

export function enableTheme(): void {
  view.theme.enable().catch(() => undefined);
}
