import * as path from 'path';
import * as vscode from 'vscode';
import { BlameLine, blame, commitMessage, findMergeCommit, remoteUrl, setGitPath } from './git';
import {
  HostOverride,
  Remote,
  commitUrl,
  fetchMergeRequestNumber,
  mergeRequestLabel,
  mergeRequestUrl,
  parseMergeRequestNumber,
  parseRemote,
} from './hosts';

interface BlameEntry {
  lines: Promise<BlameLine[] | undefined>;
  abort: AbortController;
  /** Fichier hors dépôt ou non suivi : inutile de relancer git à chaque frappe. */
  failed: boolean;
}

const blameCache = new Map<string, BlameEntry>();
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

export async function activate(context: vscode.ExtensionContext) {
  secrets = context.secrets;
  log = vscode.window.createOutputChannel('Blamit', { log: true });
  context.subscriptions.push(log, decoration);
  await resolveGitPath();

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => scheduleUpdate(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      // Le fichier a pu être ajouté au dépôt entre-temps.
      if (e && blameCache.get(e.document.uri.toString())?.failed) {
        invalidate(e.document);
      }
      scheduleUpdate(e);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Ignore les panneaux Output & co, qui changent en permanence et bloqueraient le debounce.
      if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0) {
        return;
      }
      if (!blameCache.get(e.document.uri.toString())?.failed) {
        invalidate(e.document);
      }
      scheduleUpdate(vscode.window.activeTextEditor);
    }),
    vscode.workspace.onDidSaveTextDocument(invalidate),
    vscode.workspace.onDidCloseTextDocument(invalidate),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('blamit')) {
        mergeRequestCache.clear();
        scheduleUpdate(vscode.window.activeTextEditor);
      }
    }),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover }),
    vscode.commands.registerCommand('blamit.openCommit', openCommit),
    vscode.commands.registerCommand('blamit.openMergeRequest', openMergeRequest),
    vscode.commands.registerCommand('blamit.copySha', copySha),
    vscode.commands.registerCommand('blamit.setToken', setToken),
  );

  scheduleUpdate(vscode.window.activeTextEditor);
}

export function deactivate() {
  clearTimeout(timer);
  for (const entry of blameCache.values()) {
    entry.abort.abort();
  }
}

async function resolveGitPath() {
  try {
    const ext = vscode.extensions.getExtension('vscode.git');
    const api = (await ext?.activate())?.getAPI(1);
    if (api?.git.path) {
      setGitPath(api.git.path);
      log.info(`Using git at ${api.git.path}`);
      return;
    }
  } catch (err) {
    log.debug(`Git extension unavailable: ${(err as Error).message}`);
  }
  log.warn('Git extension unavailable, falling back to "git" from PATH');
}

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration('blamit').get<boolean>('enabled', true);
}

// --- Annotation ---------------------------------------------------------------

function scheduleUpdate(editor: vscode.TextEditor | undefined) {
  if (editor && editor.document.uri.scheme !== 'file') {
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => {
    updateDecoration(editor).catch((err: Error) => log.error(err));
  }, 150);
}

async function updateDecoration(editor: vscode.TextEditor | undefined) {
  if (lastEditor && lastEditor !== editor) {
    lastEditor.setDecorations(decoration, []);
  }
  lastEditor = editor;
  if (!editor) {
    return;
  }
  const line = editor.selection.active.line;
  const info = isEnabled() ? await blameAt(editor.document, line) : undefined;

  // Le curseur a pu bouger pendant le blame.
  if (editor !== vscode.window.activeTextEditor || editor.selection.active.line !== line) {
    return;
  }
  log.trace(`Line ${line + 1} of ${editor.document.uri.fsPath}: ${info ? info.sha : 'no blame'}`);
  if (!info) {
    editor.setDecorations(decoration, []);
    return;
  }
  const text = info.committed
    ? `${info.author}, ${relativeTime(info.authorTime)} • ${info.summary}`
    : vscode.l10n.t('You • Not committed yet');
  const end = editor.document.lineAt(line).range.end;
  editor.setDecorations(decoration, [
    { range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } },
  ]);
}

function invalidate(doc: vscode.TextDocument) {
  const key = doc.uri.toString();
  blameCache.get(key)?.abort.abort();
  blameCache.delete(key);
}

async function blameAt(doc: vscode.TextDocument, line: number): Promise<BlameLine | undefined> {
  if (doc.uri.scheme !== 'file') {
    return undefined;
  }
  const key = doc.uri.toString();
  let entry = blameCache.get(key);
  if (!entry) {
    const file = doc.uri.fsPath;
    const abort = new AbortController();
    const created: BlameEntry = { abort, failed: false, lines: Promise.resolve(undefined) };
    created.lines = blame(path.dirname(file), path.basename(file), doc.getText(), abort.signal).catch(
      (err: Error) => {
        if (!abort.signal.aborted) {
          // Cas normal pour un fichier hors dépôt ou non suivi.
          created.failed = true;
          log.debug(`git blame failed for ${file}: ${err.message.trim()}`);
        }
        return undefined;
      },
    );
    entry = created;
    blameCache.set(key, entry);
  }
  return (await entry.lines)?.[line];
}

