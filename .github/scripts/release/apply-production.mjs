// @ts-check
/**
 * Production Release post-processing script
 *
 * Usage:
 *   node .github/scripts/release/apply-production.mjs --dry-run   # Preview only (no changes)
 *   node .github/scripts/release/apply-production.mjs --apply     # Actually process
 *
 * Called from GitHub Actions after the Production Release PR
 * (base: releases/production/v*, head: releases/production/v*-draft) is merged.
 *
 * Steps:
 *   1. Read metadata from PR body
 *   2. Validation (format, base/head ref match)
 *   3. Pre-checks (no side effects)
 *   4. Create production branch from targetSha and add release commit
 *   5. Create production tag (annotated) at release commit
 *   6. Create GitHub Release (stable)
 *   7. Delete Production release branches (failures treated as warnings)
 */
import { execFileSync, spawnSync, } from 'node:child_process';
import { readFileSync, writeFileSync, } from 'node:fs';
import { resolve, dirname, } from 'node:path';
import { fileURLToPath, } from 'node:url';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2,);
const isDryRun = args.includes('--dry-run',);
const isApply = args.includes('--apply',);

if (!isDryRun && !isApply) {
  console.error('Usage: node apply-production.mjs --dry-run | --apply',);
  process.exit(1,);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url,),), '../../..',);

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * @param {string} cmd
 * @param {string[]} cmdArgs
 * @param {{ cwd?: string }} [opts]
 * @returns {string}
 */
const git = (cmd, cmdArgs, opts = {},) => {
  const result = spawnSync('git', [ cmd, ...cmdArgs, ], {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: 'utf8',
  },);
  if (result.status !== 0) {
    throw new Error(`git ${cmd} failed:\n${result.stderr}`,);
  }
  return result.stdout.trim();
};

/**
 * @param {string[]} ghArgs
 * @returns {void}
 */
const gh = (ghArgs,) => {
  const result = spawnSync('gh', ghArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, },
    stdio: [ 'ignore', 'inherit', 'inherit', ],
  },);
  if (result.status !== 0) {
    throw new Error(`gh ${ghArgs.join(' ',)} failed`,);
  }
};

// ---------------------------------------------------------------------------
// GitHub Event loading
// ---------------------------------------------------------------------------

/**
 * @returns {{ pull_request: { number: number; base: { ref: string }; head: { ref: string; sha: string }; body: string | null } }}
 */
const readGitHubEvent = () => {
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  if (!eventPath) { throw new Error('GITHUB_EVENT_PATH is not set.',); }
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- GITHUB_EVENT_PATH is a trusted platform-provided path
  return /** @type {any} */ (JSON.parse(readFileSync(eventPath, 'utf8',),));
};

// ---------------------------------------------------------------------------
// Parse metadata from PR body
// ---------------------------------------------------------------------------

/**
 * @param {string | null} body
 * @returns {{ version: string; stagingVersion: string; trainBase: string; deployBase: string; targetSha: string; stablePr: number }}
 */
const parseReleaseProductionMeta = (body,) => {
  if (!body) { throw new Error('PR body is empty. Cannot parse release-production metadata.',); }

  const match = (/<!-- release-production\n(?<content>[\s\S]+?)\n-->/mu).exec(body,);
  if (!match) { throw new Error('No <!-- release-production --> block found in PR body.',); }

  const required = [ 'version', 'staging_version', 'train_base', 'deploy_base', 'target_sha', 'stable_pr', ];

  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of (match.groups?.content ?? '').split('\n',)) {
    const eqIdx = line.indexOf('=',);
    if (eqIdx < 0) { continue; }
    const key = line.slice(0, eqIdx,).trim();
    const val = line.slice(eqIdx + 1,).trim();
    // eslint-disable-next-line security/detect-object-injection -- key is validated against allowlist
    if (key && required.includes(key,)) { meta[key] = val; }
  }

  for (const key of required) {
    // eslint-disable-next-line security/detect-object-injection -- key is from trusted required allowlist
    if (!Object.hasOwn(meta, key,) || !meta[key]) { throw new Error(`Missing required metadata field: ${key}`,); }
  }

  const stablePrNum = Number(meta['stable_pr'],);
  if (!Number.isInteger(stablePrNum,) || stablePrNum <= 0) {
    throw new Error(`Invalid stable_pr: "${meta['stable_pr']}". Expected positive integer.`,);
  }

  return {
    version: /** @type {string} */ (meta['version']),
    stagingVersion: /** @type {string} */ (meta['staging_version']),
    trainBase: /** @type {string} */ (meta['train_base']),
    deployBase: /** @type {string} */ (meta['deploy_base']),
    targetSha: /** @type {string} */ (meta['target_sha']),
    stablePr: stablePrNum,
  };
};

