#!/usr/bin/env node
/**
 * Repository self-check used by CI.
 *
 * Verifies:
 * 1. Every workflow file under .github/workflows is valid YAML
 *    and has the required top-level keys.
 * 2. Scheduled workflows declare a 5-field cron expression.
 * 3. README.md exists, is non-empty, has a top-level title,
 *    and contains both dynamic marker pairs exactly once.
 *
 * Exits non-zero on the first failure so CI fails fast.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');
const README_PATH = join(ROOT, 'README.md');

const REQUIRED_BLOCKS = ['RECENT_REPOS', 'RECENT_ACTIVITY'];
const CRON_FIELDS = 5;

const failures = [];
const notes = [];

function fail(msg) {
  failures.push(msg);
}

function checkWorkflows() {
  if (!existsSync(WORKFLOWS_DIR)) {
    fail('.github/workflows directory is missing.');
    return;
  }

  const files = readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.(yml|yaml)$/i.test(f))
    .sort();

  if (files.length === 0) {
    fail('No workflow files found in .github/workflows.');
    return;
  }

  for (const file of files) {
    const full = join(WORKFLOWS_DIR, file);
    let doc;
    try {
      doc = parse(readFileSync(full, 'utf8'));
    } catch (err) {
      fail(`${file}: invalid YAML -> ${err.message}`);
      continue;
    }

    if (!doc || typeof doc !== 'object') {
      fail(`${file}: workflow document is empty or not a mapping.`);
      continue;
    }

    for (const key of ['name', 'jobs']) {
      if (!(key in doc)) fail(`${file}: missing top-level "${key}".`);
    }

    if (doc.jobs && typeof doc.jobs === 'object') {
      const jobNames = Object.keys(doc.jobs);
      if (jobNames.length === 0) {
        fail(`${file}: no jobs defined.`);
      }
      for (const jobName of jobNames) {
        const job = doc.jobs[jobName] ?? {};
        if (!job['runs-on']) fail(`${file}: job "${jobName}" missing "runs-on".`);
        if (!Array.isArray(job.steps) || job.steps.length === 0) {
          fail(`${file}: job "${jobName}" has no steps.`);
        }
      }
    }

    // Validate cron expressions on any scheduled workflow.
    const on = doc.on ?? doc[true]; // `on:` may parse as boolean true in YAML 1.1
    if (on && typeof on === 'object' && on.schedule && Array.isArray(on.schedule)) {
      for (const entry of on.schedule) {
        const cron = entry?.cron;
        if (typeof cron !== 'string') {
          fail(`${file}: schedule entry missing "cron".`);
          continue;
        }
        const fields = cron.trim().split(/\s+/);
        if (fields.length !== CRON_FIELDS) {
          fail(`${file}: cron "${cron}" must have ${CRON_FIELDS} fields, got ${fields.length}.`);
        }
      }
    }

    notes.push(`workflow OK: ${file}`);
  }
}

function checkReadme() {
  if (!existsSync(README_PATH)) {
    fail('README.md is missing.');
    return;
  }

  const readme = readFileSync(README_PATH, 'utf8');
  if (readme.trim().length === 0) {
    fail('README.md is empty.');
    return;
  }

  if (!/^#\s+\S+/m.test(readme)) {
    fail('README.md has no top-level markdown title (line starting with "# ").');
  }

  for (const block of REQUIRED_BLOCKS) {
    const startRe = new RegExp(`<!-- ${block}:START -->`, 'g');
    const endRe = new RegExp(`<!-- ${block}:END -->`, 'g');
    const starts = readme.match(startRe)?.length ?? 0;
    const ends = readme.match(endRe)?.length ?? 0;

    if (starts !== 1 || ends !== 1) {
      fail(
        `README.md must contain exactly one "<!-- ${block}:START -->" and one ` +
          `"<!-- ${block}:END -->" (found ${starts} start / ${ends} end).`
      );
      continue;
    }

    const startIdx = readme.indexOf(`<!-- ${block}:START -->`);
    const endIdx = readme.indexOf(`<!-- ${block}:END -->`);
    if (endIdx < startIdx) {
      fail(`README.md block "${block}": END marker appears before START marker.`);
      continue;
    }

    notes.push(`README block OK: ${block}`);
  }
}

checkWorkflows();
checkReadme();

for (const note of notes) console.log(`[ok] ${note}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('\nAll checks passed.');
