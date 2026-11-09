/**
 * Resolver reply shapes shared by the backend and the Custom UI (ui/src). Types only, no imports, so the UI bundle
 * never pulls in Forge runtime packages.
 */

/** Reply of a handler declared in the manifest but not built yet (M0 ships the final manifest with stubs). */
export interface NotImplemented {
  status: 'not_implemented';
  feature: string;
  message: string;
}

export interface TeamView {
  id: string;
  name: string;
}

export interface SchemaView {
  status: 'ready' | 'setting_up' | 'error';
  applied: number;
  total: number;
  latest: string;
  error?: string;
}

export interface SpaceTeamsView {
  spaceId: string | null;
  teams: TeamView[];
  /** False when the graph answered `data: null` (missing scope / query context) or the call failed. */
  dataPresent: boolean;
  errors: string[];
}

export interface BylineStatus {
  message: string;
  schema: SchemaView;
  spaceTeams: SpaceTeamsView;
}
