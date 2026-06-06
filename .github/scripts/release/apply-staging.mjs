#!/usr/bin/env node
// @ts-check
/**
 * Stable Release 後処理スクリプト
 *
 * Usage:
 *   node .github/scripts/release/apply-staging.mjs --dry-run   # 確認用（変更なし）
 *   node .github/scripts/release/apply-staging.mjs --apply     # 実際に処理
 *
 * Stable Release PR（base: releases/stable/v*、head: releases/stable/v*-draft）が
 * マージされたあとに GitHub Actions から呼ばれる。
 *
 * 処理内容:
 *   1. PR 本文のメタデータを読む
 *   2. バリデーション（origin/main == target_sha など）
 *   3. main に squash merge
 *   4. RC タグ（annotated）を作成
 *   5. stable ブランチを RC タグへ fast-forward
 *   6. GitHub Prerelease を作成
 *   7. 古い Production Release PR をクローズ
 *   8. 新しい Production Release PR を起票
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
  console.error('Usage: node apply-staging.mjs --dry-run | --apply');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// パス
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REPO = process.env['GITHUB_REPOSITORY'];

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
// GitHub Event の読み込み
// ---------------------------------------------------------------------------

/**
 * @returns {{ pull_request: { number: number; base: { ref: string }; head: { ref: string; sha: string }; merged_commit_sha: string | null; body: string | null } }}
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
 * @returns {{ version: string; productionVersion: string; trainBase: string; deployBase: string; targetSha: string }}
 */
function parseReleaseStagingMeta(body) {
  if (!body) throw new Error('PR body is empty. Cannot parse release-staging metadata.');

  const match = /<!-- release-staging\n([\s\S]+?)\n-->/m.exec(body);
  if (!match) throw new Error('No <!-- release-staging --> block found in PR body.');

  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of match[1].split('\n')) {
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();
    if (key) meta[key] = val;
  }

  const required = ['version', 'production_version', 'train_base', 'deploy_base', 'target_sha'];
  for (const key of required) {
    if (!meta[key]) throw new Error(`Missing required metadata field: ${key}`);
  }

  return {
    version: /** @type {string} */ (meta['version']),
    productionVersion: /** @type {string} */ (meta['production_version']),
    trainBase: /** @type {string} */ (meta['train_base']),
    deployBase: /** @type {string} */ (meta['deploy_base']),
    targetSha: /** @type {string} */ (meta['target_sha']),
  };
}

// ---------------------------------------------------------------------------
// バリデーション
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
function validateMetadata(ctx) {
  const { version, productionVersion, targetSha, baseRef, headRef } = ctx;

  if (!/^v\d+\.\d+\.\d+-rc\.\d+$/.test(version)) {
    throw new Error(`Invalid version format: "${version}". Expected vX.Y.Z-rc.N`);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(productionVersion)) {
    throw new Error(`Invalid production_version format: "${productionVersion}". Expected vX.Y.Z`);
  }
  if (!/^[0-9a-f]{40}$/.test(targetSha)) {
    throw new Error(`Invalid target_sha: "${targetSha}". Expected 40-character hex SHA`);
  }
  if (baseRef !== `releases/stable/${version}`) {
    throw new Error(`base ref mismatch. expected: releases/stable/${version}, got: ${baseRef}`);
  }
  if (headRef !== `releases/stable/${version}-draft`) {
    throw new Error(`head ref mismatch. expected: releases/stable/${version}-draft, got: ${headRef}`);
  }
}

/**
 * origin/main が target_sha と一致するか確認
 * @param {string} targetSha
 */
function validateMainSha(targetSha) {
  const currentMainSha = git('rev-parse', ['origin/main']);
  if (currentMainSha !== targetSha) {
    console.error('ERROR: origin/main has advanced since this PR was created.');
    console.error(`  expected: ${targetSha}`);
    console.error(`  actual:   ${currentMainSha}`);
    console.error('Re-run is not safe. Close this PR and create a new Staging Release PR.');
    process.exit(1);
  }
}

