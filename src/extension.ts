// The extension: a language client for loom-lsp, the Loom: command palette entries, and a status bar item.
// Per the plan it launches the browser rather than embedding a webview: arras is a web application, and a browser tab is what it wants to be.

import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, State, TransportKind } from 'vscode-languageclient/node';

import { argvFor, confirmationFor, nodeUrl, Settings } from './commands';
import { dismissedKey, plan } from './latexWorkshop';
import { findQuilt, keyAt } from './quilt';
import { freePort, waitForManifest } from './serve';

let client: LanguageClient | undefined;
/** Why the last start failed, for the output channel and for the tests. */
export let lastStartError: string | undefined;
let status: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

export function settings(): Settings {
	const c = vscode.workspace.getConfiguration('loom');
	// LOOM_BIN and LOOM_LSP override the settings. The extension host does not inherit a shell's PATH, so a test harness, or anyone launching the editor from a virtual environment, needs a way to name the executables that does not write to the user's settings.
	return {
		loomPath: process.env.LOOM_BIN || c.get<string>('loomPath', 'loom'),
		serverPath: process.env.LOOM_LSP || c.get<string>('serverPath', 'loom-lsp')
	};
}

/** The quilt of the active editor, else of the first workspace folder that is one. */
export function currentQuilt(): string | undefined {
	const doc = vscode.window.activeTextEditor?.document;
	if (doc && doc.uri.scheme === 'file') {
		const root = findQuilt(doc.uri.fsPath);
		if (root) {
			return root;
		}
	}
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const root = findQuilt(folder.uri.fsPath);
		if (root) {
			return root;
		}
	}
	return undefined;
}

function keyUnderCursor(): string | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return undefined;
	}
	const root = editor.document.uri.scheme === 'file' ? findQuilt(editor.document.uri.fsPath) : undefined;
	return keyAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active), root);
}

function run(argv: string[], root: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(argv[0], argv.slice(1), { cwd: root, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
			resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, stdout, stderr });
		});
	});
}

async function show(title: string, body: string, language = 'plaintext'): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({ content: body, language });
	await vscode.window.showTextDocument(doc, { preview: true });
	output?.appendLine(`${title}: ${body.split('\n').length} line(s)`);
}

async function runNamed(name: string, arg?: string): Promise<void> {
	const root = currentQuilt();
	if (!root) {
		void vscode.window.showWarningMessage('loom: this workspace is not a quilt.');
		return;
	}
	const argv = argvFor(name, root, settings(), arg);
	if (!argv) {
		void vscode.window.showWarningMessage(`loom ${name}: nothing to act on.`);
		return;
	}
	const confirmation = confirmationFor(name, arg);
	if (confirmation) {
		const answer = await vscode.window.showWarningMessage(confirmation, { modal: true }, 'Run it');
		if (answer !== 'Run it') {
			return;
		}
	}
	const result = await run(argv, root);
	if (result.code !== 0) {
		void vscode.window.showErrorMessage(`loom ${name} failed: ${result.stderr || result.stdout}`);
		return;
	}
	if (name === 'lint') {
		await showLint(result.stdout, root);
		return;
	}
	await show(`loom ${name}`, result.stdout, name === 'bundle' ? 'latex' : 'plaintext');
}

const diagnostics = vscode.languages.createDiagnosticCollection('loom-cli');