// ---------------------------------------------------------------------------
// Validation (metadata format check)
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   version: string;
 *   stagingVersion: string;
 *   targetSha: string;
 *   baseRef: string;
 *   headRef: string;
 * }} ctx
 */
const validateMetadata = (ctx,) => {
  const { version, stagingVersion, targetSha, baseRef, headRef, } = ctx;

  if (!(/^v\d+\.\d+\.\d+$/u).test(version,)) {
    throw new Error(`Invalid version format: "${version}". Expected vX.Y.Z`,);
  }
  if (!(/^v\d+\.\d+\.\d+-rc\.\d+$/u).test(stagingVersion,)) {
    throw new Error(`Invalid staging_version format: "${stagingVersion}". Expected vX.Y.Z-rc.N`,);
  }
  if (!(/^[0-9a-f]{40}$/u).test(targetSha,)) {
    throw new Error(`Invalid target_sha: "${targetSha}". Expected 40-character hex SHA`,);
  }
  if (baseRef !== `releases/production/${version}`) {
    throw new Error(`base ref mismatch. expected: releases/production/${version}, got: ${baseRef}`,);
  }
  if (headRef !== `releases/production/${version}-draft`) {
    throw new Error(`head ref mismatch. expected: releases/production/${version}-draft, got: ${headRef}`,);
  }
};

// ---------------------------------------------------------------------------
// Pre-checks (no side effects)
// ---------------------------------------------------------------------------

/**
 * @param {string} version
 */
const assertTagNotExists = (version,) => {
  const result = spawnSync('git', [ 'rev-parse', '-q', '--verify', `refs/tags/${version}`, ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  },);
  if (result.status === 0) {
    throw new Error(`ERROR: Tag already exists: ${version}`,);
  }
};

/**
 * @param {string} version
 */
const assertReleaseNotExists = (version,) => {
  const result = spawnSync('gh', [ 'release', 'view', version, ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, },
  },);
  if (result.status === 0) {
    throw new Error(`ERROR: GitHub Release already exists: ${version}`,);
  }
  // Even if exit code != 0, treat errors other than "release not found" (e.g. auth failure) as check errors
  const stderr = (result.stderr ?? '').toLowerCase();
  if (!stderr.includes('release not found',) && !stderr.includes('not found',)) {
    throw new Error(`Failed to check GitHub Release existence for ${version} (unexpected error):\n${result.stderr}`,);
  }
};

/**
 * @param {string} branch
 * @returns {boolean}
 */
const branchExists = (branch,) => {
  const result = spawnSync('git', [ 'ls-remote', '--heads', 'origin', branch, ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  },);
  return result.status === 0 && 0 < result.stdout.trim().length;
};

/**
 * Verify that RC tag exists and points to the specified SHA
 * @param {string} stagingVersion
 * @param {string} targetSha
 */
const assertRcTagPointsToTargetSha = (stagingVersion, targetSha,) => {
  const result = spawnSync('git', [ 'rev-parse', '-q', '--verify', `refs/tags/${stagingVersion}`, ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  },);
  if (result.status !== 0) {
    throw new Error(`RC tag not found: ${stagingVersion}`,);
  }
  const rcTagCommitSha = git('rev-parse', [ `${stagingVersion}^{commit}`, ],);
  if (rcTagCommitSha !== targetSha) {
    throw new Error(`RC tag ${stagingVersion} does not point to targetSha.\n` +
      `  tag^{commit}: ${rcTagCommitSha}\n` +
      `  targetSha:    ${targetSha}`,);
  }
};

/**
 * Verify that the targetSha commit exists
 * @param {string} targetSha
 */
const assertTargetShaExists = (targetSha,) => {
  const result = spawnSync('git', [ 'cat-file', '-e', `${targetSha}^{commit}`, ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  },);
  if (result.status !== 0) {
    throw new Error(`targetSha commit not found: ${targetSha}`,);
  }
};