/**
 * release ブランチが origin に存在するか確認
 * @param {string} version
 */
function validateReleaseBranch(version) {
  const result = spawnSync(
    'git',
    ['ls-remote', '--heads', 'origin', `releases/stable/${version}`],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  if (result.status !== 0 || result.stdout.trim().length === 0) {
    throw new Error(`Release branch not found on origin: releases/stable/${version}`);
  }
}

// ---------------------------------------------------------------------------
// ブランチ存在チェック / タグ・Release 事前チェック
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
 * @param {string} productionVersion
 */
function checkNoBranchConflict(productionVersion) {
  const base = `releases/production/${productionVersion}`;
  const draft = `releases/production/${productionVersion}-draft`;

  for (const branch of [base, draft]) {
    if (branchExists(branch)) {
      console.error(`ERROR: Branch already exists: ${branch}`);
      console.error('Re-run is not safe. Delete the branch and retry.');
      process.exit(1);
    }
  }
}

/**
 * RC タグが既に存在する場合はエラー（squash merge 前に呼ぶ）
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
 * GitHub Release が既に存在する場合はエラー（squash merge 前に呼ぶ）
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
}

/**
 * releases/production/v* または releases/stable/v* ブランチのみ削除を許可する安全ガード付き削除
 * @param {string} branch
 */
function deleteRemoteBranch(branch) {
  if (!/^releases\/(production|stable)\/v/.test(branch)) {
    throw new Error(`Refusing to delete non-release branch: ${branch}`);
  }
  execFileSync('git', ['push', 'origin', '--delete', branch], { cwd: REPO_ROOT, stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Staging 判定書コメントの抽出
// ---------------------------------------------------------------------------

/**
 * @param {number} pullRequestNumber
 * @returns {string | null}
 */
function fetchDecisionComment(pullRequestNumber) {
  if (!REPO) throw new Error('GITHUB_REPOSITORY environment variable is not set.');

  /** @type {Array<{ body: string | null }>} */
  const comments = /** @type {any} */ (
    ghApi([`/repos/${REPO}/issues/${pullRequestNumber}/comments`])
  );
  if (!Array.isArray(comments)) return null;

  const found = comments.find(
    (c) => c.body && c.body.startsWith('<!-- templates-release-decision --')
  );
  return found?.body ?? null;
}

/**
 * 判定書コメントから Production リリース予定日を抽出
 * @param {string} decisionBody
 * @returns {string}
 */
function extractProductionDate(decisionBody) {
  const match = /^\|\s*Production\s*\|\s*([^|]+?)\s*\|/mu.exec(decisionBody);
  return match ? match[1].trim() : '';
}

/**
 * 判定書コメントから詳細セクションを抽出
 * @param {string} decisionBody
 * @returns {string}
 */
function extractDetails(decisionBody) {
  const match = /(### 詳細[\s\S]+?)### 対象範囲/u.exec(decisionBody);
  return match ? match[1].trim() : '';
}

/**
 * 判定書コメントからリリーススケジュール表を抽出
 * @param {string} decisionBody
 * @returns {string}
 */
function extractSchedule(decisionBody) {
  const match = /(### リリース・スケジュール[\s\S]*?)(?:\n\n----|\n\n### |\n*$)/u.exec(decisionBody);
  if (!match) return '';

  // Production PR 向けに表の「本プルリクエスト」注記を Production 行へ移動する。
  // - QAS 行:        「本プルリクエストのマージをもってリリース」を削除
  // - Production 行: 末尾に「本プルリクエストのマージをもってリリース」を追加
  const NOTE = '本プルリクエストのマージをもってリリース';
  let schedule = match[1].trim();
  schedule = schedule.replace(
    /^(\|\s*QAS\s*\|[^|]+\|)\s*本プルリクエストのマージをもってリリース\s*(\|)/mu,
    '$1 $2'
  );
  schedule = schedule.replace(
    /^(\|\s*Production\s*\|[^|]+\|)\s*(\|)/mu,
    `$1 ${NOTE} $2`
  );
  return schedule;
}

// ---------------------------------------------------------------------------
// リリースノート生成（CHANGELOG.md 先頭セクション）
// ---------------------------------------------------------------------------

/**
 * @returns {string}
 */
function extractReleaseNotes() {
  const changelogPath = resolve(REPO_ROOT, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) return '';
  const content = readFileSync(changelogPath, 'utf8').trim();
  const match = /^## .+?(?=\n## |\n?$)/ms.exec(content);
  return match ? match[0].trim() : content;
}

// ---------------------------------------------------------------------------
// Production PR 本文の生成
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
function buildProductionPRBody(ctx) {
  const { version, stagingVersion, trainBase, deployBase, targetSha, stablePr, prdDate, details, schedule } = ctx;

  const templatePath = resolve(REPO_ROOT, '.github/templates/release-production.md');
  if (!existsSync(templatePath)) {
    throw new Error(`Template not found: .github/templates/release-production.md`);
  }

  let body = readFileSync(templatePath, 'utf8');
  body = body.replaceAll('${REPLACE_VERSION}', version);
  body = body.replaceAll('${REPLACE_STAGING_VERSION}', stagingVersion);
  body = body.replaceAll('${REPLACE_TRAIN_BASE}', trainBase);
  body = body.replaceAll('${REPLACE_DEPLOY_BASE}', deployBase);
  body = body.replaceAll('${REPLACE_TARGET_SHA}', targetSha);
  body = body.replaceAll('${REPLACE_STABLE_PR}', String(stablePr));
  body = body.replaceAll('${REPLACE_PRD_DATE}', prdDate);
  body = body.replaceAll('${REPLACE_DETAILS}', details);
  body = body.replaceAll('${REPLACE_SCHEDULE}', schedule);
  return body;
}

// ---------------------------------------------------------------------------
// apply 処理
// ---------------------------------------------------------------------------

/**
 * open な Production Release PR を列挙（releases/production/v* head のみ）
 * @returns {Array<{ number: number; headRefName: string; baseRefName: string }>}
 */
function listOpenProductionPRs() {
  const result = spawnSync(
    'gh',
    ['pr', 'list', '--state', 'open', '--label', 'Type: Release', '--json', 'number,headRefName,baseRefName'],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env } }
  );
  if (result.status !== 0) {
    throw new Error(`gh pr list failed:\n${result.stderr}`);
  }
  /** @type {Array<{ number: number; headRefName: string; baseRefName: string }>} */
  const all = JSON.parse(result.stdout || '[]');
  return all.filter((pr) => /^releases\/production\/v/.test(pr.headRefName));
}

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
function applyRelease(ctx) {
  const { version, productionVersion, trainBase, deployBase, targetSha, pullRequestNumber } = ctx;

  // ---- 事前チェック（side-effect なし）---------------------------------
  console.log('\nRunning pre-checks...');

  // RC タグ・GitHub Release が未存在であること
  assertTagNotExists(version);
  assertReleaseNotExists(version);

  // 古い Production PR を列挙（close/delete は Stable Release 完了後に回す）
  const oldProductionPRs = listOpenProductionPRs();
  console.log(
    `  Old Production PRs to close: ${oldProductionPRs.length > 0 ? oldProductionPRs.map((p) => `#${p.number}`).join(', ') : 'none'}`
  );

  // ---- 1. main に squash merge ----------------------------------------
  console.log(`\n[1/8] Squash merging releases/stable/${version} into main...`);
  execFileSync('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync('git', ['merge', '--squash', `origin/releases/stable/${version}`], { cwd: REPO_ROOT, stdio: 'inherit' });

  // 空コミット対策
  const diffResult = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: REPO_ROOT });
  if (diffResult.status === 0) {
    console.error('ERROR: Squash merge produced no changes. Nothing to commit.');
    process.exit(1);
  }

  execFileSync('git', ['commit', '-m', `chore: release staging ${version}`], { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: REPO_ROOT, stdio: 'inherit' });

  // ---- 2. RC タグ作成（annotated tag） ---------------------------------
  console.log(`\n[2/8] Creating annotated tag ${version}...`);
  const releaseSha = git('rev-parse', ['HEAD']);

  execFileSync('git', ['tag', '-a', version, '-m', `Staging release ${version}`, releaseSha], { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', version], { cwd: REPO_ROOT, stdio: 'inherit' });

  // 検証: annotated tag が releaseSha を指しているか
  const tagCommitSha = git('rev-parse', [`${version}^{commit}`]);
  if (tagCommitSha !== releaseSha) {
    throw new Error(`Tag verification failed. tag^{commit}=${tagCommitSha}, expected=${releaseSha}`);
  }
  console.log(`Tag ${version} -> ${releaseSha}`);

  // ---- 3. stable を RC タグへ fast-forward -----------------------------
  console.log(`\n[3/8] Fast-forwarding stable to ${version}...`);
  execFileSync('git', ['checkout', '-B', 'stable', 'origin/stable'], { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync('git', ['merge', '--ff-only', version], { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', 'stable'], { cwd: REPO_ROOT, stdio: 'inherit' });

  // ---- 4. GitHub Release（prerelease）を作成 ---------------------------
  console.log(`\n[4/8] Creating GitHub Release ${version}...`);
  const releaseNotes = extractReleaseNotes();

  const hasSection = /\n####\s+/.test(releaseNotes);
  const hasPullRequestEntry = /\n\*\s+\[#\d+\]/.test(releaseNotes);
  if (!hasSection || !hasPullRequestEntry) {
    throw new Error(
      `Release notes for ${version} do not contain changelog entries.\n` +
      `Got:\n${releaseNotes}`
    );
  }

  const releaseNotesPath = resolve(REPO_ROOT, 'RELEASE_NOTES.md');
  writeFileSync(releaseNotesPath, releaseNotes);

  gh([
    'release', 'create', version,
    '--title', version,
    '--notes-file', releaseNotesPath,
    '--target', releaseSha,
    '--prerelease',
  ]);

  // RELEASE_NOTES.md を asset としても添付
  gh(['release', 'upload', version, releaseNotesPath, '--clobber']);

  // ---- 5. 古い Production Release PR をクローズ＋ブランチ削除 ---------
  // Stable Release（main / tag / stable / GitHub Release）完了後に実施。
  // 失敗した場合でも既存の Production 判定 PR が残るため戻り道が確保される。
  console.log(`\n[5/8] Closing and deleting old Production Release PRs...`);
  for (const pr of oldProductionPRs) {
    console.log(`  Closing PR #${pr.number} (${pr.headRefName})...`);
    gh(['pr', 'close', String(pr.number),
      '--comment', `Superseded by staging release ${version}. A new Production Release PR has been created.`,
    ]);
    deleteRemoteBranch(pr.headRefName);
    if (/^releases\/production\/v/.test(pr.baseRefName)) {
      deleteRemoteBranch(pr.baseRefName);
    }
  }

  // ---- 6. Production ブランチ存在チェック（旧削除後） ------------------
  console.log(`\n[6/8] Checking Production branches don't exist...`);
  checkNoBranchConflict(productionVersion);

  // ---- 7. Production Release PR を起票 ---------------------------------
  console.log(`\n[7/8] Creating Production Release PR for ${productionVersion}...`);

  const baseBranch = `releases/production/${productionVersion}`;
  const draftBranch = `releases/production/${productionVersion}-draft`;

  // base ブランチ（RC タグを起点）
  execFileSync('git', ['checkout', '-b', baseBranch, version], { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', baseBranch], { cwd: REPO_ROOT, stdio: 'inherit' });

  // draft ブランチ（空コミット）
  execFileSync('git', ['checkout', '-b', draftBranch], { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync('git', ['commit', '--allow-empty', '-m', `chore: release production ${productionVersion}`], { cwd: REPO_ROOT, stdio: 'inherit' });
  execFileSync('git', ['push', 'origin', draftBranch], { cwd: REPO_ROOT, stdio: 'inherit' });

  // PR 本文を生成（Staging 判定書コメントから抽出）
  const decisionBody = fetchDecisionComment(pullRequestNumber);
  const prdDate = decisionBody ? extractProductionDate(decisionBody) : '';
  const details = decisionBody ? extractDetails(decisionBody) : '';
  const schedule = decisionBody ? extractSchedule(decisionBody) : '';

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
  });

  const prBodyPath = resolve(REPO_ROOT, 'PRODUCTION_PR_BODY.md');
  writeFileSync(prBodyPath, prBody);

  gh([
    'pr', 'create',
    '--base', baseBranch,
    '--head', draftBranch,
    '--title', `chore: release production ${productionVersion}`,
    '--label', 'Type: Release',
    '--body-file', prBodyPath,
  ]);

  console.log(`\nDone. Production Release PR for ${productionVersion} created.`);

  // ---- 8. Stable リリースブランチを削除 --------------------------------
  console.log(`\n[8/8] Deleting stable release branches...`);

  // base ブランチ（releases/stable/${version}）は自動削除されないため明示的に削除
  deleteRemoteBranch(`releases/stable/${version}`);

  // draft ブランチ（releases/stable/${version}-draft）は GitHub のマージ時自動削除で
  // 既に消えている場合がある。存在するときのみ削除する。
  const draftStagingBranch = `releases/stable/${version}-draft`;
  if (branchExists(draftStagingBranch)) {
    deleteRemoteBranch(draftStagingBranch);
  } else {
    console.log(`  ${draftStagingBranch} already deleted (auto-deleted by GitHub on merge).`);
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
  const meta = parseReleaseStagingMeta(pr.body);
  const { version, productionVersion, trainBase, deployBase, targetSha } = meta;

  // メタデータのバリデーション
  validateMetadata({ version, productionVersion, targetSha, baseRef, headRef });

  // refs / タグを取得
  console.log('Fetching latest refs and tags...');
  git('fetch', [
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
    '+refs/heads/stable:refs/remotes/origin/stable',
    '+refs/heads/production:refs/remotes/origin/production',
    '+refs/heads/releases/stable/*:refs/remotes/origin/releases/stable/*',
    '+refs/tags/*:refs/tags/*',
  ]);

  // release ブランチの存在確認
  validateReleaseBranch(version);

  // release ブランチの SHA を取得
  const releaseBranchSha = git('rev-parse', [`origin/releases/stable/${version}`]);

  // origin/main == target_sha の確認
  validateMainSha(targetSha);

  // dry-run 表示
  console.log('');
  console.log(`[context] stable_pr:          #${pullRequestNumber}`);
  console.log(`[context] version:            ${version}`);
  console.log(`[context] production_version: ${productionVersion}`);
  console.log(`[context] train_base:         ${trainBase}`);
  console.log(`[context] deploy_base:        ${deployBase}`);
  console.log(`[context] target_sha:         ${targetSha.slice(0, 8)}...  (origin/main HEAD)`);
  console.log(`[context] release_branch:     releases/stable/${version}`);
  console.log(`[context] release_branch_sha: ${releaseBranchSha.slice(0, 8)}...`);
  console.log(`[context] main_check:         ok  (origin/main == target_sha)`);
  console.log(`[context] tag_to_create:      ${version}`);
  console.log(`[context] stable_update:      stable -> ${version} tag commit (determined after merge)`);
  console.log(`[context] production_pr:      chore: release production ${productionVersion}`);
  console.log('');

  if (isDryRun) {
    console.log('[dry-run] No git/gh operations performed.');
    return;
  }

  // --apply: 実際に処理
  applyRelease({ version, productionVersion, trainBase, deployBase, targetSha, pullRequestNumber });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