async function showLint(json: string, root: string): Promise<void> {
	diagnostics.clear();
	let parsed: Array<{
		severity: string;
		code: string;
		message: string;
		locations: Array<{ file: string; line: number; column?: number }>;
	}>;
	try {
		parsed = JSON.parse(json);
	} catch {
		await show('loom lint', json);
		return;
	}
	const byFile = new Map<string, vscode.Diagnostic[]>();
	for (const d of parsed) {
		for (const loc of d.locations ?? []) {
			const uri = vscode.Uri.file(`${root}/${loc.file}`).toString();
			const line = Math.max(0, (loc.line ?? 1) - 1);
			const col = Math.max(0, (loc.column ?? 1) - 1);
			const item = new vscode.Diagnostic(
				new vscode.Range(line, col, line, col + 1),
				d.message,
				d.severity === 'error'
					? vscode.DiagnosticSeverity.Error
					: d.severity === 'warning'
						? vscode.DiagnosticSeverity.Warning
						: vscode.DiagnosticSeverity.Information
			);
			item.code = d.code;
			item.source = 'loom';
			byFile.set(uri, [...(byFile.get(uri) ?? []), item]);
		}
	}
	for (const [uri, items] of byFile) {
		diagnostics.set(vscode.Uri.parse(uri), items);
	}
	void vscode.window.showInformationMessage(`loom lint: ${parsed.length} diagnostic(s)`);
}

/** Injected in tests so no browser opens and no real server starts. */
export const hooks: {
	openExternal: (url: string) => Thenable<boolean>;
	startServer: (argv: string[], cwd: string) => vscode.Terminal;
	latexWorkshopVersion: () => string | undefined;
	writeLatexWorkshopSetting: (key: string, value: unknown, folder: vscode.Uri) => Thenable<void>;
	ask: (message: string, ...items: string[]) => Thenable<string | undefined>;
} = {
	openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
	// the terminal runs loom itself rather than a shell, so it ends when loom does; it is never shown, so the editor keeps focus
	startServer: (argv, cwd) =>
		vscode.window.createTerminal({ name: 'loom serve', cwd, shellPath: argv[0], shellArgs: argv.slice(1) }),
	latexWorkshopVersion: () => vscode.extensions.getExtension('James-Yu.latex-workshop')?.packageJSON?.version,
	// writing a setting LaTeX Workshop has not registered throws, so tests without it replace this
	writeLatexWorkshopSetting: (key, value, folder) =>
		vscode.workspace.getConfiguration('latex-workshop', folder).update(key, value, vscode.ConfigurationTarget.WorkspaceFolder),
	ask: (message, ...items) => vscode.window.showInformationMessage(message, ...items)
};

/** Quilts already warned this session that their LaTeX Workshop is too old, and quilts with an automatic prompt open or answered 'Not now'. */
const latexWorkshopWarned = new Set<string>();
const latexWorkshopQuiet = new Set<string>();

/** Forget "Don't ask again" and this session's prompts for `root`; for tests. */
export async function resetLatexWorkshopPrompt(root: string): Promise<void> {
	latexWorkshopWarned.delete(root);
	latexWorkshopQuiet.delete(root);
	await extensionContext?.workspaceState.update(dismissedKey(root), undefined);
}

/**
 * Offer to make LaTeX Workshop compile the quilt at `root` from its root, and write the setting to the workspace folder on 'Set it'.
 *
 * `interactive` is the palette command: it always asks and reports when nothing is needed. Otherwise it stays silent unless a change is needed, asks at most once a session, and never after "Don't ask again". Write errors become warnings.
 */
