#!/usr/bin/env node
/**
 * Update the dynamic blocks in README.md with public GitHub data.
 *
 * Design contract (important):
 * - Zero third-party dependencies (uses Node's built-in fetch).
 * - Only rewrites the content between the START/END markers.
 * - Idempotent: identical content => no file write.
 * - Safe: on ANY failure it leaves the README unchanged and exits 0,
 *   so a scheduled run can never corrupt the profile page.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = join(__dirname, '..', 'README.md');

const USERNAME = (process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || 'sitxiaochen').trim();
const MAX_REPOS = 5;
const MAX_EVENTS = 5;

const REPOS_BLOCK = 'RECENT_REPOS';
const ACTIVITY_BLOCK = 'RECENT_ACTIVITY';

/** Fetch JSON from the GitHub API, returning null on any failure. */
async function fetchJson(url, token) {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'sitxiaochen-profile-readme-updater',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[warn] ${url} -> HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[warn] request failed for ${url}: ${err.message}`);
    return null;
  }
}

/** YYYY-MM-DD in UTC. */
function toDate(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toISOString().slice(0, 10);
}

/** Escape characters that would break a Markdown table cell. */
function safeCell(text) {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function truncate(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function renderRepos(repos) {
  if (!Array.isArray(repos) || repos.length === 0) {
    return '_暂无公开仓库 / No public repos yet._';
  }
  const rows = repos.slice(0, MAX_REPOS).map((r) => {
    const name = safeCell(r.name);
    const desc = safeCell(truncate(r.description, 70)) || '—';
    const lang = safeCell(r.language) || '—';
    const stars = r.stargazers_count ?? 0;
    const pushed = toDate(r.pushed_at);
    return `| [${name}](${r.html_url}) | ${desc} | ${lang} | ${stars} | ${pushed} |`;
  });
  return [
    '| 仓库 Repo | 简介 Description | 语言 Lang | ⭐ | 更新 Updated |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** Turn one public event into a single human-readable line. */
function describeEvent(ev) {
  const repo = ev?.repo?.name;
  const repoLink = repo ? `[${repo}](https://github.com/${repo})` : 'unknown repo';
  const type = ev?.type;

  switch (type) {
    case 'PushEvent': {
      const count = ev.payload?.commits?.length ?? 0;
      const msg = ev.payload?.commits?.[0]?.message?.split('\n')[0];
      const head = truncate(msg, 60);
      return `推送 ${count} 个提交到 ${repoLink}${head ? ` — “${head}”` : ''} / Pushed ${count} commit(s) to ${repoLink}${head ? ` — "${head}"` : ''}`;
    }
    case 'CreateEvent': {
      const refType = ev.payload?.ref_type ?? 'ref';
      const ref = ev.payload?.ref ? ` \`${ev.payload.ref}\`` : '';
      return `在 ${repoLink} 新建 ${refType}${ref} / Created ${refType}${ref} in ${repoLink}`;
    }
    case 'DeleteEvent': {
      const refType = ev.payload?.ref_type ?? 'ref';
      return `在 ${repoLink} 删除 ${refType} / Deleted ${refType} in ${repoLink}`;
    }
    case 'ForkEvent':
      return `复刻 ${repoLink} / Forked ${repoLink}`;
    case 'WatchEvent':
      return `为 ${repoLink} 点星 / Starred ${repoLink}`;
    case 'IssuesEvent':
      return `在 ${repoLink} 操作了 Issue（${ev.payload?.action ?? ''}）/ ${ev.payload?.action ?? 'updated'} an issue in ${repoLink}`;
    case 'PullRequestEvent':
      return `在 ${repoLink} 操作了 PR（${ev.payload?.action ?? ''}）/ ${ev.payload?.action ?? 'updated'} a pull request in ${repoLink}`;
    case 'IssueCommentEvent':
      return `在 ${repoLink} 评论了 Issue / Commented on an issue in ${repoLink}`;
    case 'ReleaseEvent':
      return `在 ${repoLink} 发布了 Release / Published a release in ${repoLink}`;
    case 'PublicEvent':
      return `将 ${repoLink} 设为公开 / Made ${repoLink} public`;
    default:
      return `在 ${repoLink} 有 ${type ?? '活动'} / ${type ?? 'activity'} in ${repoLink}`;
  }
}

function renderActivity(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return '_暂无公开动态 / No public activity yet._';
  }
  return events
    .slice(0, MAX_EVENTS)
    .map((ev) => `- ${describeEvent(ev)}`)
    .join('\n');
}

/** Replace content between `<!-- NAME:START -->` and `<!-- NAME:END -->`. */
function replaceBlock(readme, name, content) {
  const re = new RegExp(
    `(<!-- ${name}:START -->)([\\s\\S]*?)(<!-- ${name}:END -->)`,
    'i'
  );
  const m = readme.match(re);
  if (!m) {
    throw new Error(`marker pair for "${name}" not found in README.md`);
  }
  return readme.replace(re, `$1\n${content}\n$3`);
}

async function main() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const original = readFileSync(README_PATH, 'utf8');

  const base = `https://api.github.com/users/${encodeURIComponent(USERNAME)}`;
  const [repos, events] = await Promise.all([
    fetchJson(`${base}/repos?sort=pushed&direction=desc&per_page=${MAX_REPOS}`, token),
    fetchJson(`${base}/events/public?per_page=${MAX_EVENTS}`, token),
  ]);

  // If both endpoints failed, keep the README exactly as-is.
  if (!repos && !events) {
    console.warn('[warn] all GitHub API calls failed; README left unchanged.');
    return;
  }

  let updated = original;
  if (repos) updated = replaceBlock(updated, REPOS_BLOCK, renderRepos(repos));
  if (events) updated = replaceBlock(updated, ACTIVITY_BLOCK, renderActivity(events));

  if (updated === original) {
    console.log('[ok] no README changes needed.');
    return;
  }

  writeFileSync(README_PATH, updated, 'utf8');
  console.log('[ok] README dynamic blocks updated.');
}

try {
  await main();
} catch (err) {
  // Never fail the workflow / never corrupt the profile README.
  console.warn(`[warn] update skipped: ${err.message}`);
}
