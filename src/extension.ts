import * as path from 'path';
import * as vscode from 'vscode';
import { BlameLine, blame, commitMessage, findMergeCommit, remoteUrl } from './git';
import {
  Remote,
  commitUrl,
  fetchMergeRequestNumber,
  mergeRequestLabel,
  mergeRequestUrl,
  parseMergeRequestNumber,
  parseRemote,
} from './hosts';

const blameCache = new Map<string, Promise<BlameLine[] | undefined>>();
const messageCache = new Map<string, Promise<string>>();
/** SHA -> numéro de MR/PR, ou null si aucune trouvée. */
const mergeRequestCache = new Map<string, number | null>();

const decoration = vscode.window.createTextEditorDecorationType({
  after: {
    color: new vscode.ThemeColor('editorCodeLens.foreground'),
    fontStyle: 'italic',
    margin: '0 0 0 3em',
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
});

let secrets: vscode.SecretStorage;
let log: vscode.LogOutputChannel;
let timer: NodeJS.Timeout | undefined;
let lastEditor: vscode.TextEditor | undefined;

export function activate(context: vscode.ExtensionContext) {
  secrets = context.secrets;
  log = vscode.window.createOutputChannel('Simple Blame', { log: true });
  log.info('Extension activée');

  context.subscriptions.push(
    log,
    decoration,
    vscode.window.onDidChangeTextEditorSelection((e) => scheduleUpdate(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((e) => scheduleUpdate(e)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Ignore les panneaux Output & co, qui changent en permanence et bloqueraient le debounce.
      if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0) {
        return;
      }
      blameCache.delete(e.document.uri.toString());
      scheduleUpdate(vscode.window.activeTextEditor);
    }),
    vscode.workspace.onDidSaveTextDocument((d) => blameCache.delete(d.uri.toString())),
    vscode.workspace.onDidCloseTextDocument((d) => blameCache.delete(d.uri.toString())),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('simpleBlame')) {
        scheduleUpdate(vscode.window.activeTextEditor);
      }
    }),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover }),
    vscode.commands.registerCommand('simpleBlame.openCommit', openCommit),
    vscode.commands.registerCommand('simpleBlame.openMergeRequest', openMergeRequest),
    vscode.commands.registerCommand('simpleBlame.copySha', copySha),
    vscode.commands.registerCommand('simpleBlame.setToken', setToken),
  );

  scheduleUpdate(vscode.window.activeTextEditor);
}

export function deactivate() {
  clearTimeout(timer);
}

// --- Annotation ---------------------------------------------------------------

function scheduleUpdate(editor: vscode.TextEditor | undefined) {
  if (editor && editor.document.uri.scheme !== 'file') {
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => updateDecoration(editor), 150);
}

async function updateDecoration(editor: vscode.TextEditor | undefined) {
  if (lastEditor && lastEditor !== editor) {
    lastEditor.setDecorations(decoration, []);
  }
  lastEditor = editor;
  if (!editor) {
    return;
  }
  const enabled = vscode.workspace.getConfiguration('simpleBlame').get<boolean>('enabled', true);
  const line = editor.selection.active.line;
  const info = enabled ? await blameAt(editor.document, line) : undefined;

  // Le curseur a pu bouger pendant le blame.
  if (editor !== vscode.window.activeTextEditor || editor.selection.active.line !== line) {
    return;
  }
  log.trace(`Ligne ${line + 1} de ${editor.document.uri.fsPath} : ${info ? info.sha : 'pas de blame'}`);
  if (!info) {
    editor.setDecorations(decoration, []);
    return;
  }
  const text = info.committed
    ? `${info.author}, ${relativeTime(info.authorTime)} • ${info.summary}`
    : 'Vous • Non commité';
  const end = editor.document.lineAt(line).range.end;
  editor.setDecorations(decoration, [
    { range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } },
  ]);
}

