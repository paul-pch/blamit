export type HostKind = 'github' | 'gitlab' | 'gitea';

export interface Remote {
  kind: HostKind;
  /** Hôte web, ex : gitlab.com ou git.maboite.fr:3000 */
  host: string;
  /** Chemin du projet, ex : group/sub/proj */
  path: string;
}

/** Normalise une URL de remote (SSH ou HTTPS). Retourne undefined si l'hébergeur n'est pas reconnu. */
export function parseRemote(url: string, overrides: Record<string, string>): Remote | undefined {
  let host: string;
  let path: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(url);
      // Le port SSH n'a rien à voir avec le port web.
      host = u.protocol.startsWith('http') ? u.host : u.hostname;
      path = u.pathname;
    } catch {
      return undefined;
    }
  }
  path = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');

  const hostname = host.split(':')[0];
  const override = overrides[host] ?? overrides[hostname];
  let kind: HostKind | undefined;
  if (override === 'github' || override === 'gitlab' || override === 'gitea') {
    kind = override;
  } else if (hostname.includes('github')) {
    kind = 'github';
  } else if (hostname.includes('gitlab')) {
    kind = 'gitlab';
  } else if (hostname.includes('gitea') || hostname.includes('forgejo')) {
    kind = 'gitea';
  }
  return kind && path ? { kind, host, path } : undefined;
}

export function commitUrl(r: Remote, sha: string): string {
  const base = `https://${r.host}/${r.path}`;
  return r.kind === 'gitlab' ? `${base}/-/commit/${sha}` : `${base}/commit/${sha}`;
}

export function mergeRequestUrl(r: Remote, n: number): string {
  const base = `https://${r.host}/${r.path}`;
  switch (r.kind) {
    case 'github':
      return `${base}/pull/${n}`;
    case 'gitlab':
      return `${base}/-/merge_requests/${n}`;
    case 'gitea':
      return `${base}/pulls/${n}`;
  }
}

export function mergeRequestLabel(r: Remote, n: number): string {
  return r.kind === 'gitlab' ? `!${n}` : `#${n}`;
}

/** Cherche un numéro de MR/PR dans un message de commit (squash ou merge). */
export function parseMergeRequestNumber(kind: HostKind, message: string): number | undefined {
  const title = message.split('\n')[0];
  let m: RegExpExecArray | null;
  switch (kind) {
    case 'gitlab':
      m = /See merge request \S*!(\d+)/.exec(message);
      break;
    case 'github':
      m = /^Merge pull request #(\d+)/.exec(title) ?? /\(#(\d+)\)\s*$/.exec(title);
      break;
    case 'gitea':
      m = /\(#(\d+)\)/.exec(title);
      break;
  }
  return m ? Number(m[1]) : undefined;
}

/** Interroge l'API de l'hébergeur pour trouver la MR/PR contenant le commit. */
export async function fetchMergeRequestNumber(r: Remote, sha: string, token: string): Promise<number | undefined> {
  switch (r.kind) {
    case 'github': {
      const api = r.host === 'github.com' ? 'https://api.github.com' : `https://${r.host}/api/v3`;
      const prs = await getJson<{ number: number; merged_at: string | null }[]>(
        `${api}/repos/${r.path}/commits/${sha}/pulls`,
        { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      );
      return (prs?.find((p) => p.merged_at) ?? prs?.[0])?.number;
    }
    case 'gitlab': {
      const mrs = await getJson<{ iid: number; state: string }[]>(
        `https://${r.host}/api/v4/projects/${encodeURIComponent(r.path)}/repository/commits/${sha}/merge_requests`,
        { 'PRIVATE-TOKEN': token },
      );
      return (mrs?.find((m) => m.state === 'merged') ?? mrs?.[0])?.iid;
    }
    case 'gitea': {
      const pr = await getJson<{ number: number }>(
        `https://${r.host}/api/v1/repos/${r.path}/commits/${sha}/pull`,
        { Authorization: `token ${token}` },
      );
      return pr?.number;
    }
  }
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T | undefined> {
  const res = await fetch(url, { headers });
  if (res.status === 404) {
    return undefined;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} (${url})`);
  }
  return (await res.json()) as T;
}
