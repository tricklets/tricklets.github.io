// @ts-check
/**
 * Stable Release post-processing script
 *
 * Usage:
 *   node .github/scripts/release/apply-staging.mjs --dry-run   # Preview only (no changes)
 *   node .github/scripts/release/apply-staging.mjs --apply     # Actually process
 *
 * Called from GitHub Actions after the Stable Release PR
 * (base: releases/stable/v*, head: releases/stable/v*-draft) is merged.
 *
 * Steps:
 *   1. Read metadata from PR body
 *   2. Validation (origin/main == target_sha, etc.)
 *   3. Squash merge into main
 *   4. Create RC tag (annotated)
 *   5. Fast-forward stable branch to RC tag
 *   6. Create GitHub Prerelease
 *   7. Close old Production Release PRs
 *   8. Create new Production Release PR
 */
import { execFileSync, spawnSync, } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, } from 'node:fs';
import { resolve, dirname, } from 'node:path';
import { fileURLToPath, } from 'node:url';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2,);
const isDryRun = args.includes('--dry-run',);
const isApply = args.includes('--apply',);

if (!isDryRun && !isApply) {
  console.error('Usage: node apply-staging.mjs --dry-run | --apply',);
  process.exit(1,);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url,),), '../../..',);
const REPO = process.env['GITHUB_REPOSITORY'];

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
 * @returns {unknown}
 */
const ghApi = (ghArgs,) => {
  const result = spawnSync('gh', [ 'api', ...ghArgs, ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, },
  },);
  if (result.status !== 0) {
    throw new Error(`gh api ${ghArgs.join(' ',)} failed:\n${result.stderr}`,);
  }
  return JSON.parse(result.stdout,);
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
 * @returns {{ pull_request: { number: number; base: { ref: string }; head: { ref: string; sha: string }; merged_commit_sha: string | null; body: string | null } }}
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
 * @returns {{ version: string; productionVersion: string; trainBase: string; deployBase: string; targetSha: string }}
 */
const parseReleaseStagingMeta = (body,) => {
  if (!body) { throw new Error('PR body is empty. Cannot parse release-staging metadata.',); }

  const match = (/<!-- release-staging\n(?<content>[\s\S]+?)\n-->/mu).exec(body,);
  if (!match) { throw new Error('No <!-- release-staging --> block found in PR body.',); }

  const required = [ 'version', 'production_version', 'train_base', 'deploy_base', 'target_sha', ];

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

  return {
    version: /** @type {string} */ (meta['version']),
    productionVersion: /** @type {string} */ (meta['production_version']),
    trainBase: /** @type {string} */ (meta['train_base']),
    deployBase: /** @type {string} */ (meta['deploy_base']),
    targetSha: /** @type {string} */ (meta['target_sha']),
  };
};
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   version: string;
 *   productionVersion: string;
 *   targetSha: string;
 *   baseRef: string;
 *   headRef: string;
 * }} ctx
 */
const validateMetadata = (ctx,) => {
  const { version, productionVersion, targetSha, baseRef, headRef, } = ctx;

  if (!(/^v\d+\.\d+\.\d+-rc\.\d+$/u).test(version,)) {
    throw new Error(`Invalid version format: "${version}". Expected vX.Y.Z-rc.N`,);
  }
  if (!(/^v\d+\.\d+\.\d+$/u).test(productionVersion,)) {
    throw new Error(`Invalid production_version format: "${productionVersion}". Expected vX.Y.Z`,);
  }
  if (!(/^[0-9a-f]{40}$/u).test(targetSha,)) {
    throw new Error(`Invalid target_sha: "${targetSha}". Expected 40-character hex SHA`,);
  }
  if (baseRef !== `releases/stable/${version}`) {
    throw new Error(`base ref mismatch. expected: releases/stable/${version}, got: ${baseRef}`,);
  }
  if (headRef !== `releases/stable/${version}-draft`) {
    throw new Error(`head ref mismatch. expected: releases/stable/${version}-draft, got: ${headRef}`,);
  }
};

/**
 * Verify that origin/main matches target_sha
 * @param {string} targetSha
 */
const validateMainSha = (targetSha,) => {
  const currentMainSha = git('rev-parse', [ 'origin/main', ],);
  if (currentMainSha !== targetSha) {
    console.error('ERROR: origin/main has advanced since this PR was created.',);
    console.error(`  expected: ${targetSha}`,);
    console.error(`  actual:   ${currentMainSha}`,);
    console.error('Re-run is not safe. Close this PR and create a new Staging Release PR.',);
    process.exit(1,);
  }
};

