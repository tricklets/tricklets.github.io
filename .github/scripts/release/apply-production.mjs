#!/usr/bin/env node
// @ts-check
/**
 * Production Release 後処理スクリプト
 *
 * Usage:
 *   node .github/scripts/release/apply-production.mjs --dry-run   # 確認用（変更なし）
 *   node .github/scripts/release/apply-production.mjs --apply     # 実際に処理
 *
 * Production Release PR（base: releases/production/v*、head: releases/production/v*-draft）が
 * マージされたあとに GitHub Actions から呼ばれる。
 *
 * 処理内容:
 *   1. PR 本文のメタデータを読む
 *   2. バリデーション（format、base/head ref 一致）
 *   3. 事前チェック（side-effect なし）
 *   4. production ブランチを targetSha 起点で作成し、リリースコミットを追加
 *   5. production タグ（annotated）をリリースコミットに作成
 *   6. GitHub Release（stable）を作成
 *   7. Production リリースブランチを削除（失敗は warning 扱い）
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// CLI フラグ
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isApply = args.includes('--apply');

if (!isDryRun && !isApply) {
  console.error('Usage: node apply-production.mjs --dry-run | --apply');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// パス
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/**
 * @param {string} cmd
 * @param {string[]} cmdArgs
 * @param {{ cwd?: string }} [opts]
 * @returns {string}
 */
function git(cmd, cmdArgs, opts = {}) {
  const result = spawnSync('git', [cmd, ...cmdArgs], {
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
// GitHub Event の読み込み
// ---------------------------------------------------------------------------

/**
 * @returns {{ pull_request: { number: number; base: { ref: string }; head: { ref: string; sha: string }; body: string | null } }}
 */
function readGitHubEvent() {
  const eventPath = process.env['GITHUB_EVENT_PATH'];
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set.');
  return /** @type {any} */ (JSON.parse(readFileSync(eventPath, 'utf8')));
}

// ---------------------------------------------------------------------------
// PR 本文からメタデータをパース
// ---------------------------------------------------------------------------

/**
 * @param {string | null} body
 * @returns {{ version: string; stagingVersion: string; trainBase: string; deployBase: string; targetSha: string; stablePr: number }}
 */
function parseReleaseProductionMeta(body) {
  if (!body) throw new Error('PR body is empty. Cannot parse release-production metadata.');

  const match = /<!-- release-production\n([\s\S]+?)\n-->/m.exec(body);
  if (!match) throw new Error('No <!-- release-production --> block found in PR body.');

  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of match[1].split('\n')) {
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();
    if (key) meta[key] = val;
  }

  const required = ['version', 'staging_version', 'train_base', 'deploy_base', 'target_sha', 'stable_pr'];
  for (const key of required) {
    if (!meta[key]) throw new Error(`Missing required metadata field: ${key}`);
  }

  const stablePrNum = Number(meta['stable_pr']);
  if (!Number.isInteger(stablePrNum) || stablePrNum <= 0) {
    throw new Error(`Invalid stable_pr: "${meta['stable_pr']}". Expected positive integer.`);
  }

  return {
    version: /** @type {string} */ (meta['version']),
    stagingVersion: /** @type {string} */ (meta['staging_version']),
    trainBase: /** @type {string} */ (meta['train_base']),
    deployBase: /** @type {string} */ (meta['deploy_base']),
    targetSha: /** @type {string} */ (meta['target_sha']),
    stablePr: stablePrNum,
  };
}

// ---------------------------------------------------------------------------
// バリデーション（メタデータ形式チェック）
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
function validateMetadata(ctx) {
  const { version, stagingVersion, targetSha, baseRef, headRef } = ctx;

  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid version format: "${version}". Expected vX.Y.Z`);
  }
  if (!/^v\d+\.\d+\.\d+-rc\.\d+$/.test(stagingVersion)) {
    throw new Error(`Invalid staging_version format: "${stagingVersion}". Expected vX.Y.Z-rc.N`);
  }
  if (!/^[0-9a-f]{40}$/.test(targetSha)) {
    throw new Error(`Invalid target_sha: "${targetSha}". Expected 40-character hex SHA`);
  }
  if (baseRef !== `releases/production/${version}`) {
    throw new Error(`base ref mismatch. expected: releases/production/${version}, got: ${baseRef}`);
  }
  if (headRef !== `releases/production/${version}-draft`) {
    throw new Error(`head ref mismatch. expected: releases/production/${version}-draft, got: ${headRef}`);
  }
}

// ---------------------------------------------------------------------------
// 事前チェック（side-effect なし）
// ---------------------------------------------------------------------------

/**
 * @param {string} version
 */
function assertTagNotExists(version) {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${version}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    throw new Error(`ERROR: Tag already exists: ${version}`);
  }
}

/**
 * @param {string} version
 */
function assertReleaseNotExists(version) {
  const result = spawnSync('gh', ['release', 'view', version], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (result.status === 0) {
    throw new Error(`ERROR: GitHub Release already exists: ${version}`);
  }
  // exit code != 0 でも、"release not found" 以外のエラー（認証失敗など）は検査エラーとして扱う
  const stderr = (result.stderr ?? '').toLowerCase();
  if (!stderr.includes('release not found') && !stderr.includes('not found')) {
    throw new Error(
      `Failed to check GitHub Release existence for ${version} (unexpected error):\n${result.stderr}`
    );
  }
}

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
 * RC タグが存在し、指定 SHA を指しているか確認
 * @param {string} stagingVersion
 * @param {string} targetSha
 */
function assertRcTagPointsToTargetSha(stagingVersion, targetSha) {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${stagingVersion}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`RC tag not found: ${stagingVersion}`);
  }
  const rcTagCommitSha = git('rev-parse', [`${stagingVersion}^{commit}`]);
  if (rcTagCommitSha !== targetSha) {
    throw new Error(
      `RC tag ${stagingVersion} does not point to targetSha.\n` +
      `  tag^{commit}: ${rcTagCommitSha}\n` +
      `  targetSha:    ${targetSha}`
    );
  }
}

/**
 * targetSha のコミットが存在するか確認
 * @param {string} targetSha
 */
function assertTargetShaExists(targetSha) {
  const result = spawnSync('git', ['cat-file', '-e', `${targetSha}^{commit}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`targetSha commit not found: ${targetSha}`);
  }
}