/**
 * Verify that the base branch (releases/production/${version}) exists on origin
 * @param {string} version
 */
const assertBaseBranchExists = (version,) => {
  if (!branchExists(`releases/production/${version}`,)) {
    throw new Error(`Base branch not found on origin: releases/production/${version}`,);
  }
};

/**
 * Verify that RC GitHub Release exists and its notes contain a checklist
 * @param {string} stagingVersion
 * @returns {string} RC Release notes body
 */
const fetchAndValidateRcReleaseNotes = (stagingVersion,) => {
  const result = spawnSync(
    'gh',
    [ 'release', 'view', stagingVersion, '--json', 'body', '--jq', '.body', ],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, }, },
  );
  if (result.status !== 0) {
    throw new Error(`RC GitHub Release not found: ${stagingVersion}\n${result.stderr}`,);
  }

  const releaseNotes = result.stdout.trim();
  if (!releaseNotes || releaseNotes === 'null') {
    throw new Error(`RC GitHub Release body is empty: ${stagingVersion}`,);
  }

  const hasSection = (/\n####\s+/u).test(releaseNotes,);
  const hasPullRequestEntry = (/\n\*\s+\[#\d+\]/u).test(releaseNotes,);
  if (!hasSection || !hasPullRequestEntry) {
    throw new Error(`Release notes for ${stagingVersion} do not contain changelog entries.\n` +
      `Got:\n${releaseNotes}`,);
  }

  return releaseNotes;
};

// ---------------------------------------------------------------------------
// Branch deletion (treated as warnings)
// ---------------------------------------------------------------------------

/**
 * Only allows deleting releases/production/v* branches. Failures are treated as warnings.
 * @param {string} branch
 */
const tryDeleteRemoteBranch = (branch,) => {
  if (!(/^releases\/production\/v/u).test(branch,)) {
    throw new Error(`Refusing to delete non-production release branch: ${branch}`,);
  }
  const result = spawnSync('git', [ 'push', 'origin', '--delete', branch, ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  },);
  if (result.status !== 0) {
    console.warn(`WARNING: Failed to delete branch ${branch}.`,);
    console.warn(result.stderr,);
  } else {
    console.log(`  Deleted branch: ${branch}`,);
  }
};

// ---------------------------------------------------------------------------
// Apply processing
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   version: string;
 *   targetSha: string;
 *   headRef: string;
 *   releaseNotes: string;
 * }} ctx
 */