/**
 * Verify that the release branch exists on origin
 * @param {string} version
 */
const validateReleaseBranch = (version,) => {
  const result = spawnSync(
    'git',
    [ 'ls-remote', '--heads', 'origin', `releases/stable/${version}`, ],
    { cwd: REPO_ROOT, encoding: 'utf8', },
  );
  if (result.status !== 0 || result.stdout.trim().length === 0) {
    throw new Error(`Release branch not found on origin: releases/stable/${version}`,);
  }
};

// ---------------------------------------------------------------------------
// Branch existence check / tag and Release pre-checks
// ---------------------------------------------------------------------------

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
 * @param {string} productionVersion
 */
const checkNoBranchConflict = (productionVersion,) => {
  const base = `releases/production/${productionVersion}`;
  const draft = `releases/production/${productionVersion}-draft`;

  for (const branch of [ base, draft, ]) {
    if (branchExists(branch,)) {
      console.error(`ERROR: Branch already exists: ${branch}`,);
      console.error('Re-run is not safe. Delete the branch and retry.',);
      process.exit(1,);
    }
  }
};

/**
 * Error if the RC tag already exists (call before squash merge)
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
 * Error if the GitHub Release already exists (call before squash merge)
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
 * Safe-guarded deletion that only allows deleting releases/production/v* or releases/stable/v* branches
 * @param {string} branch
 */
const deleteRemoteBranch = (branch,) => {
  if (!(/^releases\/(?:production|stable)\/v/u).test(branch,)) {
    throw new Error(`Refusing to delete non-release branch: ${branch}`,);
  }
  execFileSync('git', [ 'push', 'origin', '--delete', branch, ], { cwd: REPO_ROOT, stdio: 'inherit', },);
};

// ---------------------------------------------------------------------------
// Fetch staging decision comment
// ---------------------------------------------------------------------------

/**
 * @param {number} pullRequestNumber
 * @returns {string | null}
 */
const fetchDecisionComment = (pullRequestNumber,) => {
  if (!REPO) { throw new Error('GITHUB_REPOSITORY environment variable is not set.',); }

  /** @type {Array<{ body: string | null }>} */
  const comments = /** @type {any} */ (
    ghApi([ `/repos/${REPO}/issues/${pullRequestNumber}/comments`, ],)
  );
  if (!Array.isArray(comments,)) { return null; }

  const found = comments.find((comment,) => comment.body && comment.body.startsWith('<!-- templates-release-decision --',),);
  return found?.body ?? null;
};

/**
 * Extract Production release scheduled date from decision comment
 * @param {string} decisionBody
 * @returns {string}
 */
const extractProductionDate = (decisionBody,) => {
  const match = (/^\|\s*Production\s*\|\s*(?<date>[^|]+?)\s*\|/mu).exec(decisionBody,);
  return match?.groups?.date?.trim() ?? '';
};

/**
 * Extract details section from decision comment
 * @param {string} decisionBody
 * @returns {string}
 */