/**
 * base ブランチ（releases/production/${version}）が origin に存在するか確認
 * @param {string} version
 */
function assertBaseBranchExists(version) {
  if (!branchExists(`releases/production/${version}`)) {
    throw new Error(`Base branch not found on origin: releases/production/${version}`);
  }
}

/**
 * origin/production が targetSha の祖先であるか確認
 * @param {string} targetSha
 */
function assertProductionIsAncestorOfTarget(targetSha) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', 'origin/production', targetSha], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `origin/production is not an ancestor of ${targetSha}.\n` +
      'The production branch has advanced beyond the target commit.'
    );
  }
}

/**
 * RC GitHub Release が存在し、ノートがチェックリストを含むか確認
 * @param {string} stagingVersion
 * @returns {string} RC Release の notes 本文
 */
function fetchAndValidateRcReleaseNotes(stagingVersion) {
  const result = spawnSync(
    'gh',
    ['release', 'view', stagingVersion, '--json', 'body', '--jq', '.body'],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } }
  );
  if (result.status !== 0) {
    throw new Error(`RC GitHub Release not found: ${stagingVersion}\n${result.stderr}`);
  }

  const releaseNotes = result.stdout.trim();
  if (!releaseNotes || releaseNotes === 'null') {
    throw new Error(`RC GitHub Release body is empty: ${stagingVersion}`);
  }

  const hasSection = /\n####\s+/.test(releaseNotes);
  const hasPullRequestEntry = /\n\*\s+\[#\d+\]/.test(releaseNotes);
  if (!hasSection || !hasPullRequestEntry) {
    throw new Error(
      `Release notes for ${stagingVersion} do not contain changelog entries.\n` +
      `Got:\n${releaseNotes}`
    );
  }

  return releaseNotes;
}

// ---------------------------------------------------------------------------
// ブランチ削除（warning 扱い）
// ---------------------------------------------------------------------------

/**
 * releases/production/v* ブランチのみ削除を許可する。失敗は warning に留める。
 * @param {string} branch
 */
function tryDeleteRemoteBranch(branch) {
  if (!/^releases\/production\/v/.test(branch)) {
    throw new Error(`Refusing to delete non-production release branch: ${branch}`);
  }
  const result = spawnSync('git', ['push', 'origin', '--delete', branch], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.warn(`WARNING: Failed to delete branch ${branch}.`);
    console.warn(result.stderr);
  } else {
    console.log(`  Deleted branch: ${branch}`);
  }
}

// ---------------------------------------------------------------------------
// apply 処理
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   version: string;
 *   targetSha: string;
 *   headRef: string;
 *   releaseNotes: string;
 * }} ctx
 */
