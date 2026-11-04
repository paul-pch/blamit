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

/**
 * Chemin de l'exécutable git. On reprend celui résolu par l'extension Git de VS Code :
 * sous Windows, un simple 'git' pourrait exécuter un git.exe placé dans le dépôt.
 */
let gitPath = 'git';

export function setGitPath(p: string) {
  gitPath = p;
}

export function git(cwd: string, args: string[], input?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(gitPath, args, { cwd, signal, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
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
export async function blame(cwd: string, file: string, contents: string, signal?: AbortSignal): Promise<BlameLine[]> {
  return parseBlame(await git(cwd, ['blame', '--porcelain', '--contents', '-', '--', file], contents, signal));
}

/** Blame du fichier tel qu'il était au commit `sha` (`file` relatif à `cwd`). */
export async function blameAt(cwd: string, sha: string, file: string, signal?: AbortSignal): Promise<BlameLine[]> {
  return parseBlame(await git(cwd, ['blame', '--porcelain', sha, '--', file], undefined, signal));
}

function parseBlame(out: string): BlameLine[] {
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

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

export interface Revision {
  sha: string;
  summary: string;
  /** Chemin du fichier dans ce commit, relatif à la racine du dépôt (suit les renommages). */
  path: string;
}

/** Commits ayant modifié le fichier, du plus récent au plus ancien. `file` est relatif à `root`. */
export async function fileHistory(root: string, file: string): Promise<Revision[]> {
  const out = await git(root, ['log', '--follow', '--topo-order', '-z', '--format=%H%x1f%s', '--name-only', '--', file]);
  const revisions: Revision[] = [];
  for (const token of out.split('\0')) {
    const text = token.replace(/^\n/, '');
    const sep = text.indexOf('\x1f');
    if (sep !== -1) {
      // Un merge n'a pas de nom de fichier : on garde celui du commit plus récent.
      const path = revisions[revisions.length - 1]?.path ?? file;
      revisions.push({ sha: text.slice(0, sep), summary: text.slice(sep + 1), path });
    } else if (text && revisions.length > 0) {
      revisions[revisions.length - 1].path = text;
    }
  }
  return revisions;
}

/** Contenu du fichier à un commit donné (`path` relatif à `root`). */
export async function showFile(root: string, sha: string, path: string): Promise<string> {
  return git(root, ['show', `${sha}:${path}`]);
}
