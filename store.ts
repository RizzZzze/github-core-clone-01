// In-memory store for the forge. One process, one store: no disk, no database, no
// outside service. Everything the suite creates through the API lives here until the
// process exits, which is exactly the trial's lifetime.
//
// Ownership: every repository belongs to the login the trial token names. The suite
// builds its scenario from one fixed seed (kit program/env/src/wire.ts, SCENARIO_SEED
// 0x6a09e667f3bcc909), so that login is the constant below: the scenario's viewer.
// Any other owner in a URL is a stranger to this token and reads as 404, never 403.

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

/** One fixed timestamp for every created/updated field: the store never reads a clock. */
export const FIXED_TIME = '2025-01-01T00:00:00Z';

export interface RepoInput {
  name: string;
  isPrivate: boolean;
  description: string | null;
  defaultBranch: string;
}

export interface CommitMeta {
  sha: string;
  treeSha: string;
  parents: string[];
  message: string;
  seq: number;
}

export interface RepoRecord {
  id: number;
  name: string;
  ownerLogin: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  /** Content-addressed objects: sha -> "<type> <len>\0<payload>" bytes. */
  objects: Map<string, Buffer>;
  /** Full ref name ('refs/heads/main') -> commit sha. */
  refs: Map<string, string>;
  /** Commits by sha, in creation order for listing. */
  commits: Map<string, CommitMeta>;
  commitSeq: number;
}

export class RepoStore {
  #byName = new Map<string, RepoRecord>();
  #nextId = 1;
  #nextSeq = 1;

  create(input: RepoInput): RepoRecord | null {
    if (this.#byName.has(input.name)) return null;
    const rec: RepoRecord = {
      id: this.#nextId++,
      name: input.name,
      ownerLogin: VIEWER_LOGIN,
      description: input.description,
      isPrivate: input.isPrivate,
      defaultBranch: input.defaultBranch,
      seq: this.#nextSeq++,
      objects: new Map(),
      refs: new Map(),
      commits: new Map(),
      commitSeq: 0,
    };
    this.#byName.set(input.name, rec);
    return rec;
  }

  get(name: string): RepoRecord | undefined {
    return this.#byName.get(name);
  }

  list(): RepoRecord[] {
    return [...this.#byName.values()].sort((a, b) => a.seq - b.seq);
  }

  remove(name: string): boolean {
    return this.#byName.delete(name);
  }

  patch(
    name: string,
    fields: { description?: string | null; defaultBranch?: string; isPrivate?: boolean },
  ): RepoRecord | undefined {
    const rec = this.#byName.get(name);
    if (rec === undefined) return undefined;
    if (fields.description !== undefined) rec.description = fields.description;
    if (fields.defaultBranch !== undefined) rec.defaultBranch = fields.defaultBranch;
    if (fields.isPrivate !== undefined) rec.isPrivate = fields.isPrivate;
    return rec;
  }
}

/** The GitHub REST shape of one repository, built from the request's own origin. */
export function repoJson(rec: RepoRecord, origin: string): Record<string, unknown> {
  const fullName = `${rec.ownerLogin}/${rec.name}`;
  const host = origin.replace(/^https?:\/\//, '');
  return {
    id: rec.id,
    node_id: `R_${rec.id}`,
    name: rec.name,
    full_name: fullName,
    owner: {
      login: rec.ownerLogin,
      id: VIEWER_ID,
      node_id: `U_${VIEWER_ID}`,
      avatar_url: '',
      gravatar_id: '',
      url: `${origin}/api/v3/users/${rec.ownerLogin}`,
      html_url: `${origin}/${rec.ownerLogin}`,
      type: 'User',
      site_admin: false,
    },
    private: rec.isPrivate,
    html_url: `${origin}/${fullName}`,
    description: rec.description,
    fork: false,
    url: `${origin}/api/v3/repos/${fullName}`,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    pushed_at: FIXED_TIME,
    git_url: `git://${host}/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    clone_url: `${origin}/${fullName}.git`,
    svn_url: `${origin}/${fullName}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: 0,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: rec.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: rec.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