export async function configureLatexWorkshop(root: string, interactive: boolean): Promise<void> {
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
	const config = vscode.workspace.getConfiguration('latex-workshop', folder?.uri);
	const todo = plan({
		version: hooks.latexWorkshopVersion(),
		workspaceFolder: folder?.uri.fsPath,
		quiltRoot: root,
		currentFromFolder: config.get<string>('latex.build.fromFolder'),
		currentFromWorkspaceFolder: config.get<boolean>('latex.build.fromWorkspaceFolder')
	});
	if (todo.kind === 'none') {
		if (interactive) {
			void vscode.window.showInformationMessage(
				todo.reason === 'not installed' ? 'LaTeX Workshop is not installed.' : 'LaTeX Workshop already compiles this quilt from its root.'
			);
		}
		return;
	}
	if (todo.kind === 'unsupported') {
		if (interactive || !latexWorkshopWarned.has(root)) {
			latexWorkshopWarned.add(root);
			void vscode.window.showWarningMessage(todo.message);
		}
		return;
	}
	if (!folder) {
		return;
	}
	if (!interactive && (latexWorkshopQuiet.has(root) || extensionContext?.workspaceState.get(dismissedKey(root)))) {
		return;
	}
	const message = "LaTeX Workshop compiles from the main file's folder, where loom.sty and nodes/ are not found. Compile this quilt from its root?";
	if (!interactive) {
		latexWorkshopQuiet.add(root);
	}
	const answer = interactive ? await hooks.ask(message, 'Set it', 'Cancel') : await hooks.ask(message, 'Set it', 'Not now', "Don't ask again");
	if (answer === "Don't ask again") {
		await extensionContext?.workspaceState.update(dismissedKey(root), true);
		latexWorkshopQuiet.delete(root);
		return;
	}
	if (answer !== 'Set it') {
		return;
	}
	const [key, value] = todo.kind === 'fromFolder' ? ['latex.build.fromFolder', todo.value] : ['latex.build.fromWorkspaceFolder', true];
	try {
		await hooks.writeLatexWorkshopSetting(key, value, folder.uri);
	} catch (err) {
		void vscode.window.showWarningMessage(`loom: could not write latex-workshop.${key}: ${String(err)}`);
		return;
	}
	void vscode.window.showInformationMessage(`LaTeX Workshop will compile this quilt from its root (latex-workshop.${key} = ${String(value)} in this folder's settings)`);
}

/** The `loom serve` this window owns, one per quilt root. */
export const servers = new Map<string, { port: number; url: string; terminal: vscode.Terminal }>();
/** Starts in flight, so two quick calls for one quilt share a server. */
const starting = new Map<string, Promise<{ url: string; started: boolean } | undefined>>();

/** Dispose every server terminal, which ends its process, and forget them all. */
export function stopServers(): void {
	for (const server of servers.values()) {
		server.terminal.dispose();
	}
	servers.clear();
}

/**
 * The URL of this window's `loom serve` for `root`, starting one on a free port if none is running.
 *
 * `started` is true when this call started it. A server that exits before answering is retried once on a new port, since the likeliest cause is a port taken in between; a server that is alive but silent for 30 s gets a warning and undefined.
 */
export function ensureServer(root: string): Promise<{ url: string; started: boolean } | undefined> {
	const existing = servers.get(root);
	if (existing && existing.terminal.exitStatus === undefined) {
		return Promise.resolve({ url: existing.url, started: false });
	}
	const pending = starting.get(root);
	if (pending) {
		return pending;
	}
	const made = startServerFor(root).finally(() => starting.delete(root));
	starting.set(root, made);
	return made;
}

async function startServerFor(root: string): Promise<{ url: string; started: boolean } | undefined> {
	const stale = servers.get(root);
	if (stale) {
		stale.terminal.dispose();
		servers.delete(root);
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		const port = await freePort();
		const argv = argvFor('serve', root, settings(), String(port))!;
		const url = `http://127.0.0.1:${port}/`;
		const terminal = hooks.startServer(argv, root);
		const alive = () => terminal.exitStatus === undefined;
		if (await waitForManifest(url, 30000, alive)) {
			servers.set(root, { port, url, terminal });
			void vscode.window.showInformationMessage(`loom serve started in terminal '${terminal.name}' at ${url}`);
			return { url, started: true };
		}
		if (alive()) {
			void vscode.window.showWarningMessage(`loom serve did not answer at ${url} within 30 s; see the terminal '${terminal.name}'.`);
			return undefined;
		}
		output?.appendLine(`loom serve on port ${port} exited before it answered (code ${terminal.exitStatus?.code ?? 'unknown'})`);
		terminal.dispose();
	}
	void vscode.window.showWarningMessage('loom serve exited before it answered, twice; run it in a terminal to see why.');
	return undefined;
}

