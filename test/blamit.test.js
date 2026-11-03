const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { before, after, test } = require('node:test');
const git = require('../out/git');
const hosts = require('../out/hosts');

let repo;

function run(author, ...args) {
  execFileSync('git', ['-c', `user.name=${author}`, '-c', `user.email=${author.toLowerCase()}@x.io`, ...args], {
    cwd: repo,
    stdio: 'ignore',
  });
}

function append(file, text) {
  fs.appendFileSync(path.join(repo, file), text);
}

// Historique :
//   init (Alice) -> PR #42 mergée (Bob) -> squash "(#7)" (Carol) -> commit direct (Dan) -> PR #99 sans rapport (Eve)
before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'blamit-'));
  run('Alice', 'init', '-q', '-b', 'main');
  append('f.txt', 'a\nb\n');
  run('Alice', 'add', 'f.txt');
  run('Alice', 'commit', '-qm', 'init');
  run('Bob', 'checkout', '-qb', 'feat');
  append('f.txt', 'c\n');
  run('Bob', 'commit', '-qam', 'ajout c');
  run('Bob', 'checkout', '-q', 'main');
  run('Bob', 'merge', '-q', '--no-ff', 'feat', '-m', 'Merge pull request #42 from bob/feat');
  append('f.txt', 'd\n');
  run('Carol', 'commit', '-qam', 'Ajout d (#7)');
  append('f.txt', 'e\n');
  run('Dan', 'commit', '-qam', 'commit direct');
  run('Eve', 'checkout', '-qb', 'other');
  append('g.txt', 'z\n');
  run('Eve', 'add', 'g.txt');
  run('Eve', 'commit', '-qm', 'autre');
  run('Eve', 'checkout', '-q', 'main');
  run('Eve', 'merge', '-q', '--no-ff', 'other', '-m', 'Merge pull request #99 from eve/other');
});

after(() => fs.rmSync(repo, { recursive: true, force: true }));

async function blameFile() {
  const contents = fs.readFileSync(path.join(repo, 'f.txt'), 'utf8') + 'non commité\n';
  return git.blame(repo, 'f.txt', contents);
}

test('blame : auteurs, métadonnées et ligne non commitée', async () => {
  const lines = await blameFile();
  assert.deepStrictEqual(lines.slice(0, 5).map((l) => l.author), ['Alice', 'Alice', 'Bob', 'Carol', 'Dan']);
  assert.strictEqual(lines[0].authorMail, 'alice@x.io');
  assert.strictEqual(lines[3].summary, 'Ajout d (#7)');
  assert.ok(lines[0].authorTime > 1.6e12);
  assert.ok(lines.slice(0, 5).every((l) => l.committed));
  assert.strictEqual(lines[5].committed, false);
});

test('blame : annulation', async () => {
  const abort = new AbortController();
  const p = git.blame(repo, 'f.txt', 'x\n', abort.signal);
  abort.abort();
  await assert.rejects(p, { name: 'AbortError' });
});

test('recherche locale de la PR', async () => {
  const lines = await blameFile();
  const find = async (i) => {
    const sha = lines[i].sha;
    let n = hosts.parseMergeRequestNumber('github', await git.commitMessage(repo, sha));
    if (n === undefined) {
      const merge = await git.findMergeCommit(repo, sha);
      if (merge) {
        n = hosts.parseMergeRequestNumber('github', await git.commitMessage(repo, merge));
      }
    }
    return n;
  };
  assert.strictEqual(await find(2), 42, 'commit arrivé par merge');
  assert.strictEqual(await find(3), 7, 'squash');
  assert.strictEqual(await find(4), undefined, 'commit direct : pas le merge #99 suivant');
  assert.strictEqual(await find(0), undefined, 'commit initial');
});

test('parseRemote', () => {
  const R = (kind, baseUrl, host, p) => ({ kind, baseUrl, host, path: p });
  const P = hosts.parseRemote;
  assert.deepStrictEqual(P('git@gitlab.com:grp/sub/proj.git', {}), R('gitlab', 'https://gitlab.com', 'gitlab.com', 'grp/sub/proj'));
  assert.deepStrictEqual(P('https://github.com/o/r.git', {}), R('github', 'https://github.com', 'github.com', 'o/r'));
  assert.deepStrictEqual(P('ssh://git@git.boite.fr:2222/o/r.git', { 'git.boite.fr': 'gitea' }), R('gitea', 'https://git.boite.fr', 'git.boite.fr', 'o/r'));
  assert.deepStrictEqual(P('https://user:pw@gitea.local:3000/o/r', {}), R('gitea', 'https://gitea.local:3000', 'gitea.local:3000', 'o/r'));
  assert.deepStrictEqual(P('http://gitea.lan/o/r.git', {}), R('gitea', 'http://gitea.lan', 'gitea.lan', 'o/r'));
  assert.deepStrictEqual(
    P('git@github-work:o/r.git', { 'github-work': { type: 'github', url: 'https://github.com/' } }),
    R('github', 'https://github.com', 'github.com', 'o/r'),
  );
  assert.strictEqual(P('git@x.org:o/r.git', { 'x.org': { type: 'gitlab', url: 'https://x.org/gitlab' } }).baseUrl, 'https://x.org/gitlab');
  assert.strictEqual(P('git@unknown.org:o/r.git', {}), undefined);
  assert.strictEqual(P('git@x.org:o/r.git', { 'x.org': 'bitbucket' }), undefined);
});

test('URLs', () => {
  const gl = hosts.parseRemote('git@gitlab.com:grp/proj.git', {});
  assert.strictEqual(hosts.commitUrl(gl, 'abc'), 'https://gitlab.com/grp/proj/-/commit/abc');
  assert.strictEqual(hosts.mergeRequestUrl(gl, 3), 'https://gitlab.com/grp/proj/-/merge_requests/3');
  const gh = hosts.parseRemote('git@github.com:o/r.git', {});
  assert.strictEqual(hosts.commitUrl(gh, 'abc'), 'https://github.com/o/r/commit/abc');
  assert.strictEqual(hosts.mergeRequestUrl(gh, 4), 'https://github.com/o/r/pull/4');
  assert.strictEqual(hosts.mergeRequestUrl(hosts.parseRemote('http://gitea.lan/o/r', {}), 5), 'http://gitea.lan/o/r/pulls/5');
});

test('parseMergeRequestNumber', () => {
  const n = hosts.parseMergeRequestNumber;
  assert.strictEqual(n('gitlab', "Merge branch 'x' into 'main'\n\nTitre\n\nSee merge request grp/proj!12"), 12);
  assert.strictEqual(n('gitea', "Merge pull request 'Titre' (#5) from feat into main"), 5);
  assert.strictEqual(n('github', 'Merge pull request #8 from a/b'), 8);
  assert.strictEqual(n('github', 'Fix bug (#9)'), 9);
  assert.strictEqual(n('github', 'Fix bug'), undefined);
});