function applyRelease(ctx) {
  const { version, targetSha, headRef, releaseNotes } = ctx;

  // ---- 1. production を targetSha 起点で checkout し、リリースコミットを作成 -----
  console.log(`\n[1/4] Creating production release commit on top of ${targetSha.slice(0, 8)}...`);
  execFileSync('git', ['checkout', '-B', 'production', targetSha], { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync('git', ['commit', '--allow-empty', '-m', `chore: release production ${version}`], { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', 'production'], { cwd: REPO_ROOT, stdio: 'inherit' });
  const productionReleaseSha = git('rev-parse', ['HEAD']);

  // ---- 2. production タグ作成（annotated tag） --------------------------
  console.log(`\n[2/4] Creating annotated tag ${version} at ${productionReleaseSha.slice(0, 8)}...`);
  execFileSync(
    'git',
    ['tag', '-a', version, '-m', `Production release ${version}`, productionReleaseSha],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
  execFileSync('git', ['push', 'origin', version], { cwd: REPO_ROOT, stdio: 'inherit' });

  // 検証: annotated tag が productionReleaseSha を指しているか
  const tagCommitSha = git('rev-parse', [`${version}^{commit}`]);
  if (tagCommitSha !== productionReleaseSha) {
    throw new Error(`Tag verification failed. tag^{commit}=${tagCommitSha}, expected=${productionReleaseSha}`);
  }
  console.log(`Tag ${version} -> ${productionReleaseSha}`);

  // ---- 3. GitHub Release（stable）を作成 --------------------------------
  console.log(`\n[3/4] Creating GitHub Release ${version}...`);
  const releaseNotesPath = resolve(REPO_ROOT, 'PRODUCTION_RELEASE_NOTES.md');
  writeFileSync(releaseNotesPath, releaseNotes);

  gh([
    'release', 'create', version,
    '--title', version,
    '--notes-file', releaseNotesPath,
    '--target', productionReleaseSha,
  ]);

  // ---- 4. Production リリースブランチを削除（失敗は warning 扱い） -------
  console.log(`\n[4/4] Deleting production release branches...`);

  // base ブランチは必ず削除試行
  tryDeleteRemoteBranch(`releases/production/${version}`);

  // head ブランチはマージ後に GitHub 側で自動削除済みの場合があるため、存在するときのみ削除試行
  if (branchExists(headRef)) {
    tryDeleteRemoteBranch(headRef);
  } else {
    console.log(`  ${headRef} already deleted (auto-deleted by GitHub on merge).`);
  }

  console.log('\nAll done.');
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

async function main() {
  // イベント読み込み
  const event = readGitHubEvent();
  const pr = event.pull_request;

  const pullRequestNumber = pr.number;
  const baseRef = pr.base.ref;
  const headRef = pr.head.ref;

  // PR 本文からメタデータをパース
  const meta = parseReleaseProductionMeta(pr.body);
  const { version, stagingVersion, trainBase, deployBase, targetSha, stablePr } = meta;

  // メタデータのバリデーション
  validateMetadata({ version, stagingVersion, targetSha, baseRef, headRef });

  // refs / タグを取得
  console.log('Fetching latest refs and tags...');
  git('fetch', [
    'origin',
    '+refs/heads/production:refs/remotes/origin/production',
    `+refs/heads/releases/production/${version}:refs/remotes/origin/releases/production/${version}`,
    '+refs/tags/*:refs/tags/*',
  ]);

  // ---- 事前チェック（side-effect なし）----------------------------------
  console.log('\nRunning pre-checks...');

  assertTagNotExists(version);
  console.log(`  production tag:     not exists (ok)`);

  assertReleaseNotExists(version);
  console.log(`  production release: not exists (ok)`);

  assertRcTagPointsToTargetSha(stagingVersion, targetSha);
  console.log(`  rc_tag_check:       ok  (${stagingVersion} -> ${targetSha.slice(0, 8)}...)`);

  assertTargetShaExists(targetSha);
  console.log(`  target_sha:         ok  (commit exists)`);

  assertBaseBranchExists(version);
  console.log(`  base_branch:        ok  (releases/production/${version} exists)`);

  assertProductionIsAncestorOfTarget(targetSha);
  console.log(`  production_ancestor: ok  (origin/production is ancestor of ${targetSha.slice(0, 8)}...)`);

  const releaseNotes = fetchAndValidateRcReleaseNotes(stagingVersion);
  console.log(`  rc_release:         ok  (notes validated)`);

  // head ブランチの存在を確認（任意チェック）
  const headExists = branchExists(headRef);
  console.log(`  head_branch:        ${headExists ? 'exists (will delete)' : 'not found (may have been auto-deleted, ok)'}`);

  // dry-run 表示
  console.log('');
  console.log(`[context] pull_request_number: #${pullRequestNumber}`);
  console.log(`[context] stable_pr:           #${stablePr}`);
  console.log(`[context] version:             ${version}`);
  console.log(`[context] staging_version:     ${stagingVersion}`);
  console.log(`[context] train_base:          ${trainBase}`);
  console.log(`[context] deploy_base:         ${deployBase}`);
  console.log(`[context] target_sha:          ${targetSha.slice(0, 8)}...`);
  console.log(`[context] rc_tag_check:        ok  (${stagingVersion} -> ${targetSha.slice(0, 8)}...)`);
  console.log(`[context] production_ancestor: ok  (origin/production is ancestor of ${targetSha.slice(0, 8)}...)`);
  console.log(`[context] production_tag:      not exists (ok)`);
  console.log(`[context] production_release:  not exists (ok)`);
  console.log(`[context] rc_release:          exists (ok)`);
  console.log(`[context] release_notes_guard: ok  (has sections and PR entries)`);
  console.log(`[context] production_branch:   production -> ${targetSha.slice(0, 8)}... + chore: release production ${version}`);
  console.log(`[context] tag_to_create:       ${version}  (at new production release commit)`);
  console.log('');

  if (isDryRun) {
    console.log('[dry-run] No git/gh operations performed.');
    return;
  }

  // --apply: 実際に処理
  applyRelease({ version, targetSha, headRef, releaseNotes });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
