// Shared pull-request merge: the one implementation the REST PUT /merge route,
// the GraphQL mergePullRequest mutation and the MCP merge_pull_request tool all
// call, so the three surfaces can never disagree about what a merge does.
//
// A merge is a real two-parent merge commit from a three-way file merge: the
// first parent is the old base tip, the second the head tip. A path both sides
// changed differently — including delete-against-modify — is a conflict and the
// whole merge refuses with 405; equal changes, one-sided changes and clean
// deletions merge. The base branch advances to the merge commit and the pull
// request closes as merged.

import { FIXED_TIME, type PullRecord, type RepoRecord } from './store.ts';
import {
  buildCommit,
  buildTreesForFiles,
  filesOfTree,
  findMergeBase,
  parseCommit,
  splitObject,
  threeWayMerge,
} from './gitobj.ts';

export type MergeOutcome =
  | { ok: true; sha: string; message: string }
  | { ok: false; message: string };

function branchTip(rec: RepoRecord, branch: string): string | null {
  return rec.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Whether `ancestor` is reachable from `descendant` through any parent chain. */
function isAncestor(rec: RepoRecord, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const bytes = rec.objects.get(cur);
    if (bytes === undefined) continue;
    const split = splitObject(bytes);
    if (split === null || split.type !== 'commit') continue;
    const parsed = parseCommit(split.payload);
    if (parsed === null) continue;
    for (const parent of parsed.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

function treeOf(rec: RepoRecord, sha: string): Map<string, string> {
  const meta = rec.commits.get(sha);
  return meta === undefined ? new Map() : filesOfTree(meta.treeSha, (s) => rec.objects.get(s));
}

/**
 * Merge an open pull request: build the two-parent merge commit, advance the
 * base branch to it, and close the pull request as merged. The caller checks
 * the pull request is open; every other refusal is reported here.
 */
export function performMerge(rec: RepoRecord, pull: PullRecord): MergeOutcome {
  const headTip = branchTip(rec, pull.head);
  const baseTip = branchTip(rec, pull.base);
  if (headTip === null || baseTip === null) return { ok: false, message: 'Branch not found' };
  if (isAncestor(rec, headTip, baseTip)) return { ok: false, message: 'Nothing to merge' };
  const parentsOf = (sha: string): readonly string[] | undefined => rec.commits.get(sha)?.parents;
  const mergeBase = findMergeBase(parentsOf, baseTip, headTip);
  if (mergeBase === null) return { ok: false, message: 'No common ancestor' };
  const merged = threeWayMerge(treeOf(rec, mergeBase), treeOf(rec, baseTip), treeOf(rec, headTip));
  if (merged === null) return { ok: false, message: 'Merge conflict' };

  const message = `Merge pull request #${pull.number} from ${rec.ownerLogin}/${pull.head}`;
  const put = (sha: string, bytes: Buffer): void => {
    if (!rec.objects.has(sha)) rec.objects.set(sha, bytes);
  };
  const treeSha = buildTreesForFiles(merged, put);
  const { sha, bytes } = buildCommit({ treeSha, parents: [baseTip, headTip], message });
  put(sha, bytes);
  rec.commits.set(sha, { sha, treeSha, parents: [baseTip, headTip], message, seq: rec.commitSeq++ });
  rec.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TIME;
  pull.mergeCommitSha = sha;
  return { ok: true, sha, message };
}

/**
 * The paths a pull request changes, three-dot diff: the merge-base tree
 * against the head tip tree, sorted. Used by the REST files list's path set
 * and by the GraphQL pullRequest.files resolver (which needs paths only).
 */
export function pullChangedPaths(rec: RepoRecord, headSha: string, baseSha: string): string[] {
  const parentsOf = (sha: string): readonly string[] | undefined => rec.commits.get(sha)?.parents;
  const mergeBase = findMergeBase(parentsOf, baseSha, headSha) ?? baseSha;
  const before = treeOf(rec, mergeBase);
  const after = treeOf(rec, headSha);
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

/** The mergeability of an open pull request: clean three-way merge or not. */
export function mergeableState(rec: RepoRecord, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = branchTip(rec, pull.head);
  const baseTip = branchTip(rec, pull.base);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  const parentsOf = (sha: string): readonly string[] | undefined => rec.commits.get(sha)?.parents;
  const mergeBase = findMergeBase(parentsOf, baseTip, headTip);
  if (mergeBase === null) return 'UNKNOWN';
  const merged = threeWayMerge(treeOf(rec, mergeBase), treeOf(rec, baseTip), treeOf(rec, headTip));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}
