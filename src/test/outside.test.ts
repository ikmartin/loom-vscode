// Outside a quilt the extension does nothing: no language client, and the quilt finder says so.

import * as assert from 'node:assert';
import * as vscode from 'vscode';

import { findQuilt } from '../quilt';

suite('outside a quilt', () => {
	test('the workspace is not one', () => {
		const folder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(folder, 'no workspace folder');
		assert.strictEqual(findQuilt(folder.uri.fsPath), undefined);
	});

	test('no language client is started', async function () {
		this.timeout(60000);
		const extension = vscode.extensions.getExtension('ikmartin.loom-vscode');
		if (extension && !extension.isActive) {
			await extension.activate(); // the palette entries exist everywhere; the client does not
		}
		const { currentClient } = (await import('../extension.js')) as { currentClient: () => unknown };
		assert.strictEqual(currentClient(), undefined);
	});

	test('the commands are registered but report that there is no quilt', async () => {
		const all = await vscode.commands.getCommands(true);
		assert.ok(all.includes('loom.status'));
		assert.ok(all.includes('loom.compileFromRoot'));
		await vscode.commands.executeCommand('loom.compileFromRoot');
	});

	test('atomize and the id command are registered and report there is no quilt', async () => {
		const all = await vscode.commands.getCommands(true);
		assert.ok(all.includes('loom.atomize'));
		assert.ok(all.includes('loom.nodeId'));
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(`${vscode.workspace.workspaceFolders![0].uri.fsPath}/paper.tex`));
		await vscode.window.showTextDocument(doc);
		await vscode.commands.executeCommand('loom.atomize');
		await vscode.commands.executeCommand('loom.nodeId');
	});
});