const extractDetails = (decisionBody,) => {
  const match = (/(?<details>### 詳細[\s\S]+?)### 対象範囲/u).exec(decisionBody,);
  return match?.groups?.details?.trim() ?? '';
};

/**
 * Extract release schedule table from decision comment
 * @param {string} decisionBody
 * @returns {string}
 */
const extractSchedule = (decisionBody,) => {
  const match = (/(?<schedule>### リリース・スケジュール[\s\S]*?)(?:\n\n----|\n\n### |\n*$)/u).exec(decisionBody,);
  if (!match) { return ''; }

  // Move "本プルリクエストのマージをもってリリース" note from QAS row to Production row for the Production PR.
  // - QAS row:        Remove "本プルリクエストのマージをもってリリース"
  // - Production row: Append "本プルリクエストのマージをもってリリース"
  const NOTE = '本プルリクエストのマージをもってリリース';
  let schedule = (match.groups?.schedule ?? '').trim();
  schedule = schedule.replace(
    /^(?<qasRow>\|\s*QAS\s*\|[^|]+\|)\s*本プルリクエストのマージをもってリリース\s*(?<qasEnd>\|)/mu,
    '$<qasRow> $<qasEnd>',
  );
  schedule = schedule.replace(
    /^(?<prdRow>\|\s*Production\s*\|[^|]+\|)\s*(?<prdEnd>\|)/mu,
    `$<prdRow> ${NOTE} $<prdEnd>`,
  );
  return schedule;
};

// ---------------------------------------------------------------------------
// Release notes generation (first section of CHANGELOG.md)
// ---------------------------------------------------------------------------

/**
 * @returns {string}
 */
const extractReleaseNotes = () => {
  const changelogPath = resolve(REPO_ROOT, 'CHANGELOG.md',);
  if (!existsSync(changelogPath,)) { return ''; }
  const content = readFileSync(changelogPath, 'utf8',).trim();
  return content.split('\n## ',)[0].trim();
};

// ---------------------------------------------------------------------------
// Production PR body generation
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   version: string;
 *   stagingVersion: string;
 *   trainBase: string;
 *   deployBase: string;
 *   targetSha: string;
 *   stablePr: number;
 *   prdDate: string;
 *   details: string;
 *   schedule: string;
 * }} ctx
 * @returns {string}
 */
const buildProductionPRBody = (ctx,) => {
  const { version, stagingVersion, trainBase, deployBase, targetSha, stablePr, prdDate, details, schedule, } = ctx;

  const templatePath = resolve(REPO_ROOT, '.github/templates/release-production.md',);
  if (!existsSync(templatePath,)) {
    throw new Error('Template not found: .github/templates/release-production.md',);
  }

  let body = readFileSync(templatePath, 'utf8',);
  /* eslint-disable no-template-curly-in-string -- intentional literal placeholders in template file */
  body = body.replaceAll('${REPLACE_VERSION}', version,);
  body = body.replaceAll('${REPLACE_STAGING_VERSION}', stagingVersion,);
  body = body.replaceAll('${REPLACE_TRAIN_BASE}', trainBase,);
  body = body.replaceAll('${REPLACE_DEPLOY_BASE}', deployBase,);
  body = body.replaceAll('${REPLACE_TARGET_SHA}', targetSha,);
  body = body.replaceAll('${REPLACE_STABLE_PR}', String(stablePr,),);
  body = body.replaceAll('${REPLACE_PRD_DATE}', prdDate,);
  body = body.replaceAll('${REPLACE_DETAILS}', details,);
  body = body.replaceAll('${REPLACE_SCHEDULE}', schedule,);
  /* eslint-enable no-template-curly-in-string -- / */
  return body;
};

// ---------------------------------------------------------------------------
// Apply processing
// ---------------------------------------------------------------------------

/**
 * List open Production Release PRs (only those with releases/production/v* head)
 * @returns {Array<{ number: number; headRefName: string; baseRefName: string }>}
 */
const listOpenProductionPRs = () => {
  const result = spawnSync(
    'gh',
    [ 'pr', 'list', '--state', 'open', '--label', 'Type: Release', '--json', 'number,headRefName,baseRefName', ],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, }, },
  );
  if (result.status !== 0) {
    throw new Error(`gh pr list failed:\n${result.stderr}`,);
  }

  /** @type {Array<{ number: number; headRefName: string; baseRefName: string }>} */
  const all = JSON.parse(result.stdout || '[]',);
  return all.filter((pr,) => (/^releases\/production\/v/u).test(pr.headRefName,),);
};

/**
 * @param {{
 *   version: string;
 *   productionVersion: string;
 *   trainBase: string;
 *   deployBase: string;
 *   targetSha: string;
 *   pullRequestNumber: number;
 * }} ctx
 */
