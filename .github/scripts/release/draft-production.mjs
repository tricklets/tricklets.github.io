// @ts-check
/**
 * Production Release PR creation script
 *
 * Usage:
 *   node .github/scripts/release/draft-production.mjs --dry-run   # Preview only (no changes)
 *   node .github/scripts/release/draft-production.mjs --apply     # Actually create the PR
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
  console.error('Usage: node draft-production.mjs --dry-run | --apply',);
  process.exit(1,);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url,),), '../../..',);

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
// Version comparison (version tuple approach)
// String comparison would give v0.2.9 > v0.10.0, so numeric tuples are used
// ---------------------------------------------------------------------------

/**
 * @param {string} tag
 * @returns {{ tag: string; major: number; minor: number; patch: number } | null}
 */
const parseNormalVersion = (tag,) => {
  const match = (/^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u).exec(tag,);
  if (!match?.groups) { return null; }
  return {
    tag,
    major: Number(match.groups['major'],),
    minor: Number(match.groups['minor'],),
    patch: Number(match.groups['patch'],),
  };
};

/**
 * @param {{ major: number; minor: number; patch: number }} lhs
 * @param {{ major: number; minor: number; patch: number }} rhs
 * @returns {number}
 */
const compareVersion = (lhs, rhs,) => lhs.major - rhs.major || lhs.minor - rhs.minor || lhs.patch - rhs.patch;

/**
 * @param {{ major: number; minor: number; patch: number }} ver
 * @param {'major' | 'minor' | 'patch'} level
 * @returns {string}
 */
const bumpVersion = (ver, level,) => {
  if (level === 'major') { return `v${ver.major + 1}.0.0`; }
  if (level === 'minor') { return `v${ver.major}.${ver.minor + 1}.0`; }
  return `v${ver.major}.${ver.minor}.${ver.patch + 1}`;
};

// ---------------------------------------------------------------------------
// Tag classification
// ---------------------------------------------------------------------------

/** @param {string} tag */
const isHotfixTag = (tag,) => (/^v\d+\.\d+\.\d+_\d+$/u).test(tag,);

// ---------------------------------------------------------------------------
// ReleaseContext construction
// ---------------------------------------------------------------------------

/**
 * TrainBase: latest normal tag that has reached production
 * @returns {string}
 */
const resolveTrainBase = () => {
  const raw = git('tag', [ '--merged', 'origin/production', '--list', 'v*', ],);
  const tags = raw.split('\n',).filter(Boolean,);
  const parsed = tags.map(parseNormalVersion,).filter((ver,) => ver !== null,);
  if (parsed.length === 0) {
    throw new Error('No normal version tag found in origin/production. Cannot determine trainBase.',);
  }
  parsed.sort(compareVersion,);
  return parsed[parsed.length - 1].tag;
};

/**
 * DeployBase: tag at production branch HEAD, or SHA if none exists
 * When multiple hotfix tags exist, the one with the highest trailing number is selected
 * @returns {string}
 */
const resolveDeployBase = () => {
  try {
    const tags = git('tag', [ '--points-at', 'origin/production', ],).split('\n',).filter(Boolean,);
    // Prefer hotfix tags (when multiple exist, pick the one with the highest trailing number)
    const hotfixTags = tags.filter(isHotfixTag,);
    if (0 < hotfixTags.length) {
      hotfixTags.sort((lhs, rhs,) => {
        const na = parseInt((/(?<n>\d+)$/u).exec(lhs,)?.groups?.['n'] ?? '0', 10,);
        const nb = parseInt((/(?<n>\d+)$/u).exec(rhs,)?.groups?.['n'] ?? '0', 10,);
        return na - nb;
      },);
      return hotfixTags[hotfixTags.length - 1];
    }
    const normalTags = tags.map(parseNormalVersion,).filter((ver,) => ver !== null,);
    if (0 < normalTags.length) {
      normalTags.sort(compareVersion,);
      return normalTags[normalTags.length - 1].tag;
    }
    // RC tags should not be used as deployBase
  } catch {
    // Fall back to SHA if tag retrieval fails
  }
  return git('rev-parse', [ 'origin/production', ],);
};

/**
 * TargetSha: origin/main HEAD (full SHA)
 * @returns {string}
 */
const resolveTargetSha = () => git('rev-parse', [ 'origin/main', ],);

// ---------------------------------------------------------------------------
// PR collection
// ---------------------------------------------------------------------------

const REPO = process.env['GITHUB_REPOSITORY'];

/**
 * Collects PRs associated with commits between trainBase and targetSha
 * - Excludes PRs with label "Type: Release"
 * - Deduplication applied
 * @param {string} trainBase
 * @param {string} targetSha
 * @returns {Array<{ number: number; title: string; url: string; labels: string[]; author: string; authorUrl: string }>}
 */
