// Publishes only generated _site contents to a separate gh-pages branch.
// Existing source branches and the working directory are never reset or cleaned.
import { execFileSync } from 'node:child_process';
import { mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
run(process.execPath, ['scripts/build-web.mjs']);
const remote = run('git', ['remote', 'get-url', 'origin']);
const previous = run('git', ['ls-remote', '--heads', remote, 'gh-pages']);
const temp = await mkdtemp(path.join(tmpdir(), 'shaoyong-pages-'));
run('git', ['init', '-b', 'gh-pages'], temp);
if (previous) run('git', ['fetch', '--depth=1', remote, 'gh-pages'], temp);
await cp(path.join(root, '_site'), temp, { recursive: true });
run('git', ['add', '.'], temp);
const author = run('git', ['log', '-1', '--format=%an']);
const email = run('git', ['log', '-1', '--format=%ae']);
const tree = run('git', ['write-tree'], temp);
const args = ['-c', `user.name=${author}`, '-c', `user.email=${email}`, 'commit-tree', tree,
  ...(previous ? ['-p', 'FETCH_HEAD'] : []), '-m', 'Deploy online experience'];
const commit = run('git', args, temp);
run('git', ['push', remote, `${commit}:refs/heads/gh-pages`], temp);
console.log('Published gh-pages. Source files unchanged. Temporary publish directory:', temp);
