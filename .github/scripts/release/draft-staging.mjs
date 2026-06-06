#!/usr/bin/env node
// @ts-check
/**
 * Staging Release PR 起票スクリプト
 *
 * Usage:
 *   node .github/scripts/release/draft-staging.mjs --dry-run   # 確認用（変更なし）
 *   node .github/scripts/release/draft-staging.mjs --apply     # 実際に起票
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// CLI フラグ
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isApply = args.includes('--apply');

if (!isDryRun && !isApply) {
  console.error('Usage: node draft-staging.mjs --dry-run | --apply');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {string}
 */
function git(cmd, args, opts = {}) {
  const result = spawnSync('git', [cmd, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${cmd} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * @param {string[]} ghArgs
 * @returns {unknown}
 */
function ghApi(ghArgs) {
  const result = spawnSync('gh', ['api', ...ghArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (result.status !== 0) {
    throw new Error(`gh api ${ghArgs.join(' ')} failed:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * @param {string[]} ghArgs
 * @returns {void}
 */
function gh(ghArgs) {
  const result = spawnSync('gh', ghArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    throw new Error(`gh ${ghArgs.join(' ')} failed`);
  }
}

// ---------------------------------------------------------------------------
// バージョン比較（version tuple 方式）
// 文字列比較では v0.2.9 > v0.10.0 になるため数値タプルで比較
// ---------------------------------------------------------------------------

/**
 * @param {string} tag
 * @returns {{ tag: string; major: number; minor: number; patch: number } | null}
 */
function parseNormalVersion(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) return null;
  return {
    tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * @param {{ major: number; minor: number; patch: number }} a
 * @param {{ major: number; minor: number; patch: number }} b
 * @returns {number}
 */
function compareVersion(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * @param {{ major: number; minor: number; patch: number }} v
 * @param {'major' | 'minor' | 'patch'} level
 * @returns {string}
 */
function bumpVersion(v, level) {
  if (level === 'major') return `v${v.major + 1}.0.0`;
  if (level === 'minor') return `v${v.major}.${v.minor + 1}.0`;
  return `v${v.major}.${v.minor}.${v.patch + 1}`;
}

// ---------------------------------------------------------------------------
// タグ分類
// ---------------------------------------------------------------------------

/** @param {string} tag */
const isNormalTag = (tag) => /^v\d+\.\d+\.\d+$/.test(tag);
/** @param {string} tag */
const isHotfixTag = (tag) => /^v\d+\.\d+\.\d+_\d+$/.test(tag);

// ---------------------------------------------------------------------------
// ReleaseContext の構築
// ---------------------------------------------------------------------------

/**
 * trainBase: production 到達済みの最新通常タグ
 * @returns {string}
 */
function resolveTrainBase() {
  const raw = git('tag', ['--merged', 'origin/production', '--list', 'v*']);
  const tags = raw.split('\n').filter(Boolean);
  const parsed = tags.map(parseNormalVersion).filter((v) => v !== null);
  if (parsed.length === 0) {
    throw new Error('No normal version tag found in origin/production. Cannot determine trainBase.');
  }
  parsed.sort(compareVersion);
  return parsed[parsed.length - 1].tag;
}

/**
 * deployBase: production ブランチ HEAD のタグ、なければ SHA
 * Hotfix タグが複数ある場合は末尾数値が最大のものを選ぶ
 * @returns {string}
 */
function resolveDeployBase() {
  try {
    const tags = git('tag', ['--points-at', 'origin/production']).split('\n').filter(Boolean);
    // Hotfix タグを優先（複数ある場合は末尾数値が最大のものを選ぶ）
    const hotfixTags = tags.filter(isHotfixTag);
    if (hotfixTags.length > 0) {
      hotfixTags.sort((a, b) => {
        const na = parseInt(/(\d+)$/.exec(a)?.[1] ?? '0', 10);
        const nb = parseInt(/(\d+)$/.exec(b)?.[1] ?? '0', 10);
        return na - nb;
      });
      return hotfixTags[hotfixTags.length - 1];
    }
    const normal = tags.find(isNormalTag);
    if (normal) return normal;
    // RC は deployBase にしない
  } catch {
    // タグが取れなかった場合は SHA にフォールバック
  }
  return git('rev-parse', ['origin/production']);
}

/**
 * targetSha: origin/main HEAD（フル SHA）
 * @returns {string}
 */
function resolveTargetSha() {
  return git('rev-parse', ['origin/main']);
}

// ---------------------------------------------------------------------------
// PR 収集
// ---------------------------------------------------------------------------

const REPO = process.env['GITHUB_REPOSITORY'];

/**
 * trainBase..targetSha 間のコミットに紐づく PR を収集する
 * - Type: Release は除外
 * - dedup 済み
 * @param {string} trainBase
 * @param {string} targetSha
 * @returns {Array<{ number: number; title: string; url: string; labels: string[]; author: string; authorUrl: string }>}
 */
function collectPRs(trainBase, targetSha) {
  if (!REPO) throw new Error('GITHUB_REPOSITORY environment variable is not set.');

  const shas = git('log', [`${trainBase}..${targetSha}`, '--format=%H']).split('\n').filter(Boolean);

  /** @type {Map<number, { number: number; title: string; url: string; labels: string[]; author: string; authorUrl: string }>} */
  const prMap = new Map();

  for (const sha of shas) {
    /** @type {Array<{ number: number; title: string; html_url: string; labels: Array<{ name: string }>; user: { login: string; html_url: string } }>} */
    const prs = /** @type {any} */ (ghApi([`/repos/${REPO}/commits/${sha}/pulls`, '-H', 'Accept: application/vnd.github+json']));
    if (!Array.isArray(prs)) continue;

    for (const pr of prs) {
      if (prMap.has(pr.number)) continue;
      const labels = pr.labels.map((/** @type {{ name: string }} */ l) => l.name);
      if (labels.includes('Type: Release')) continue;
      prMap.set(pr.number, {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        labels,
        author: pr.user.login,
        authorUrl: pr.user.html_url,
      });
    }
  }

  return Array.from(prMap.values()).sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ number: number; title: string; labels: string[] }>} prs
 * @param {string} trainBase
 */
function validatePRs(prs, trainBase) {
  if (prs.length === 0) {
    console.error(`ERROR: No releasable pull requests found between ${trainBase} and origin/main.`);
    process.exit(1);
  }

  const unlabeled = prs.filter((pr) => !pr.labels.some((l) => l.startsWith('Type:')));
  if (unlabeled.length > 0) {
    console.error('ERROR: The following PRs have no Type:* label. Add a label before running release.');
    for (const pr of unlabeled) {
      console.error(`  #${pr.number} ${pr.title}`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// バージョン計算
// ---------------------------------------------------------------------------

/**
 * PR ラベルから bump レベルを決定する
 * @param {Array<{ labels: string[] }>} prs
 * @returns {'major' | 'minor' | 'patch'}
 */
function resolveBumpLevel(prs) {
  const allLabels = prs.flatMap((pr) => pr.labels);
  if (allLabels.includes('Type: Breaking')) return 'major';
  if (
    allLabels.some((l) =>
      ['Type: Feature', 'Type: Enhancement', 'Type: Security'].includes(l)
    )
  )
    return 'minor';
  return 'patch';
}

/**
 * 次の RC バージョンを決定する
 * @param {string} productionVersion  例: "v0.3.0"
 * @returns {string}  例: "v0.3.0-rc.1" or "v0.3.0-rc.3"
 */
function resolveNextRcVersion(productionVersion) {
  const raw = git('tag', ['--list', `${productionVersion}-rc.*`]).split('\n').filter(Boolean);
  if (raw.length === 0) return `${productionVersion}-rc.1`;

  const nums = raw
    .map((t) => {
      const m = /-rc\.(\d+)$/.exec(t);
      return m ? Number(m[1]) : 0;
    })
    .filter((n) => n > 0);

  const maxN = Math.max(...nums);
  return `${productionVersion}-rc.${maxN + 1}`;
}

// ---------------------------------------------------------------------------
// ブランチ存在チェック
// ---------------------------------------------------------------------------

/**
 * @param {string} branch
 * @returns {boolean}
 */
function branchExists(branch) {
  const result = spawnSync('git', ['ls-remote', '--heads', 'origin', branch], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

/**
 * @param {string} stagingVersion  例: "v0.3.0-rc.1"
 */
function checkNoBranchConflict(stagingVersion) {
  const base = `releases/stable/${stagingVersion}`;
  const draft = `releases/stable/${stagingVersion}-draft`;

  for (const branch of [base, draft]) {
    if (branchExists(branch)) {
      console.error(`ERROR: Branch already exists: ${branch}`);
      console.error('Re-run is not safe. Delete the branch and retry.');
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// CHANGELOG 生成
// ---------------------------------------------------------------------------

/** @type {{ changelog: { labels: Record<string, string> } }} */
const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
const LABEL_MAP = packageJson.changelog.labels;
const LABEL_ORDER = Object.keys(LABEL_MAP);

/**
 * @param {Array<{ number: number; title: string; url: string; labels: string[]; author: string; authorUrl: string }>} prs
 * @param {string} stagingVersion
 * @returns {string}
 */
function generateChangelog(prs, stagingVersion) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`## ${stagingVersion} (${today})`, ''];

  /** @type {Map<string, Array<{ number: number; title: string; url: string; author: string; authorUrl: string }>>} */
  const sections = new Map();

  for (const pr of prs) {
    // 定義済み Type:* ラベルを全て展開してセクションに登録する
    const matchedLabels = LABEL_ORDER.filter((l) => pr.labels.includes(l));
    if (matchedLabels.length === 0) {
      // 定義外 Type:* のみを持つ PR は Other Changes へ
      if (!sections.has('_other')) sections.set('_other', []);
      sections.get('_other')?.push(pr);
    } else {
      for (const label of matchedLabels) {
        if (!sections.has(label)) sections.set(label, []);
        sections.get(label)?.push(pr);
      }
    }
  }

  // 定義順で出力
  for (const label of LABEL_ORDER) {
    const entries = sections.get(label);
    if (!entries || entries.length === 0) continue;
    const heading = LABEL_MAP[label];
    lines.push(`#### ${heading}`);
    for (const pr of entries) {
      lines.push(`* [#${pr.number}](${pr.url}) ${pr.title} ([@${pr.author}](${pr.authorUrl}))`);
    }
    lines.push('');
  }

  // 定義外ラベルの PR
  const otherEntries = sections.get('_other');
  if (otherEntries && otherEntries.length > 0) {
    lines.push('#### Other Changes');
    for (const pr of otherEntries) {
      lines.push(`* [#${pr.number}](${pr.url}) ${pr.title} ([@${pr.author}](${pr.authorUrl}))`);
    }
    lines.push('');
  }

  // Committers
  const committers = [...new Set(prs.map((pr) => pr.author))].sort();
  lines.push(`#### Committers: ${committers.length}`);
  for (const committer of committers) {
    const authorUrl = prs.find((pr) => pr.author === committer)?.authorUrl ?? '';
    lines.push(`- [@${committer}](${authorUrl})`);
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// package.json version 更新
// ---------------------------------------------------------------------------

/**
 * @param {string} version  例: "0.3.0-rc.1"（"v" なし）
 */
function updatePackageJsonVersion(version) {
  const path = resolve(REPO_ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = version;
  // JSON.stringify は末尾改行を入れないため手動で追加
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// ブランチ作成・コミット・PR 起票
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   trainBase: string;
 *   deployBase: string;
 *   targetSha: string;
 *   productionVersion: string;
 *   stagingVersion: string;
 *   prs: Array<{ number: number; title: string; url: string; labels: string[]; author: string; authorUrl: string }>;
 *   changelog: string;
 * }} ctx
 */
function applyRelease(ctx) {
  const { trainBase, deployBase, targetSha, productionVersion, stagingVersion, prs, changelog } = ctx;
  const actor = process.env['GITHUB_ACTOR'] ?? '';
  const baseBranch = `releases/stable/${stagingVersion}`;
  const draftBranch = `releases/stable/${stagingVersion}-draft`;

  // ベースブランチ作成
  console.log(`Creating base branch: ${baseBranch}`);
  execFileSync('git', ['checkout', '-b', baseBranch, 'origin/main'], { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', baseBranch], { cwd: REPO_ROOT, stdio: 'inherit' });

  // ドラフトブランチ作成
  console.log(`Creating draft branch: ${draftBranch}`);
  execFileSync('git', ['checkout', '-b', draftBranch], { cwd: REPO_ROOT, stdio: 'inherit' });

  // CHANGELOG.md 更新（先頭にプリペンド）
  const changelogPath = resolve(REPO_ROOT, 'CHANGELOG.md');
  const existing = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
  writeFileSync(changelogPath, changelog + (existing ? '\n' + existing : ''));

  // package.json version 更新（"v" プレフィックスを除いた値）
  updatePackageJsonVersion(stagingVersion.replace(/^v/, ''));

  // コミット
  execFileSync('git', ['add', 'package.json', 'CHANGELOG.md'], { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync(
    'git',
    ['commit', '-m', `chore: release staging ${stagingVersion}`],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
  execFileSync('git', ['push', 'origin', draftBranch], { cwd: REPO_ROOT, stdio: 'inherit' });

  // PR 本文
  const prBody = buildPRBody({ trainBase, deployBase, targetSha, productionVersion, stagingVersion, prs, changelog });

  // PR 作成
  console.log('Creating staging release PR...');
  const ghArgs = [
    'pr', 'create',
    '--base', baseBranch,
    '--head', draftBranch,
    '--title', `chore: release staging ${stagingVersion}`,
    '--label', 'Type: Release',
    '--body', prBody,
  ];
  if (actor && actor.length > 0 && actor.length < 100) {
    ghArgs.push('--assignee', actor);
  }
  gh(ghArgs);
}

/**
 * PR 本文を生成する
 * @param {{
 *   trainBase: string;
 *   deployBase: string;
 *   targetSha: string;
 *   productionVersion: string;
 *   stagingVersion: string;
 *   prs: Array<{ number: number; title: string; url: string; labels: string[] }>;
 *   changelog: string;
 * }} ctx
 * @returns {string}
 */
function buildPRBody(ctx) {
  const { trainBase, deployBase, targetSha, productionVersion, stagingVersion, prs, changelog } = ctx;

  const meta = [
    '<!-- release-staging',
    `version=${stagingVersion}`,
    `production_version=${productionVersion}`,
    `train_base=${trainBase}`,
    `deploy_base=${deployBase}`,
    `target_sha=${targetSha}`,
    '-->',
  ].join('\n');

  const changeList = prs
    .map((pr) => {
      const typeLabels = pr.labels.filter((l) => l.startsWith('Type:')).join('` `');
      return `* [#${pr.number}](${pr.url}) ${pr.title} \`${typeLabels || 'unlabeled'}\``;
    })
    .join('\n');

  return [
    meta,
    '',
    '## Changes',
    '',
    changeList,
    '',
    '---',
    '',
    changelog,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

async function main() {
  console.log('Fetching latest refs and tags...');
  git('fetch', [
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
    '+refs/heads/production:refs/remotes/origin/production',
    '+refs/tags/*:refs/tags/*',
  ]);

  // コンテキスト解決
  const trainBase = resolveTrainBase();
  const deployBase = resolveDeployBase();
  const targetSha = resolveTargetSha(); // フル SHA

  // PR 収集
  console.log(`Collecting PRs: ${trainBase}..${targetSha.slice(0, 8)}...`);
  const prs = collectPRs(trainBase, targetSha);

  // バリデーション（0 件チェック → ラベルチェック）
  validatePRs(prs, trainBase);

  // バージョン計算
  const bumpLevel = resolveBumpLevel(prs);
  const trainParsed = parseNormalVersion(trainBase);
  if (!trainParsed) throw new Error(`Cannot parse trainBase as version: ${trainBase}`);
  const productionVersion = bumpVersion(trainParsed, bumpLevel);
  const stagingVersion = resolveNextRcVersion(productionVersion);

  // ブランチ衝突チェック（コンテキスト確定後に行う）
  checkNoBranchConflict(stagingVersion);

  // CHANGELOG 生成
  const changelog = generateChangelog(prs, stagingVersion);

  // dry-run 表示
  console.log('');
  console.log(`[context] train_base:         ${trainBase}`);
  console.log(`[context] deploy_base:        ${deployBase}`);
  console.log(`[context] target_sha:         ${targetSha.slice(0, 8)}...  (full SHA used in PR body)`);
  console.log(`[context] production_version: ${productionVersion}`);
  console.log(`[context] staging_version:    ${stagingVersion}`);
  console.log(`[context] bump_level:         ${bumpLevel}`);
  console.log('');
  console.log(`[context] Changes (${prs.length} PRs):`);
  for (const pr of prs) {
    const typeLabels = pr.labels.filter((l) => l.startsWith('Type:')).join(', ') || 'unlabeled';
    console.log(`  #${pr.number} [${typeLabels}]  ${pr.title}`);
  }
  console.log('');

  if (isDryRun) {
    console.log('[dry-run] CHANGELOG preview:');
    console.log(changelog);
    console.log('[dry-run] No branches/commits/PRs created.');
    return;
  }

  // --apply: 実際に起票
  applyRelease({ trainBase, deployBase, targetSha, productionVersion, stagingVersion, prs, changelog });
  console.log(`\nDone. Staging release PR for ${stagingVersion} created.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