const collectPRs = (trainBase, targetSha,) => {
  if (!REPO) { throw new Error('GITHUB_REPOSITORY environment variable is not set.',); }

  const shas = git('log', [ `${trainBase}..${targetSha}`, '--format=%H', ],).split('\n',).filter(Boolean,);

  /** @type {Map<number, { number: number; title: string; url: string; labels: string[]; author: string; authorUrl: string }>} */
  const prMap = new Map();

  for (const sha of shas) {

    /** @type {Array<{ number: number; title: string; html_url: string; labels: Array<{ name: string }>; user: { login: string; html_url: string } }>} */
    const prs = /** @type {any} */ (ghApi([ `/repos/${REPO}/commits/${sha}/pulls`, '-H', 'Accept: application/vnd.github+json', ],));
    if (!Array.isArray(prs,)) { continue; }

    for (const pr of prs) {
      if (prMap.has(pr.number,)) { continue; }
      const labels = pr.labels.map((/** @type {{ name: string }} */ item,) => item.name,);
      if (labels.includes('Type: Release',)) { continue; }
      prMap.set(pr.number, {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        labels,
        author: pr.user.login,
        authorUrl: pr.user.html_url,
      },);
    }
  }

  return Array.from(prMap.values(),).sort((lhs, rhs,) => lhs.number - rhs.number,);
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ number: number; title: string; labels: string[] }>} prs
 * @param {string} trainBase
 */
const validatePRs = (prs, trainBase,) => {
  if (prs.length === 0) {
    console.error(`ERROR: No releasable pull requests found between ${trainBase} and origin/main.`,);
    process.exit(1,);
  }

  const unlabeled = prs.filter((pr,) => !pr.labels.some((label,) => label.startsWith('Type:',),),);
  if (0 < unlabeled.length) {
    console.error('ERROR: The following PRs have no Type:* label. Add a label before running release.',);
    for (const pr of unlabeled) {
      console.error(`  #${pr.number} ${pr.title}`,);
    }
    process.exit(1,);
  }
};

// ---------------------------------------------------------------------------
// Version calculation
// ---------------------------------------------------------------------------

/**
 * Determines the bump level from PR labels
 * @param {Array<{ labels: string[] }>} prs
 * @returns {'major' | 'minor' | 'patch'}
 */
const resolveBumpLevel = (prs,) => {
  const allLabels = prs.flatMap((pr,) => pr.labels,);
  if (allLabels.includes('Type: Breaking',)) { return 'major'; }
  if (
    allLabels.some((label,) => [ 'Type: Feature', 'Type: Enhancement', 'Type: Security', ].includes(label,),)
  ) { return 'minor'; }
  return 'patch';
};

// ---------------------------------------------------------------------------
// Branch existence check
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
 * @param {string} version  e.g. "v0.3.0"
 */
const checkNoBranchConflict = (version,) => {
  const base = `releases/production/${version}`;
  const draft = `releases/production/${version}-draft`;

  for (const branch of [ base, draft, ]) {
    if (branchExists(branch,)) {
      console.error(`ERROR: Branch already exists: ${branch}`,);
      console.error('Re-run is not safe. Delete the branch and retry.',);
      process.exit(1,);
    }
  }
};

// ---------------------------------------------------------------------------
// CHANGELOG generation
// ---------------------------------------------------------------------------

/** @type {{ changelog: { labels: Record<string, string> } }} */
const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json',), 'utf8',),);
const LABEL_MAP = packageJson.changelog.labels;
const LABEL_ORDER = Object.keys(LABEL_MAP,);

/**
 * @param {Array<{ number: number; title: string; url: string; labels: string[]; author: string; authorUrl: string }>} prs
 * @param {string} version
 * @returns {string}
 */
