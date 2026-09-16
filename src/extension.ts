// The extension: a language client for loom-lsp, the Loom: command palette entries, and a status bar item.
// Per the plan it launches the browser rather than embedding a webview: arras is a web application, and a browser tab is what it wants to be.

import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, State, TransportKind } from 'vscode-languageclient/node';

import { argvFor, arrasUrl, confirmationFor, Settings } from './commands';
import { findQuilt, keyAt } from './quilt';

let client: LanguageClient | undefined;
/** Why the last start failed, for the output channel and for the tests. */
export let lastStartError: string | undefined;
let status: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;

export function settings(): Settings {
	const c = vscode.workspace.getConfiguration('loom');
	// LOOM_BIN and LOOM_LSP override the settings. The extension host does not inherit a shell's PATH, so a test harness, or anyone launching the editor from a virtual environment, needs a way to name the executables that does not write to the user's settings.
	return {
		loomPath: process.env.LOOM_BIN || c.get<string>('loomPath', 'loom'),
		serverPath: process.env.LOOM_LSP || c.get<string>('serverPath', 'loom-lsp'),
		servePort: c.get<number>('servePort', 8000)
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
	return keyAt(editor.document.getText(), editor.document.offsetAt(editor.selection.active));
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

/** Injected in tests so nothing opens and no terminal appears. */
export const hooks: {
	openExternal: (url: string) => Thenable<boolean>;
	openTerminal: (name: string, argv: string[], cwd: string) => void;
} = {
	openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
	openTerminal: (name, argv, cwd) => {
		const terminal = vscode.window.createTerminal({ name, cwd });
		terminal.sendText(argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '));
		terminal.show();
	}
};

/** The language client, for tests and for a status display. */
export function currentClient(): LanguageClient | undefined {
	return client;
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
		initializationOptions: { loomPath: s.loomPath, serveUrl: `http://127.0.0.1:${s.servePort}` },
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
	register('loom.serve', () => {
		const root = currentQuilt();
		if (!root) {
			void vscode.window.showWarningMessage('loom: this workspace is not a quilt.');
			return;
		}
		const argv = argvFor('serve', root, settings());
		if (argv) {
			hooks.openTerminal('loom serve', argv, root);
		}
	});
	register('loom.open', async () => {
		const key = keyUnderCursor();
		if (!key) {
			void vscode.window.showWarningMessage('loom: no key under the cursor.');
			return;
		}
		await hooks.openExternal(arrasUrl(settings(), key));
	});
	register('loom.restart', async () => {
		await stopClient();
		client = startClient(context);
	});

	if (vscode.workspace.getConfiguration('loom').get<boolean>('autostart', true)) {
		client = startClient(context);
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
	await stopClient();
}