const applyRelease = (ctx,) => {
  const { version, targetSha, headRef, releaseNotes, } = ctx;

  // ---- 1. Checkout production from targetSha and create release commit -----
  console.log(`\n[1/4] Creating production release commit on top of ${targetSha.slice(0, 8,)}...`,);
  execFileSync('git', [ 'checkout', '-B', 'production', targetSha, ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  execFileSync('git', [ 'commit', '--allow-empty', '-m', `chore: release production ${version}`, ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  execFileSync('git', [ 'push', '--force-with-lease', 'origin', 'production', ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  const productionReleaseSha = git('rev-parse', [ 'HEAD', ],);

  // ---- 2. Create production tag (annotated tag) --------------------------
  console.log(`\n[2/4] Creating annotated tag ${version} at ${productionReleaseSha.slice(0, 8,)}...`,);
  execFileSync(
    'git',
    [ 'tag', '-a', version, '-m', `Production release ${version}`, productionReleaseSha, ],
    { cwd: REPO_ROOT, stdio: 'inherit', },
  );
  execFileSync('git', [ 'push', 'origin', version, ], { cwd: REPO_ROOT, stdio: 'inherit', },);

  // Verify: check that annotated tag points to productionReleaseSha
  const tagCommitSha = git('rev-parse', [ `${version}^{commit}`, ],);
  if (tagCommitSha !== productionReleaseSha) {
    throw new Error(`Tag verification failed. tag^{commit}=${tagCommitSha}, expected=${productionReleaseSha}`,);
  }
  console.log(`Tag ${version} -> ${productionReleaseSha}`,);

  // ---- 3. Create GitHub Release (stable) --------------------------------
  console.log(`\n[3/4] Creating GitHub Release ${version}...`,);
  const releaseNotesPath = resolve(REPO_ROOT, 'PRODUCTION_RELEASE_NOTES.md',);
  writeFileSync(releaseNotesPath, releaseNotes,);

  gh([
    'release',
    'create',
    version,
    '--title',
    version,
    '--notes-file',
    releaseNotesPath,
    '--target',
    productionReleaseSha,
  ],);

  // ---- 4. Delete Production release branches (failures treated as warnings) -------
  console.log('\n[4/4] Deleting production release branches...',);

  // Always attempt to delete base branch
  tryDeleteRemoteBranch(`releases/production/${version}`,);

  // Head branch may already be auto-deleted by GitHub on merge; only attempt if it still exists
  if (branchExists(headRef,)) {
    tryDeleteRemoteBranch(headRef,);
  } else {
    console.log(`  ${headRef} already deleted (auto-deleted by GitHub on merge).`,);
  }

  console.log('\nAll done.',);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  // Load event
  const event = readGitHubEvent();
  const pr = event.pull_request;

  const pullRequestNumber = pr.number;
  const baseRef = pr.base.ref;
  const headRef = pr.head.ref;

  // Parse metadata from PR body
  const meta = parseReleaseProductionMeta(pr.body,);
  const { version, stagingVersion, trainBase, deployBase, targetSha, stablePr, } = meta;

  // Validate metadata
  validateMetadata({ version, stagingVersion, targetSha, baseRef, headRef, },);

  // Fetch refs and tags
  console.log('Fetching latest refs and tags...',);
  git('fetch', [
    'origin',
    '+refs/heads/production:refs/remotes/origin/production',
    `+refs/heads/releases/production/${version}:refs/remotes/origin/releases/production/${version}`,
    '+refs/tags/*:refs/tags/*',
  ],);

  // ---- Pre-checks (no side effects) -------------------------------------
  console.log('\nRunning pre-checks...',);

  assertTagNotExists(version,);
  console.log('  production tag:     not exists (ok)',);

  assertReleaseNotExists(version,);
  console.log('  production release: not exists (ok)',);

  assertRcTagPointsToTargetSha(stagingVersion, targetSha,);
  console.log(`  rc_tag_check:       ok  (${stagingVersion} -> ${targetSha.slice(0, 8,)}...)`,);

  assertTargetShaExists(targetSha,);
  console.log('  target_sha:         ok  (commit exists)',);

  assertBaseBranchExists(version,);
  console.log(`  base_branch:        ok  (releases/production/${version} exists)`,);

  const releaseNotes = fetchAndValidateRcReleaseNotes(stagingVersion,);
  console.log('  rc_release:         ok  (notes validated)',);

  // Optional check: verify head branch existence
  const headExists = branchExists(headRef,);
  console.log(`  head_branch:        ${headExists ? 'exists (will delete)' : 'not found (may have been auto-deleted, ok)'}`,);

  // Dry-run output
  console.log('',);
  console.log(`[context] pull_request_number: #${pullRequestNumber}`,);
  console.log(`[context] stable_pr:           #${stablePr}`,);
  console.log(`[context] version:             ${version}`,);
  console.log(`[context] staging_version:     ${stagingVersion}`,);
  console.log(`[context] train_base:          ${trainBase}`,);
  console.log(`[context] deploy_base:         ${deployBase}`,);
  console.log(`[context] target_sha:          ${targetSha.slice(0, 8,)}...`,);
  console.log(`[context] rc_tag_check:        ok  (${stagingVersion} -> ${targetSha.slice(0, 8,)}...)`,);
  console.log('[context] production_tag:      not exists (ok)',);
  console.log('[context] production_release:  not exists (ok)',);
  console.log('[context] rc_release:          exists (ok)',);
  console.log('[context] release_notes_guard: ok  (has sections and PR entries)',);
  console.log(`[context] production_branch:   production -> ${targetSha.slice(0, 8,)}... + chore: release production ${version}`,);
  console.log(`[context] tag_to_create:       ${version}  (at new production release commit)`,);
  console.log('',);

  if (isDryRun) {
    console.log('[dry-run] No git/gh operations performed.',);
    return;
  }

  // --apply: actually process
  applyRelease({ version, targetSha, headRef, releaseNotes, },);
};

main().catch((err,) => {
  console.error(err instanceof Error ? err.message : String(err,),);
  process.exit(1,);
},);
