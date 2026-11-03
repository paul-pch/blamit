export type HostKind = 'github' | 'gitlab' | 'gitea';

export interface Remote {
  kind: HostKind;
  /** URL web de l'instance, sans slash final, ex : https://gitlab.com ou http://git.maboite.fr:3000 */
  baseUrl: string;
  /** Hôte web (avec port éventuel), sert de clé pour les tokens. */
  host: string;
  /** Chemin du projet, ex : group/sub/proj */
  path: string;
}

/** Valeur du réglage blamit.hosts : un type, ou un type et l'URL web (pour les alias SSH). */
export type HostOverride = HostKind | { type: HostKind; url?: string };

const kinds: readonly string[] = ['github', 'gitlab', 'gitea'];

/** Normalise une URL de remote (SSH ou HTTP(S)). Retourne undefined si l'hébergeur n'est pas reconnu. */
export function parseRemote(url: string, overrides: Record<string, HostOverride>): Remote | undefined {
  let host: string;
  let path: string;
  let protocol = 'https:';
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        protocol = u.protocol;
        host = u.host;
      } else {
        // Le port SSH n'a rien à voir avec le port web.
        host = u.hostname;
      }
      path = u.pathname;
    } catch {
      return undefined;
    }
  }
  path = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!path) {
    return undefined;
  }

  const hostname = host.split(':')[0];
  const override = overrides[host] ?? overrides[hostname];
  let kind: HostKind | undefined;
  let baseUrl = `${protocol}//${host}`;
  if (typeof override === 'string') {
    kind = kinds.includes(override) ? override : undefined;
  } else if (override && kinds.includes(override.type)) {
    kind = override.type;
    if (override.url) {
      baseUrl = override.url.replace(/\/+$/, '');
    }
  } else if (hostname.includes('github')) {
    kind = 'github';
  } else if (hostname.includes('gitlab')) {
    kind = 'gitlab';
  } else if (hostname.includes('gitea') || hostname.includes('forgejo')) {
    kind = 'gitea';
  }
  if (!kind) {
    return undefined;
  }
  try {
    return { kind, baseUrl, host: new URL(baseUrl).host, path };
  } catch {
    return undefined;
  }
}

export function commitUrl(r: Remote, sha: string): string {
  const base = `${r.baseUrl}/${r.path}`;
  return r.kind === 'gitlab' ? `${base}/-/commit/${sha}` : `${base}/commit/${sha}`;
}

export function mergeRequestUrl(r: Remote, n: number): string {
  const base = `${r.baseUrl}/${r.path}`;
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
      const api = r.host === 'github.com' ? 'https://api.github.com' : `${r.baseUrl}/api/v3`;
      const prs = await getJson<{ number: number; merged_at: string | null }[]>(
        `${api}/repos/${r.path}/commits/${sha}/pulls`,
        { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      );
      return (prs?.find((p) => p.merged_at) ?? prs?.[0])?.number;
    }
    case 'gitlab': {
      const mrs = await getJson<{ iid: number; state: string }[]>(
        `${r.baseUrl}/api/v4/projects/${encodeURIComponent(r.path)}/repository/commits/${sha}/merge_requests`,
        { 'PRIVATE-TOKEN': token },
      );
      return (mrs?.find((m) => m.state === 'merged') ?? mrs?.[0])?.iid;
    }
    case 'gitea': {
      const pr = await getJson<{ number: number }>(
        `${r.baseUrl}/api/v1/repos/${r.path}/commits/${sha}/pull`,
        { Authorization: `token ${token}` },
      );
      return pr?.number;
    }
  }
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T | undefined> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) {
    return undefined;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} (${url})`);
  }
  return (await res.json()) as T;
}