async function blameAt(doc: vscode.TextDocument, line: number): Promise<BlameLine | undefined> {
  if (doc.uri.scheme !== 'file') {
    return undefined;
  }
  const key = doc.uri.toString();
  let lines = blameCache.get(key);
  if (!lines) {
    const file = doc.uri.fsPath;
    lines = blame(path.dirname(file), path.basename(file), doc.getText()).catch((err: Error) => {
      // Cas normal pour un fichier hors dépôt ou non suivi : on log sans alerter.
      log.warn(`git blame a échoué pour ${file} : ${err.message.trim()}`);
      return undefined;
    });
    blameCache.set(key, lines);
  }
  return (await lines)?.[line];
}

const relativeFormat = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

function relativeTime(time: number): string {
  const seconds = (time - Date.now()) / 1000;
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return relativeFormat.format(Math.round(seconds / size), unit);
    }
  }
  return "à l'instant";
}

// --- Hover --------------------------------------------------------------------

async function provideHover(doc: vscode.TextDocument, position: vscode.Position) {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document !== doc || editor.selection.active.line !== position.line) {
    return undefined;
  }
  const info = await blameAt(doc, position.line);
  if (!info?.committed) {
    return undefined;
  }
  const cwd = path.dirname(doc.uri.fsPath);
  const [message, remote] = await Promise.all([cachedMessage(cwd, info.sha), getRemote(cwd)]);

  const md = new vscode.MarkdownString();
  md.isTrusted = { enabledCommands: ['simpleBlame.openMergeRequest', 'simpleBlame.copySha'] };
  md.appendMarkdown(`**${escape(info.author)}** &lt;${escape(info.authorMail)}&gt; — `);
  md.appendMarkdown(`${new Date(info.authorTime).toLocaleString('fr-FR')} — \`${info.sha.slice(0, 8)}\`\n\n`);
  md.appendCodeblock(message, 'text');

  const links = [];
  if (remote) {
    links.push(`[Ouvrir le commit](${commitUrl(remote, info.sha)})`);
    const mr = mergeRequestCache.get(info.sha);
    if (typeof mr === 'number') {
      links.push(`[Ouvrir la MR/PR ${mergeRequestLabel(remote, mr)}](${mergeRequestUrl(remote, mr)})`);
    } else if (mr === undefined) {
      links.push('[Chercher la MR/PR](command:simpleBlame.openMergeRequest)');
    }
  }
  links.push('[Copier le SHA](command:simpleBlame.copySha)');
  md.appendMarkdown(links.join(' | '));
  return new vscode.Hover(md);
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|&]/g, '\\$&');
}

function cachedMessage(cwd: string, sha: string): Promise<string> {
  let msg = messageCache.get(sha);
  if (!msg) {
    msg = commitMessage(cwd, sha).catch(() => '');
    messageCache.set(sha, msg);
  }
  return msg;
}

// --- Commandes ----------------------------------------------------------------

interface LineContext {
  cwd: string;
  info: BlameLine;
  remote: Remote | undefined;
}

async function currentLine(): Promise<LineContext | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const info = await blameAt(editor.document, editor.selection.active.line);
  if (!info) {
    vscode.window.showWarningMessage('Simple Blame : pas de blame disponible pour cette ligne.');
    return undefined;
  }
  if (!info.committed) {
    vscode.window.showInformationMessage('Simple Blame : cette ligne n\'est pas encore commitée.');
    return undefined;
  }
  const cwd = path.dirname(editor.document.uri.fsPath);
  return { cwd, info, remote: await getRemote(cwd) };
}

async function getRemote(cwd: string): Promise<Remote | undefined> {
  const config = vscode.workspace.getConfiguration('simpleBlame');
  const url = await remoteUrl(cwd, config.get<string>('remote', 'origin')).catch(() => undefined);
  const remote = url ? parseRemote(url, config.get<Record<string, string>>('hosts', {})) : undefined;
  if (url && !remote) {
    log.warn(`Hébergeur non reconnu pour ${url} : à déclarer dans le réglage simpleBlame.hosts`);
  }
  return remote;
}