const applyRelease = (ctx,) => {
  const { version, productionVersion, trainBase, deployBase, pullRequestNumber, } = ctx;

  // ---- Pre-checks (no side effects) -----------------------------------
  console.log('\nRunning pre-checks...',);

  // Verify RC tag and GitHub Release do not exist yet
  assertTagNotExists(version,);
  assertReleaseNotExists(version,);

  // List old Production PRs (close/delete will happen after Stable Release completes)
  const oldProductionPRs = listOpenProductionPRs();
  console.log(`  Old Production PRs to close: ${0 < oldProductionPRs.length ? oldProductionPRs.map((pr,) => `#${pr.number}`,).join(', ',) : 'none'}`,);

  // ---- 1. Squash merge into main --------------------------------------
  console.log(`\n[1/8] Squash merging releases/stable/${version} into main...`,);
  execFileSync('git', [ 'checkout', '-B', 'main', 'origin/main', ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  execFileSync('git', [ 'merge', '--squash', `origin/releases/stable/${version}`, ], { cwd: REPO_ROOT, stdio: 'inherit', },);

  // Guard against empty commit
  const diffResult = spawnSync('git', [ 'diff', '--cached', '--quiet', ], { cwd: REPO_ROOT, },);
  if (diffResult.status === 0) {
    console.error('ERROR: Squash merge produced no changes. Nothing to commit.',);
    process.exit(1,);
  }

  execFileSync('git', [ 'commit', '-m', `chore: release staging ${version}`, ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  execFileSync('git', [ 'push', 'origin', 'main', ], { cwd: REPO_ROOT, stdio: 'inherit', },);

  // ---- 2. Create RC tag (annotated tag) --------------------------------
  console.log(`\n[2/8] Creating annotated tag ${version}...`,);
  const releaseSha = git('rev-parse', [ 'HEAD', ],);

  execFileSync('git', [ 'tag', '-a', version, '-m', `Staging release ${version}`, releaseSha, ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  execFileSync('git', [ 'push', 'origin', version, ], { cwd: REPO_ROOT, stdio: 'inherit', },);

  // Verify: check that annotated tag points to releaseSha
  const tagCommitSha = git('rev-parse', [ `${version}^{commit}`, ],);
  if (tagCommitSha !== releaseSha) {
    throw new Error(`Tag verification failed. tag^{commit}=${tagCommitSha}, expected=${releaseSha}`,);
  }
  console.log(`Tag ${version} -> ${releaseSha}`,);

  // ---- 3. Fast-forward stable to RC tag --------------------------------
  console.log(`\n[3/8] Fast-forwarding stable to ${version}...`,);
  execFileSync('git', [ 'checkout', '-B', 'stable', 'origin/stable', ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  execFileSync('git', [ 'merge', '--ff-only', version, ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  execFileSync('git', [ 'push', 'origin', 'stable', ], { cwd: REPO_ROOT, stdio: 'inherit', },);

  // ---- 4. Create GitHub Release (prerelease) ---------------------------
  console.log(`\n[4/8] Creating GitHub Release ${version}...`,);
  const releaseNotes = extractReleaseNotes();

  const hasSection = (/\n####\s+/u).test(releaseNotes,);
  const hasPullRequestEntry = (/\n\*\s+\[#\d+\]/u).test(releaseNotes,);
  if (!hasSection || !hasPullRequestEntry) {
    throw new Error(`Release notes for ${version} do not contain changelog entries.\n` +
      `Got:\n${releaseNotes}`,);
  }

  const releaseNotesPath = resolve(REPO_ROOT, 'RELEASE_NOTES.md',);
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
    releaseSha,
    '--prerelease',
  ],);

  // Also attach RELEASE_NOTES.md as an asset
  gh([ 'release', 'upload', version, releaseNotesPath, '--clobber', ],);

  // ---- 5. Close old Production Release PRs and delete their branches ---
  // Execute after Stable Release (main / tag / stable / GitHub Release) completes.
  // If this fails, the existing Production decision PR remains, preserving a rollback path.
  console.log('\n[5/8] Closing and deleting old Production Release PRs...',);
  for (const pr of oldProductionPRs) {
    console.log(`  Closing PR #${pr.number} (${pr.headRefName})...`,);
    gh([ 'pr',
      'close',
      String(pr.number,),
      '--comment',
      `Superseded by staging release ${version}. A new Production Release PR has been created.`, ],);
    deleteRemoteBranch(pr.headRefName,);
    if ((/^releases\/production\/v/u).test(pr.baseRefName,)) {
      deleteRemoteBranch(pr.baseRefName,);
    }
  }

  // ---- 6. Check that Production branches don't exist (after old ones deleted) ---
  console.log('\n[6/8] Checking Production branches don\'t exist...',);
  checkNoBranchConflict(productionVersion,);

  // ---- 7. Create Production Release PR ---------------------------------
  console.log(`\n[7/8] Creating Production Release PR for ${productionVersion}...`,);

  const baseBranch = `releases/production/${productionVersion}`;
  const draftBranch = `releases/production/${productionVersion}-draft`;

  // Base branch (starting from RC tag)
  execFileSync('git', [ 'checkout', '-b', baseBranch, version, ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  execFileSync('git', [ 'push', 'origin', baseBranch, ], { cwd: REPO_ROOT, stdio: 'inherit', },);

  // Draft branch (empty commit)
  execFileSync('git', [ 'checkout', '-b', draftBranch, ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  execFileSync('git', [ 'commit', '--allow-empty', '-m', `chore: release production ${productionVersion}`, ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  execFileSync('git', [ 'push', 'origin', draftBranch, ], { cwd: REPO_ROOT, stdio: 'inherit', },);

  // Build PR body (extracted from staging decision comment)
  const decisionBody = fetchDecisionComment(pullRequestNumber,);
  const prdDate = decisionBody ? extractProductionDate(decisionBody,) : '';
  const details = decisionBody ? extractDetails(decisionBody,) : '';
  const schedule = decisionBody ? extractSchedule(decisionBody,) : '';

  const prBody = buildProductionPRBody({
    version: productionVersion,
    stagingVersion: version,
    trainBase,
    deployBase,
    targetSha: releaseSha,
    stablePr: pullRequestNumber,
    prdDate,
    details,
    schedule,
  },);

  const prBodyPath = resolve(REPO_ROOT, 'PRODUCTION_PR_BODY.md',);
  writeFileSync(prBodyPath, prBody,);

  gh([
    'pr',
    'create',
    '--base',
    baseBranch,
    '--head',
    draftBranch,
    '--title',
    `chore: release production ${productionVersion}`,
    '--label',
    'Type: Release',
    '--body-file',
    prBodyPath,
  ],);

  console.log(`\nDone. Production Release PR for ${productionVersion} created.`,);

  // ---- 8. Delete stable release branches --------------------------------
  console.log('\n[8/8] Deleting stable release branches...',);

  // Base branch (releases/stable/${version}) is not auto-deleted, so delete explicitly
  deleteRemoteBranch(`releases/stable/${version}`,);

  // Draft branch (releases/stable/${version}-draft) may already be deleted by GitHub's
  // Auto-delete on merge. Only attempt deletion if it still exists.
  const draftStagingBranch = `releases/stable/${version}-draft`;
  if (branchExists(draftStagingBranch,)) {
    deleteRemoteBranch(draftStagingBranch,);
  } else {
    console.log(`  ${draftStagingBranch} already deleted (auto-deleted by GitHub on merge).`,);
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
  const meta = parseReleaseStagingMeta(pr.body,);
  const { version, productionVersion, trainBase, deployBase, targetSha, } = meta;

  // Validate metadata
  validateMetadata({ version, productionVersion, targetSha, baseRef, headRef, },);

  // Fetch refs and tags
  console.log('Fetching latest refs and tags...',);
  git('fetch', [
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
    '+refs/heads/stable:refs/remotes/origin/stable',
    '+refs/heads/production:refs/remotes/origin/production',
    '+refs/heads/releases/stable/*:refs/remotes/origin/releases/stable/*',
    '+refs/tags/*:refs/tags/*',
  ],);

  // Verify release branch exists
  validateReleaseBranch(version,);

  // Get SHA of release branch
  const releaseBranchSha = git('rev-parse', [ `origin/releases/stable/${version}`, ],);

  // Verify origin/main == target_sha
  validateMainSha(targetSha,);

  // Dry-run output
  console.log('',);
  console.log(`[context] stable_pr:          #${pullRequestNumber}`,);
  console.log(`[context] version:            ${version}`,);
  console.log(`[context] production_version: ${productionVersion}`,);
  console.log(`[context] train_base:         ${trainBase}`,);
  console.log(`[context] deploy_base:        ${deployBase}`,);
  console.log(`[context] target_sha:         ${targetSha.slice(0, 8,)}...  (origin/main HEAD)`,);
  console.log(`[context] release_branch:     releases/stable/${version}`,);
  console.log(`[context] release_branch_sha: ${releaseBranchSha.slice(0, 8,)}...`,);
  console.log('[context] main_check:         ok  (origin/main == target_sha)',);
  console.log(`[context] tag_to_create:      ${version}`,);
  console.log(`[context] stable_update:      stable -> ${version} tag commit (determined after merge)`,);
  console.log(`[context] production_pr:      chore: release production ${productionVersion}`,);
  console.log('',);

  if (isDryRun) {
    console.log('[dry-run] No git/gh operations performed.',);
    return;
  }

  // --apply: actually process
  applyRelease({ version, productionVersion, trainBase, deployBase, targetSha, pullRequestNumber, },);
};

main().catch((err,) => {
  console.error(err instanceof Error ? err.message : String(err,),);
  process.exit(1,);
},);