/** Carry out a `loom.run` from a code action: an argument vector, and a confirmation to ask first when it is non-empty. */
async function runArgv(argv: unknown, confirm: unknown): Promise<void> {
	if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
		void vscode.window.showWarningMessage('loom: that command carried no argument vector.');
		return;
	}
	const args = argv as string[];
	const flag = args.indexOf('--quilt');
	const root = flag >= 0 && flag + 1 < args.length ? args[flag + 1] : currentQuilt();
	if (!root) {
		void vscode.window.showWarningMessage('loom: this workspace is not a quilt.');
		return;
	}
	if (typeof confirm === 'string' && confirm) {
		const answer = await vscode.window.showWarningMessage(confirm, { modal: true }, 'Run it');
		if (answer !== 'Run it') {
			return;
		}
	}
	const name = args[1] ?? 'loom';
	const result = await run(args, root);
	if (result.code !== 0) {
		void vscode.window.showErrorMessage(`loom ${name} failed: ${result.stderr || result.stdout}`);
		return;
	}
	await show(`loom ${name}`, result.stdout, args.includes('--print') ? 'latex' : 'plaintext');
}

/** The language client, for tests and for a status display. */
export function currentClient(): LanguageClient | undefined {
	return client;
}

/**
 * Apply the first `kind` code action the server offers at the cursor, as a palette command.
 *
 * The server plans these as workspace edits and the editor applies them, so loom never writes the author's file and one undo puts it back. `what` names the action in the message when there is none to apply, and `hint` is a further sentence for that message. Entries without an edit, and kinds the request did not ask for, are another extension's and are left alone.
 */
async function applyCodeActionAt(kind: vscode.CodeActionKind, what: string, hint?: string): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.uri.scheme !== 'file' || !findQuilt(editor.document.uri.fsPath)) {
		void vscode.window.showWarningMessage('loom: open a file of a quilt first.');
		return;
	}
	if (!currentClient()) {
		void vscode.window.showWarningMessage('loom: the language server is not running.');
		return;
	}
	const offered = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
		'vscode.executeCodeActionProvider',
		editor.document.uri,
		editor.selection,
		kind.value
	);
	const ours = (offered ?? []).filter((entry): entry is vscode.CodeAction => {
		const action = entry as vscode.CodeAction;
		return !!action.edit && !!action.kind && kind.contains(action.kind);
	});
	if (ours.length === 0) {
		void vscode.window.showInformationMessage(`loom: there is nothing to ${what} here.${hint ? ` ${hint}` : ''}`);
		return;
	}
	const action = ours[0];
	if (!(await vscode.workspace.applyEdit(action.edit!))) {
		void vscode.window.showWarningMessage(`loom: the editor did not apply '${action.title}'.`);
		return;
	}
	void vscode.window.showInformationMessage(action.title);
}

export function startClient(context: vscode.ExtensionContext): LanguageClient | undefined {
	const root = currentQuilt();
	if (!root) {
		return undefined;
	}
	const s = settings();
	const serverOptions: ServerOptions = {
		run: { command: s.serverPath, args: ['--log', 'warning'], transport: TransportKind.stdio },
		debug: { command: s.serverPath, args: ['--log', 'debug'], transport: TransportKind.stdio }
	};
	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'latex' }, { scheme: 'file', language: 'tex' }, { scheme: 'file', pattern: '**/*.tex' }],
		initializationOptions: { loomPath: s.loomPath },
		outputChannel: output
	};
	const made = new LanguageClient('loom-lsp', 'loom language server', serverOptions, clientOptions);
	context.subscriptions.push({ dispose: () => void made.stop().catch(() => undefined) });
	made.start().catch((err) => {
		lastStartError = `${String(err)}\n${(err as Error)?.stack ?? ''}`;
		output?.appendLine(`the language server did not start (${s.serverPath}): ${lastStartError}`);
	});
	return made;
}