function warnNoRemote() {
  vscode.window.showWarningMessage(
    'Simple Blame : remote introuvable ou hébergeur non reconnu (voir le réglage simpleBlame.hosts).',
  );
}

async function openCommit() {
  const ctx = await currentLine();
  if (!ctx) {
    return;
  }
  if (!ctx.remote) {
    return warnNoRemote();
  }
  vscode.env.openExternal(vscode.Uri.parse(commitUrl(ctx.remote, ctx.info.sha)));
}

async function openMergeRequest() {
  const ctx = await currentLine();
  if (!ctx) {
    return;
  }
  const { cwd, info, remote } = ctx;
  if (!remote) {
    return warnNoRemote();
  }
  let mr: number | undefined;
  try {
    mr = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Recherche de la MR/PR…' },
      () => findMergeRequest(cwd, remote, info.sha),
    );
  } catch (err) {
    log.error(err as Error);
    vscode.window.showErrorMessage(`Simple Blame : échec de l'appel API — ${(err as Error).message}`);
    return;
  }
  if (mr !== undefined) {
    vscode.env.openExternal(vscode.Uri.parse(mergeRequestUrl(remote, mr)));
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'Simple Blame : aucune MR/PR trouvée pour ce commit.',
    'Ouvrir le commit à la place',
  );
  if (choice) {
    vscode.env.openExternal(vscode.Uri.parse(commitUrl(remote, info.sha)));
  }
}

async function findMergeRequest(cwd: string, remote: Remote, sha: string): Promise<number | undefined> {
  const cached = mergeRequestCache.get(sha);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  // 1. Message du commit lui-même (squash merge).
  let mr = parseMergeRequestNumber(remote.kind, await cachedMessage(cwd, sha));
  // 2. Message du commit de merge qui l'a intégré.
  if (mr === undefined) {
    const merge = await findMergeCommit(cwd, sha).catch(() => undefined);
    if (merge) {
      mr = parseMergeRequestNumber(remote.kind, await cachedMessage(cwd, merge));
    }
  }
  // 3. API, si un token est configuré pour cet hôte.
  if (mr === undefined) {
    const token = await secrets.get(tokenKey(remote.host));
    if (token) {
      mr = await fetchMergeRequestNumber(remote, sha, token);
    }
  }

  mergeRequestCache.set(sha, mr ?? null);
  return mr;
}

async function copySha() {
  const ctx = await currentLine();
  if (ctx) {
    await vscode.env.clipboard.writeText(ctx.info.sha);
    vscode.window.setStatusBarMessage(`SHA copié : ${ctx.info.sha.slice(0, 8)}`, 3000);
  }
}

function tokenKey(host: string): string {
  return `token:${host}`;
}

async function setToken() {
  const editor = vscode.window.activeTextEditor;
  const remote = editor?.document.uri.scheme === 'file'
    ? await getRemote(path.dirname(editor.document.uri.fsPath))
    : undefined;
  const host = await vscode.window.showInputBox({
    prompt: 'Hôte (ex : gitlab.com, github.com, git.maboite.fr)',
    value: remote?.host ?? '',
  });
  if (!host) {
    return;
  }
  const token = await vscode.window.showInputBox({
    prompt: `Token API pour ${host} (laisser vide pour supprimer)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) {
    return;
  }
  if (token) {
    await secrets.store(tokenKey(host), token);
    vscode.window.showInformationMessage(`Simple Blame : token enregistré pour ${host}.`);
  } else {
    await secrets.delete(tokenKey(host));
    vscode.window.showInformationMessage(`Simple Blame : token supprimé pour ${host}.`);
  }
  // Les recherches infructueuses peuvent maintenant aboutir via l'API.
  for (const [sha, mr] of mergeRequestCache) {
    if (mr === null) {
      mergeRequestCache.delete(sha);
    }
  }
}
