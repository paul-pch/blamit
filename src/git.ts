import { execFile } from 'child_process';

export interface BlameLine {
  sha: string;
  author: string;
  authorMail: string;
  /** Epoch en millisecondes. */
  authorTime: number;
  summary: string;
  committed: boolean;
}

export function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/** Blame du fichier, avec le contenu du buffer (éventuellement non sauvegardé). Index = numéro de ligne (0-based). */
export async function blame(cwd: string, file: string, contents: string): Promise<BlameLine[]> {
  const out = await git(cwd, ['blame', '--porcelain', '--contents', '-', '--', file], contents);
  const commits = new Map<string, BlameLine>();
  const lines: BlameLine[] = [];
  let current: BlameLine | undefined;
  let finalLine = 0;

  for (const raw of out.split('\n')) {
    if (raw.startsWith('\t')) {
      // Ligne de contenu : clôt l'entrée en cours.
      if (current) {
        lines[finalLine - 1] = current;
      }
      continue;
    }
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(raw);
    if (header) {
      const sha = header[1];
      finalLine = Number(header[2]);
      current = commits.get(sha);
      if (!current) {
        current = { sha, author: '', authorMail: '', authorTime: 0, summary: '', committed: !/^0+$/.test(sha) };
        commits.set(sha, current);
      }
      continue;
    }
    if (!current) {
      continue;
    }
    const space = raw.indexOf(' ');
    const key = space === -1 ? raw : raw.slice(0, space);
    const value = space === -1 ? '' : raw.slice(space + 1);
    switch (key) {
      case 'author':
        current.author = value;
        break;
      case 'author-mail':
        current.authorMail = value.replace(/^<|>$/g, '');
        break;
      case 'author-time':
        current.authorTime = Number(value) * 1000;
        break;
      case 'summary':
        current.summary = value;
        break;
    }
  }
  return lines;
}

export async function commitMessage(cwd: string, sha: string): Promise<string> {
  return (await git(cwd, ['show', '-s', '--format=%B', sha])).trim();
}

export async function remoteUrl(cwd: string, preferred: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ['remote', 'get-url', preferred])).trim();
  } catch {
    const first = (await git(cwd, ['remote'])).split('\n')[0]?.trim();
    return first ? (await git(cwd, ['remote', 'get-url', first])).trim() : undefined;
  }
}

/**
 * Commit de merge qui a intégré `sha` dans la branche courante :
 * le plus ancien merge à la fois sur le chemin d'ascendance et sur la lignée first-parent de HEAD.
 */
export async function findMergeCommit(cwd: string, sha: string): Promise<string | undefined> {
  const list = async (...args: string[]) =>
    (await git(cwd, ['rev-list', ...args, '--merges', `${sha}..HEAD`])).split('\n').filter(Boolean);
  const [ancestry, firstParent] = await Promise.all([list('--ancestry-path'), list('--first-parent')]);
  const mainline = new Set(firstParent);
  // rev-list liste du plus récent au plus ancien.
  const merge = [...ancestry].reverse().find((c) => mainline.has(c));
  if (!merge) {
    return undefined;
  }
  // Si le commit était déjà sur la lignée principale avant ce merge, ce merge ne l'a pas apporté.
  try {
    await git(cwd, ['merge-base', '--is-ancestor', sha, `${merge}^1`]);
    return undefined;
  } catch {
    return merge;
  }
}
