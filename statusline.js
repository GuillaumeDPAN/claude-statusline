#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');

try {
  // Read stdin synchronously to avoid Windows pipe/stream issues
  const input = fs.readFileSync(0, 'utf8');

  let data;
  try {
    data = JSON.parse(input);
  } catch (_) {
    const safe = input.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
    data = JSON.parse(safe);
  }

  // Model
  const model = (data.model?.display_name || 'Claude').replace('Claude ', '');

  // Lines changed
  const added = data.cost?.total_lines_added || 0;
  const removed = data.cost?.total_lines_removed || 0;

  // Duration
  const ms = data.cost?.total_duration_ms || 0;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);

  // Cost
  const cost = data.cost?.total_cost_usd || 0;

  // Context
  const totalTokens = data.context_window?.context_window_size || 200000;
  let usedPct = data.context_window?.used_percentage;
  let remainPct = data.context_window?.remaining_percentage;

  if (usedPct == null) {
    const cu = data.context_window?.current_usage;
    if (cu) {
      const used = (cu.input_tokens || 0) + (cu.cache_creation_input_tokens || 0) + (cu.cache_read_input_tokens || 0);
      usedPct = Math.round((used * 100) / totalTokens);
      remainPct = 100 - usedPct;
    } else {
      usedPct = 0;
      remainPct = 100;
    }
  }

  const freeK = Math.round((totalTokens * remainPct) / 100000);

  // Bricks
  const totalBricks = 30;
  const usedBricks = Math.round((usedPct * totalBricks) / 100);
  const freeBricks = totalBricks - usedBricks;
  const bricks = '\x1b[0;36m■\x1b[0m'.repeat(usedBricks) + '\x1b[2;37m□\x1b[0m'.repeat(freeBricks);

  // Git info
  let repoName = '', branch = '', commitShort = '', commitMsg = '', gitStatus = '';
  const cwd = data.workspace?.current_dir || data.cwd || process.cwd();

  const gitOpts = { cwd, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] };
  try {
    repoName = execSync('git rev-parse --show-toplevel', gitOpts).trim().split(/[\\/]/).pop();
    branch = execSync('git branch --show-current', gitOpts).trim() || 'detached';
    commitShort = execSync('git rev-parse --short HEAD', gitOpts).trim();
    commitMsg = execSync('git log -1 --pretty=%s', gitOpts).trim().slice(0, 40);

    const porcelain = execSync('git status --porcelain', gitOpts).trim();
    if (porcelain) gitStatus = '*';

    try {
      const upstream = execSync('git rev-parse --abbrev-ref --symbolic-full-name @{u}', gitOpts).trim();
      if (upstream) {
        const ahead = parseInt(execSync(`git rev-list --count ${upstream}..HEAD`, gitOpts).trim()) || 0;
        const behind = parseInt(execSync(`git rev-list --count HEAD..${upstream}`, gitOpts).trim()) || 0;
        if (ahead > 0) gitStatus += `↑${ahead}`;
        if (behind > 0) gitStatus += `↓${behind}`;
      }
    } catch (_) {}
  } catch (_) {
    repoName = 'no-repo';
  }

  // Line 1: Model + Repo:Branch + Status + Changes
  let line1 = `\x1b[1;36m[${model}]\x1b[0m`;
  if (repoName && repoName !== 'no-repo') {
    line1 += ` \x1b[1;32m${repoName}\x1b[0m:\x1b[1;34m${branch}\x1b[0m`;
  }
  if (gitStatus) line1 += ` \x1b[1;31m${gitStatus}\x1b[0m`;
  if (added > 0 || removed > 0) line1 += ` | \x1b[0;32m+${added}\x1b[0m/\x1b[0;31m-${removed}\x1b[0m`;

  // Line 2: Commit
  let line2 = '';
  if (commitShort) {
    line2 = `\x1b[1;33m[${commitShort}]\x1b[0m ${commitMsg}`;
  }

  // Line 3: Bricks + stats
  let line3 = `[${bricks}] \x1b[1m${usedPct}%\x1b[0m | \x1b[1;32m${freeK}k free\x1b[0m | ${hours}h${mins}m`;
  if (cost > 0) line3 += ` | \x1b[0;33m$${cost.toFixed(2)}\x1b[0m`;

  // Line 4: Rate limits (Pro/Max only)
  let line4 = '';
  const rl = data.rate_limits;
  if (rl) {
    const colorFor = (pct) => pct >= 90 ? '\x1b[1;31m' : pct >= 70 ? '\x1b[1;33m' : '\x1b[1;32m';
    const RST = '\x1b[0m';
    const parts = [];

    if (rl.five_hour?.used_percentage != null) {
      const pct5 = Math.round(rl.five_hour.used_percentage);
      const resetAt = rl.five_hour.resets_at;
      let resetStr = '';
      if (resetAt) {
        const diffMs = resetAt * 1000 - Date.now();
        if (diffMs > 0) {
          const h = Math.floor(diffMs / 3600000);
          const m = Math.floor((diffMs % 3600000) / 60000);
          resetStr = ` ↻ ${h}h${String(m).padStart(2, '0')}`;
        }
      }
      parts.push(`${colorFor(pct5)}5h: ${pct5}%${resetStr}${RST}`);
    }

    if (rl.seven_day?.used_percentage != null) {
      const pct7 = Math.round(rl.seven_day.used_percentage);
      const resetAt = rl.seven_day.resets_at;
      let resetStr = '';
      if (resetAt) {
        const resetDate = new Date(resetAt * 1000);
        const days = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
        const dayName = days[resetDate.getDay()];
        const hh = String(resetDate.getHours()).padStart(2, '0');
        const mm = String(resetDate.getMinutes()).padStart(2, '0');
        resetStr = ` ↻ ${dayName} ${hh}:${mm}`;
      }
      parts.push(`${colorFor(pct7)}7d: ${pct7}%${resetStr}${RST}`);
    }

    if (parts.length) line4 = parts.join(' | ');
  }

  // Output
  let output = line2 ? `${line1}\n${line2}\n${line3}` : `${line1}\n${line3}`;
  if (line4) output += `\n${line4}`;
  output += '\n';
  fs.writeFileSync(1, output);

} catch (e) {
  fs.writeFileSync(1, `[err: ${e.message}]`.slice(0, 200) + '\n');
}