function relativeTime(time: number): string {
  const seconds = (time - Date.now()) / 1000;
  const format = new Intl.RelativeTimeFormat(vscode.env.language, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return vscode.l10n.t('just now');
}

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

// --- Hover --------------------------------------------------------------------

async function provideHover(doc: vscode.TextDocument, position: vscode.Position) {
  const editor = vscode.window.activeTextEditor;
  if (!isEnabled() || editor?.document !== doc || editor.selection.active.line !== position.line) {
    return undefined;
  }
  // Uniquement au survol de l'annotation, pour ne pas polluer les hovers du langage.
  if (position.character < doc.lineAt(position.line).range.end.character) {
    return undefined;
  }
  const info = await blameAt(doc, position.line);
  if (!info?.committed) {
    return undefined;
  }
  const cwd = path.dirname(doc.uri.fsPath);
  const [message, remote] = await Promise.all([cachedMessage(cwd, info.sha), getRemote(cwd)]);

  const md = new vscode.MarkdownString();
  md.isTrusted = { enabledCommands: ['blamit.openMergeRequest', 'blamit.copySha'] };
  md.appendMarkdown(`**${escape(info.author)}** &lt;${escape(info.authorMail)}&gt; — `);
  md.appendMarkdown(`${new Date(info.authorTime).toLocaleString(vscode.env.language)} — \`${info.sha.slice(0, 8)}\`\n\n`);
  md.appendCodeblock(message, 'text');

  const links = [];
  if (remote) {
    links.push(`[${vscode.l10n.t('Open commit')}](${commitUrl(remote, info.sha)})`);
    const mr = mergeRequestCache.get(info.sha);
    if (typeof mr === 'number') {
      const label = vscode.l10n.t('Open MR/PR {0}', mergeRequestLabel(remote, mr));
      links.push(`[${label}](${mergeRequestUrl(remote, mr)})`);
    } else if (mr === undefined) {
      links.push(`[${vscode.l10n.t('Find MR/PR')}](command:blamit.openMergeRequest)`);
    }
  }
  links.push(`[${vscode.l10n.t('Copy SHA')}](command:blamit.copySha)`);
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
    vscode.window.showWarningMessage(vscode.l10n.t('Blamit: no blame available for this line.'));
    return undefined;
  }
  if (!info.committed) {
    vscode.window.showInformationMessage(vscode.l10n.t('Blamit: this line is not committed yet.'));
    return undefined;
  }
  const cwd = path.dirname(editor.document.uri.fsPath);
  return { cwd, info, remote: await getRemote(cwd) };
}

async function getRemote(cwd: string): Promise<Remote | undefined> {
  const config = vscode.workspace.getConfiguration('blamit');
  const url = await remoteUrl(cwd, config.get<string>('remote', 'origin')).catch(() => undefined);
  const remote = url ? parseRemote(url, config.get<Record<string, HostOverride>>('hosts', {})) : undefined;
  if (url && !remote) {
    log.warn(`Unrecognized host for ${url}: declare it in the blamit.hosts setting`);
  }
  return remote;
}

function warnNoRemote() {
  vscode.window.showWarningMessage(
    vscode.l10n.t('Blamit: remote not found or host not recognized (see the blamit.hosts setting).'),
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
      { location: vscode.ProgressLocation.Window, title: vscode.l10n.t('Looking up the MR/PR…') },
      () => findMergeRequest(cwd, remote, info.sha),
    );
  } catch (err) {
    log.error(err as Error);
    vscode.window.showErrorMessage(vscode.l10n.t('Blamit: API call failed — {0}', (err as Error).message));
    return;
  }
  if (mr !== undefined) {
    vscode.env.openExternal(vscode.Uri.parse(mergeRequestUrl(remote, mr)));
    return;
  }
  const openInstead = vscode.l10n.t('Open the commit instead');
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Blamit: no MR/PR found for this commit.'),
    openInstead,
  );
  if (choice === openInstead) {
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
    vscode.window.setStatusBarMessage(vscode.l10n.t('SHA copied: {0}', ctx.info.sha.slice(0, 8)), 3000);
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
    prompt: vscode.l10n.t('Host (e.g. gitlab.com, github.com, git.example.com)'),
    value: remote?.host ?? '',
  });
  if (!host) {
    return;
  }
  const token = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('API token for {0} (leave empty to remove)', host),
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) {
    return;
  }
  if (token) {
    await secrets.store(tokenKey(host), token);
    vscode.window.showInformationMessage(vscode.l10n.t('Blamit: token saved for {0}.', host));
  } else {
    await secrets.delete(tokenKey(host));
    vscode.window.showInformationMessage(vscode.l10n.t('Blamit: token removed for {0}.', host));
  }
  // Les recherches infructueuses peuvent maintenant aboutir via l'API.
  for (const [sha, mr] of mergeRequestCache) {
    if (mr === null) {
      mergeRequestCache.delete(sha);
    }
  }
}
