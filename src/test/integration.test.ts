// The extension inside a real VS Code: it activates in a quilt, registers its commands, and the client reaches running.

import * as assert from 'node:assert';
import * as http from 'node:http';
import * as path from 'node:path';
import * as vscode from 'vscode';

const ID = 'ikmartin.loom-vscode';

type Extension = typeof import('../extension.js');

/** Poll `probe` every 500 ms until it gives something truthy, or fail after `ms`. */
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + ms;
	let last: T | undefined;
	while (Date.now() < deadline) {
		try {
			last = await probe();
		} catch {
			last = undefined; // the server may still be scanning
		}
		if (last) {
			return last;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	assert.fail(`${what} did not happen within ${ms} ms`);
}

/** The status of one GET, or 0 when the connection fails. */
function statusOf(url: string): Promise<number> {
	return new Promise((resolve) => {
		http.get(url, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		}).on('error', () => resolve(0));
	});
}

suite('the extension in a quilt', () => {
	suiteSetup(async function () {
		this.timeout(120000);
		// the harness gives the extension host its own environment, so LOOM_LSP and LOOM_BIN name the executables rather than PATH
		const extension = vscode.extensions.getExtension(ID);
		assert.ok(extension, `${ID} is not installed in this host`);
		await extension.activate();
	});

	test('activates, because the workspace is a quilt', () => {
		assert.strictEqual(vscode.extensions.getExtension(ID)?.isActive, true);
	});

	test('registers every Loom command', async () => {
		const all = await vscode.commands.getCommands(true);
		for (const name of [
			'loom.status',
			'loom.lint',
			'loom.new',
			'loom.accept',
			'loom.serve',
			'loom.open',
			'loom.bundle',
			'loom.restart',
			'loom.run',
			'loom.compileFromRoot'
		]) {
			assert.ok(all.includes(name), `${name} was not registered`);
		}
	});

	test('finds the quilt this workspace is', async () => {
		const api = vscode.extensions.getExtension(ID)!.exports as { client?: unknown };
		const folder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(folder, 'no workspace folder');
		const { findQuilt } = await import('../quilt.js');
		assert.strictEqual(findQuilt(folder.uri.fsPath), folder.uri.fsPath);
		assert.ok('client' in api);
	});

	test('opens a node of the quilt and keeps the document intact', async () => {
		// LOOM_NODE names the file, so the same suite runs against a real paper's quilt as well as the fixture
		const name = process.env.LOOM_NODE ?? 'sy-0003.tex';
		const folder = vscode.workspace.workspaceFolders![0];
		const file = vscode.Uri.file(path.join(folder.uri.fsPath, 'nodes', name));
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
		assert.ok(doc.getText().includes(name.replace('.tex', '')), 'the node file does not name its own id');
	});

	test('the language client reaches running when the server is on the path', async function () {
		this.timeout(60000);
		if (!process.env.LOOM_LSP) {
			this.skip(); // the harness was not told where the server is
		}
		const { currentClient } = (await import('../extension.js')) as {
			currentClient: () => { state: number; onDidChangeState: (cb: (e: { newState: number }) => void) => void } | undefined;
		};
		const RUNNING = 2;
		for (let i = 0; i < 60; i++) {
			const c = currentClient();
			if (c && c.state === RUNNING) {
				return;
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		assert.fail(`the client never reached running (state ${currentClient()?.state ?? 'none'})`);
	});

	test('open in arras starts a server once, on a free port, and reuses it', async () => {
		const ext = (await import('../extension.js')) as Extension;
		const saved = { ...ext.hooks };
		const started: string[][] = [];
		const opened: string[] = [];
		const stubs: http.Server[] = [];
		ext.stopServers();
		ext.hooks.startServer = (argv) => {
			started.push(argv);
			const port = Number(argv[argv.indexOf('--port') + 1]);
			const stub = http.createServer((req, res) => {
				res.writeHead(req.url === '/build/manifest.json' ? 200 : 404);
				res.end('{}');
			});
			stub.listen(port, '127.0.0.1');
			stubs.push(stub);
			return { name: 'loom serve', exitStatus: undefined, dispose: () => stub.close() } as unknown as vscode.Terminal;
		};
		ext.hooks.openExternal = async (url) => {
			opened.push(url);
			return true;
		};
		try {
			await vscode.commands.executeCommand('loom.open', 'sy-0003');
			assert.strictEqual(started.length, 1);
			const port = started[0][started[0].indexOf('--port') + 1];
			assert.deepStrictEqual(opened, [`http://127.0.0.1:${port}/node/sy-0003`]);
			await vscode.commands.executeCommand('loom.open', 'sy-0003');
			assert.strictEqual(started.length, 1, 'a second open started another server');
			assert.strictEqual(opened.length, 2);
		} finally {
			ext.stopServers();
			stubs.forEach((stub) => stub.close());
			Object.assign(ext.hooks, saved);
		}
	});

	test('open in arras runs a real loom serve when loom is on the path', async function () {
		this.timeout(60000);
		if (!process.env.LOOM_BIN) {
			this.skip();
		}
		const ext = (await import('../extension.js')) as Extension;
		const saved = { ...ext.hooks };
		const opened: string[] = [];
		ext.stopServers();
		ext.hooks.openExternal = async (url) => {
			opened.push(url);
			return true;
		};
		try {
			await vscode.commands.executeCommand('loom.open', 'sy-0003');
			assert.strictEqual(opened.length, 1, 'nothing was opened');
			assert.match(opened[0], /\/node\/sy-0003$/);
			const manifest = opened[0].replace(/node\/sy-0003$/, 'build/manifest.json');
			assert.strictEqual(await statusOf(manifest), 200);
			ext.stopServers();
			await until('the server to stop', 10000, async () => (await statusOf(manifest)) === 0);
		} finally {
			ext.stopServers();
			Object.assign(ext.hooks, saved);
		}
	});

	suite('compiling with LaTeX Workshop', () => {
		let ext: Extension;
		let saved: Extension['hooks'];
		let root: string;
		let writes: Array<{ key: string; value: unknown; folder: string }>;
		let asked: string[][];
		let answer: string | undefined;

		setup(async () => {
			ext = (await import('../extension.js')) as Extension;
			saved = { ...ext.hooks };
			root = vscode.workspace.workspaceFolders![0].uri.fsPath;
			writes = [];
			asked = [];
			answer = 'Set it';
			ext.hooks.latexWorkshopVersion = () => '10.18.1';
			ext.hooks.writeLatexWorkshopSetting = async (key, value, folder) => {
				writes.push({ key, value, folder: folder.toString() });
			};
			ext.hooks.ask = async (_message, ...items) => {
				asked.push(items);
				return answer;
			};
			await ext.resetLatexWorkshopPrompt(root);
		});

		teardown(async () => {
			Object.assign(ext.hooks, saved);
			await ext.resetLatexWorkshopPrompt(root);
		});

		test('the command sets fromFolder to . for the workspace folder', async () => {
			await vscode.commands.executeCommand('loom.compileFromRoot');
			assert.deepStrictEqual(asked, [['Set it', 'Cancel']]);
			assert.deepStrictEqual(writes, [{ key: 'latex.build.fromFolder', value: '.', folder: vscode.workspace.workspaceFolders![0].uri.toString() }]);
		});

		test("the automatic offer stops after Don't ask again", async () => {
			answer = "Don't ask again";
			await ext.configureLatexWorkshop(root, false);
			assert.deepStrictEqual(asked, [['Set it', 'Not now', "Don't ask again"]]);
			await ext.configureLatexWorkshop(root, false);
			assert.strictEqual(asked.length, 1, 'it asked again');
			assert.deepStrictEqual(writes, []);
		});

		test('the command writes nothing without LaTeX Workshop', async () => {
			ext.hooks.latexWorkshopVersion = () => undefined;
			await vscode.commands.executeCommand('loom.compileFromRoot');
			assert.deepStrictEqual(asked, []);
			assert.deepStrictEqual(writes, []);
		});
	});

	suite('navigation from the server', () => {
		let doc: vscode.TextDocument;
		let label: vscode.Position;

		suiteSetup(async function () {
			this.timeout(60000);
			if (!process.env.LOOM_LSP) {
				this.skip();
			}
			const folder = vscode.workspace.workspaceFolders![0];
			doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(folder.uri.fsPath, 'nodes', 'sy-000B.tex')));
			await vscode.window.showTextDocument(doc);
			label = doc.positionAt(doc.getText().indexOf('\\label{sy-000B}') + '\\label{'.length + 2);
			const { currentClient } = (await import('../extension.js')) as Extension;
			await until('the client running', 30000, async () => currentClient()?.state === 2);
		});

		test('finds a node by its title in the workspace', async () => {
			const symbols = await until('a workspace symbol for widget', 30000, async () => {
				const got = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', 'widget');
				return got?.some((s) => s.name.startsWith('sy-0001')) ? got : undefined;
			});
			assert.ok(symbols.some((s) => s.name.startsWith('sy-0001')));
		});

		test('shows what a node uses in its call hierarchy', async () => {
			const items = await until('a call hierarchy item', 30000, async () => {
				const got = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', doc.uri, label);
				return got?.length ? got : undefined;
			});
			assert.strictEqual(items[0].name, 'sy-000B');
			const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', items[0]);
			assert.ok(
				outgoing.some((call) => call.to.name === 'sy-0003'),
				`outgoing: ${outgoing.map((call) => call.to.name).join(', ')}`
			);
		});

		test('gives inlay hints over the document', async () => {
			const whole = new vscode.Range(0, 0, doc.lineCount, 0);
			const hints = await until('an inlay hint', 30000, async () => {
				const got = await vscode.commands.executeCommand<vscode.InlayHint[]>('vscode.executeInlayHintProvider', doc.uri, whole);
				return got?.length ? got : undefined;
			});
			assert.ok(hints.length > 0);
		});
	});
});
