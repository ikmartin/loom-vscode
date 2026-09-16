// The extension inside a real VS Code: it activates in a quilt, registers its commands, and the client reaches running.

import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

const ID = 'ikmartin.loom-vscode';

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
			'loom.restart'
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
		const folder = vscode.workspace.workspaceFolders![0];
		const file = vscode.Uri.file(path.join(folder.uri.fsPath, 'nodes', 'sy-0003.tex'));
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
		assert.ok(doc.getText().includes('sy-0003'));
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
});
