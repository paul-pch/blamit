import { execFile } from 'child_process';

export interface BlameLine {
  sha: string;
  author: string;
  authorMail: string;
  /** Epoch en millisecondes. */
  authorTime: number;
  summary: string;
  committed: boolean;
  /** Numéro de la ligne (1-based) dans le fichier tel qu'il était à ce commit. */
  origLine: number;
  /** Chemin du fichier à ce commit, relatif à la racine du dépôt. */
  path: string;
}

type CommitInfo = Omit<BlameLine, 'origLine' | 'path'>;

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
  const commits = new Map<string, CommitInfo>();
  const lines: BlameLine[] = [];
  let current: CommitInfo | undefined;
  let origLine = 0;
  let finalLine = 0;
  let file = '';

  for (const raw of out.split('\n')) {
    if (raw.startsWith('\t')) {
      // Ligne de contenu : clôt l'entrée en cours.
      if (current) {
        lines[finalLine - 1] = { ...current, origLine, path: file };
      }
      continue;
    }
    const header = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(raw);
    if (header) {
      const sha = header[1];
      origLine = Number(header[2]);
      finalLine = Number(header[3]);
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
      case 'filename':
        file = value;
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

/** Changement ayant introduit une ligne : le fichier entier a été ajouté, ou un extrait du diff. */
export type LineChange = { fileAdded: true } | { fileAdded: false; diff: string };

/**
 * Extrait du diff de `sha` autour de la ligne `line` (1-based) du fichier `path` (relatif à la racine du dépôt) :
 * le bloc de modifications qui l'a introduite, avec quelques lignes de contexte.
 */
export async function lineChange(cwd: string, sha: string, path: string, line: number): Promise<LineChange | undefined> {
  const diff = await git(cwd, ['show', '--format=', '--no-color', '--no-ext-diff', '-U3', sha, '--', `:(top)${path}`]);
  return extractChange(diff, line);
}

/**
 * Dans un diff unifié d'un seul fichier, renvoie le bloc de lignes ajoutées/supprimées contenant la ligne
 * ajoutée n°`line` (numérotation du nouveau fichier), entouré d'au plus `context` lignes de contexte,
 * et tronqué à `max` lignes centrées sur la ligne visée.
 */
export function extractChange(diff: string, line: number, context = 3, max = 20): LineChange | undefined {
  // Fichier créé par ce commit : l'extrait ne serait qu'une suite de « + ».
  if (/^@@ -0,0 \+/m.test(diff)) {
    return { fileAdded: true };
  }
  let hunk: { text: string; newLine?: number }[] | undefined;
  let next = 0;
  for (const raw of diff.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      if (hunk) {
        const found = pick(hunk, line, context, max);
        if (found) {
          return { fileAdded: false, diff: found };
        }
      }
      hunk = [];
      next = Number(header[1]);
      continue;
    }
    if (!hunk) {
      continue;
    }
    const kind = raw[0];
    if (kind === '+' || kind === ' ') {
      hunk.push({ text: raw, newLine: next++ });
    } else if (kind === '-') {
      hunk.push({ text: raw });
    } else if (kind !== '\\') {
      // Fin du hunk (ligne vide finale ou fichier suivant).
      const found = pick(hunk, line, context, max);
      if (found) {
        return { fileAdded: false, diff: found };
      }
      hunk = undefined;
    }
  }
  const found = hunk && pick(hunk, line, context, max);
  return found ? { fileAdded: false, diff: found } : undefined;
}

function pick(hunk: { text: string; newLine?: number }[], line: number, context: number, max: number) {
  const target = hunk.findIndex((l) => l.newLine === line && l.text[0] === '+');
  if (target === -1) {
    return undefined;
  }
  const changed = (i: number) => hunk[i].text[0] !== ' ';
  let start = target;
  while (start > 0 && changed(start - 1)) {
    start--;
  }
  let end = target + 1;
  while (end < hunk.length && changed(end)) {
    end++;
  }
  start = Math.max(0, start - context);
  end = Math.min(hunk.length, end + context);
  if (end - start > max) {
    start = Math.min(Math.max(start, target - Math.floor(max / 2)), end - max);
    end = start + max;
  }
  return hunk
    .slice(start, end)
    .map((l) => l.text)
    .join('\n');
}