function updateStatus(): void {
	if (!status) {
		return;
	}
	const root = currentQuilt();
	const key = root ? keyUnderCursor() : undefined;
	if (!root || !key) {
		status.hide();
		return;
	}
	status.text = `$(book) ${key}`;
	status.tooltip = 'loom: the node under the cursor';
	status.command = 'loom.open';
	status.show();
}

export function activate(context: vscode.ExtensionContext): { client?: LanguageClient } {
	extensionContext = context;
	output = vscode.window.createOutputChannel('loom');
	context.subscriptions.push(output, diagnostics);

	status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	context.subscriptions.push(status);
	context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(updateStatus));
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatus));

	const register = (name: string, fn: (...args: unknown[]) => unknown) =>
		context.subscriptions.push(vscode.commands.registerCommand(name, fn));

	register('loom.status', () => runNamed('status'));
	register('loom.lint', () => runNamed('lint'));
	register('loom.new', async () => {
		const answer = await vscode.window.showInputBox({
			prompt: 'Taxon and title, e.g. "lemma Residue independence"',
			placeHolder: 'lemma A title'
		});
		if (answer) {
			await runNamed('new', answer);
		}
	});
	register('loom.accept', () => runNamed('accept', keyUnderCursor()));
	register('loom.bundle', () => runNamed('bundle', keyUnderCursor()));
	register('loom.serve', async () => {
		const root = currentQuilt();
		if (!root) {
			void vscode.window.showWarningMessage('loom: this workspace is not a quilt.');
			return;
		}
		const server = await ensureServer(root);
		if (server && !server.started) {
			void vscode.window.showInformationMessage(`loom serve is already running at ${server.url}`);
		}
	});
	register('loom.open', async (key?: unknown) => {
		const target = typeof key === 'string' && key ? key : keyUnderCursor();
		if (!target) {
			void vscode.window.showWarningMessage('loom: no key under the cursor.');
			return;
		}
		const root = currentQuilt();
		if (!root) {
			void vscode.window.showWarningMessage('loom: this workspace is not a quilt.');
			return;
		}
		const server = await ensureServer(root);
		if (server) {
			await hooks.openExternal(nodeUrl(server.url, target));
		}
	});
	register('loom.run', (argv: unknown, confirm: unknown) => runArgv(argv, confirm));
	register('loom.atomize', () =>
		applyCodeActionAt(
			vscode.CodeActionKind.RefactorExtract,
			'atomize',
			"A node with no id can be given one first with 'Loom: Give the node under the cursor an id'."
		)
	);
	register('loom.nodeId', () => applyCodeActionAt(vscode.CodeActionKind.RefactorRewrite, 'give an id to'));
	register('loom.restart', async () => {
		await stopClient();
		client = startClient(context);
	});
	register('loom.compileFromRoot', async () => {
		const root = currentQuilt();
		if (!root) {
			void vscode.window.showWarningMessage('loom: this workspace is not a quilt.');
			return;
		}
		await configureLatexWorkshop(root, true);
	});

	if (vscode.workspace.getConfiguration('loom').get<boolean>('autostart', true)) {
		client = startClient(context);
	}
	const root = currentQuilt();
	if (root) {
		void configureLatexWorkshop(root, false);
		// LaTeX Workshop installed or enabled during the session
		context.subscriptions.push(vscode.extensions.onDidChange(() => void configureLatexWorkshop(root, false)));
	}
	updateStatus();
	return { client };
}

/** Stop the client if there is one to stop. A client that never started throws from `stop`, which is not an error worth reporting. */
async function stopClient(): Promise<void> {
	if (!client) {
		return;
	}
	if (client.state !== State.Stopped) {
		try {
			await client.stop();
		} catch (err) {
			output?.appendLine(`the language client did not stop cleanly: ${String(err)}`);
		}
	}
	client = undefined;
}

export async function deactivate(): Promise<void> {
	stopServers();
	await stopClient();
}