const generateChangelog = (prs, version,) => {
  const today = new Date().toISOString().slice(0, 10,);
  const lines = [ `## ${version} (${today})`, '', ];

  /** @type {Map<string, Array<{ number: number; title: string; url: string; author: string; authorUrl: string }>>} */
  const sections = new Map();

  for (const pr of prs) {
    // Expand all defined Type:* labels and register entries into sections
    const matchedLabels = LABEL_ORDER.filter((label,) => pr.labels.includes(label,),);
    if (matchedLabels.length === 0) {
      // PRs with only undefined Type:* labels go into Other Changes
      if (!sections.has('_other',)) { sections.set('_other', [],); }
      sections.get('_other',)?.push(pr,);
    } else {
      for (const label of matchedLabels) {
        if (!sections.has(label,)) { sections.set(label, [],); }
        sections.get(label,)?.push(pr,);
      }
    }
  }

  // Output in definition order
  for (const label of LABEL_ORDER) {
    const entries = sections.get(label,);
    if (!entries || entries.length === 0) { continue; }
    const heading = LABEL_MAP[label]; // eslint-disable-line security/detect-object-injection -- label is validated against LABEL_ORDER
    lines.push(`#### ${heading}`,);
    for (const pr of entries) {
      lines.push(`* [#${pr.number}](${pr.url}) ${pr.title} ([@${pr.author}](${pr.authorUrl}))`,);
    }
    lines.push('',);
  }

  // PRs with undefined labels
  const otherEntries = sections.get('_other',);
  if (otherEntries && 0 < otherEntries.length) {
    lines.push('#### Other Changes',);
    for (const pr of otherEntries) {
      lines.push(`* [#${pr.number}](${pr.url}) ${pr.title} ([@${pr.author}](${pr.authorUrl}))`,);
    }
    lines.push('',);
  }

  // Committers
  const committers = [ ...new Set(prs.map((pr,) => pr.author,),), ].sort();
  lines.push(`#### Committers: ${committers.length}`,);
  for (const committer of committers) {
    const authorUrl = prs.find((pr,) => pr.author === committer,)?.authorUrl ?? '';
    lines.push(`- [@${committer}](${authorUrl})`,);
  }
  lines.push('',);

  return lines.join('\n',);
};

// ---------------------------------------------------------------------------
// Package.json version update
// ---------------------------------------------------------------------------

/**
 * @param {string} version  e.g. "0.3.0" (without "v" prefix)
 */
const updatePackageJsonVersion = (version,) => {
  const path = resolve(REPO_ROOT, 'package.json',);
  const pkg = JSON.parse(readFileSync(path, 'utf8',),);
  pkg.version = version;
  // JSON.stringify does not append a trailing newline, so it is added manually
  writeFileSync(path, `${JSON.stringify(pkg, null, 2,)}\n`,);
};

// ---------------------------------------------------------------------------
// Branch creation, commit, and PR creation
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   trainBase: string;
 *   deployBase: string;
 *   targetSha: string;
 *   version: string;
 *   prs: Array<{ number: number; title: string; url: string; labels: string[]; author: string; authorUrl: string }>;
 *   changelog: string;
 * }} ctx
 */
const applyRelease = (ctx,) => {
  const { trainBase, deployBase, targetSha, version, prs, changelog, } = ctx;
  const actor = process.env['GITHUB_ACTOR'] ?? '';
  const baseBranch = `releases/production/${version}`;
  const draftBranch = `releases/production/${version}-draft`;

  // Create base branch
  console.log(`Creating base branch: ${baseBranch}`,);
  execFileSync('git', [ 'checkout', '-b', baseBranch, 'origin/main', ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  execFileSync('git', [ 'push', 'origin', baseBranch, ], { cwd: REPO_ROOT, stdio: 'inherit', },);

  // Create draft branch
  console.log(`Creating draft branch: ${draftBranch}`,);
  execFileSync('git', [ 'checkout', '-b', draftBranch, ], { cwd: REPO_ROOT, stdio: 'inherit', },);

  // Update CHANGELOG.md (prepend to top)
  const changelogPath = resolve(REPO_ROOT, 'CHANGELOG.md',);
  const existing = existsSync(changelogPath,) ? readFileSync(changelogPath, 'utf8',) : '';
  writeFileSync(changelogPath, changelog + (existing ? `\n${existing}` : ''),);

  // Update package.json version (strip "v" prefix)
  updatePackageJsonVersion(version.replace(/^v/u, '',),);

  // Commit
  execFileSync('git', [ 'add', 'package.json', 'CHANGELOG.md', ], { cwd: REPO_ROOT, stdio: 'inherit', },);
  execFileSync(
    'git',
    [ 'commit', '-m', `chore: release production ${version}`, ],
    { cwd: REPO_ROOT, stdio: 'inherit', },
  );
  execFileSync('git', [ 'push', 'origin', draftBranch, ], { cwd: REPO_ROOT, stdio: 'inherit', },);

  // Build PR body
  const prBody = buildPRBody({ trainBase, deployBase, targetSha, version, baseBranch, prs, changelog, },);

  // Create PR
  console.log('Creating production release PR...',);
  const ghArgs = [
    'pr',
    'create',
    '--base',
    baseBranch,
    '--head',
    draftBranch,
    '--title',
    `chore: release production ${version}`,
    '--label',
    'Type: Release',
    '--body',
    prBody,
  ];
  if (actor && 0 < actor.length && actor.length < 100) {
    ghArgs.push('--assignee', actor,);
  }
  gh(ghArgs,);
};

/**
 * Calculates the next Thursday date string
 * @returns {string}  e.g. "2026-06-12 (木)"
 */
const resolveProductionDate = () => {
  const day = [ '日', '月', '火', '水', '木', '金', '土', ];
  const date = new Date();
  date.setDate(date.getDate() + (4 - date.getDay() + 7) % 7,);
  return `${date.getFullYear()}-${String(date.getMonth() + 1,).padStart(2, '0',)}-${String(date.getDate(),).padStart(2, '0',)} (${day[date.getDay()]})`;
};

/**
 * Builds the PR body
 * @param {{
 *   trainBase: string;
 *   deployBase: string;
 *   targetSha: string;
 *   version: string;
 *   baseBranch: string;
 *   prs: Array<{ number: number; title: string; url: string; labels: string[] }>;
 *   changelog: string;
 * }} ctx
 * @returns {string}
 */
const buildPRBody = (ctx,) => {
  const { trainBase, deployBase, targetSha, version, baseBranch, prs, changelog, } = ctx;

  const meta = [
    '<!-- release-production',
    `version=${version}`,
    `train_base=${trainBase}`,
    `deploy_base=${deployBase}`,
    `target_sha=${targetSha}`,
    '-->',
  ].join('\n',);

  // Build change list for the decision template (matching the former comment job format)
  const changeLines = prs.map((pr,) => `* [#${pr.number}](${pr.url}) ${pr.title}`,);
  const changeList = [
    'ソースコード',
    ...changeLines,
    `* [Compare](../compare/production...${baseBranch}) production...${baseBranch}`,
  ].join('\n',);

  // Load and fill the release decision template
  const templatePath = resolve(REPO_ROOT, '.github/templates/release-decision.md',);
  let decision = readFileSync(templatePath, 'utf8',);

  // Split changelog: first line is "## vX.Y.Z (date)", rest is the body
  const changelogLines = changelog.split('\n',);
  const changelogTitle = changelogLines[0].replace(/^##\s*/u, '',).trim();
  const changelogBody = changelogLines.slice(1,).join('\n',).trimStart();

  /* eslint-disable no-template-curly-in-string -- intentional literal placeholders in template file */
  decision = decision.replace('${REPLACE_VERSION}', changelogTitle,);
  decision = decision.replace('${REPLACE_CHANGELOG}', changelogBody,);
  decision = decision.replace('${REPLACE_CHANGE_LIST}', changeList,);
  decision = decision.replace('${REPLACE_PRD_DATE}', resolveProductionDate(),);
  /* eslint-enable no-template-curly-in-string */

  return [
    meta,
    '',
    decision.trimEnd(),
  ].join('\n',);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  console.log('Fetching latest refs and tags...',);
  git('fetch', [
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
    '+refs/heads/production:refs/remotes/origin/production',
    '+refs/tags/*:refs/tags/*',
  ],);

  // Resolve context
  const trainBase = resolveTrainBase();
  const deployBase = resolveDeployBase();
  const targetSha = resolveTargetSha(); // Full SHA

  // Collect PRs
  console.log(`Collecting PRs: ${trainBase}..${targetSha.slice(0, 8,)}...`,);
  const prs = collectPRs(trainBase, targetSha,);

  // Validation (empty check -> label check)
  validatePRs(prs, trainBase,);

  // Calculate version
  const bumpLevel = resolveBumpLevel(prs,);
  const trainParsed = parseNormalVersion(trainBase,);
  if (!trainParsed) { throw new Error(`Cannot parse trainBase as version: ${trainBase}`,); }
  const version = bumpVersion(trainParsed, bumpLevel,);

  // Branch conflict check (after context is finalized)
  checkNoBranchConflict(version,);

  // Generate CHANGELOG
  const changelog = generateChangelog(prs, version,);

  // Dry-run output
  console.log('',);
  console.log(`[context] train_base:   ${trainBase}`,);
  console.log(`[context] deploy_base:  ${deployBase}`,);
  console.log(`[context] target_sha:   ${targetSha.slice(0, 8,)}...  (full SHA used in PR body)`,);
  console.log(`[context] version:      ${version}`,);
  console.log(`[context] bump_level:   ${bumpLevel}`,);
  console.log('',);
  console.log(`[context] Changes (${prs.length} PRs):`,);
  for (const pr of prs) {
    const typeLabels = pr.labels.filter((label,) => label.startsWith('Type:',),).join(', ',) || 'unlabeled';
    console.log(`  #${pr.number} [${typeLabels}]  ${pr.title}`,);
  }
  console.log('',);

  if (isDryRun) {
    console.log('[dry-run] CHANGELOG preview:',);
    console.log(changelog,);
    console.log('[dry-run] No branches/commits/PRs created.',);
    return;
  }

  // --apply: actually create the PR
  applyRelease({ trainBase, deployBase, targetSha, version, prs, changelog, },);
  console.log(`\nDone. Production release PR for ${version} created.`,);
};

main().catch((err,) => {
  console.error(err instanceof Error ? err.message : String(err,),);
  process.exit(1,);
},);
