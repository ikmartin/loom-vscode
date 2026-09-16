// The builders, tested on their own: no editor, no loom process, no browser.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { argvFor, confirmationFor, nodeUrl, Settings } from '../commands';
import { atLeast, compareVersions, fromFolderValue, LatexWorkshopState, plan } from '../latexWorkshop';
import { findQuilt, keyAt } from '../quilt';
import { freePort, waitForManifest } from '../serve';

const settings: Settings = { loomPath: '/opt/loom', serverPath: 'loom-lsp' };

suite('the command builders', () => {
	test('put the quilt root on every call', () => {
		for (const name of ['status', 'lint', 'accept', 'serve', 'bundle', 'deps']) {
			const argv = argvFor(name, '/tmp/q', settings, 'rl-0004')!;
			assert.strictEqual(argv[0], '/opt/loom');
			assert.strictEqual(argv[argv.length - 2], '--quilt');
			assert.strictEqual(argv[argv.length - 1], '/tmp/q');
		}
	});

	test('ask lint for json and serve for the port given', () => {
		assert.deepStrictEqual(argvFor('lint', '/tmp/q', settings), ['/opt/loom', 'lint', '--json', '--quilt', '/tmp/q']);
		assert.deepStrictEqual(argvFor('serve', '/tmp/q', settings, '9000'), [
			'/opt/loom',
			'serve',
			'--port',
			'9000',
			'--quilt',
			'/tmp/q'
		]);
	});

	test('build no serve without a port', () => {
		assert.strictEqual(argvFor('serve', '/tmp/q', settings), undefined);
	});

	test('keep a title with spaces in one argument', () => {
		assert.deepStrictEqual(argvFor('new', '/tmp/q', settings, 'lemma A title with spaces'), [
			'/opt/loom',
			'new',
			'lemma',
			'A title with spaces',
			'--print',
			'--quilt',
			'/tmp/q'
		]);
	});

	test('refuse what they cannot build', () => {
		assert.strictEqual(argvFor('new', '/tmp/q', settings, 'lemma'), undefined);
		assert.strictEqual(argvFor('accept', '/tmp/q', settings), undefined);
		assert.strictEqual(argvFor('nonsense', '/tmp/q', settings), undefined);
	});

	test('build the arras url on a server, with or without a trailing slash', () => {
		assert.strictEqual(nodeUrl('http://127.0.0.1:9000/', 'rl-0004'), 'http://127.0.0.1:9000/node/rl-0004');
		assert.strictEqual(nodeUrl('http://127.0.0.1:9000', 'rl-0004'), 'http://127.0.0.1:9000/node/rl-0004');
	});

	test('confirm only what writes', () => {
		assert.ok(confirmationFor('accept', 'rl-0004')?.includes('rl-0004'));
		assert.strictEqual(confirmationFor('status'), undefined);
	});
});

suite('starting loom serve', () => {
	const listen = (server: net.Server, port = 0): Promise<number> =>
		new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
		});
	const close = (server: net.Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

	test('freePort gives a port that can be listened on', async () => {
		const port = await freePort();
		assert.ok(port > 0);
		const server = net.createServer();
		assert.strictEqual(await listen(server, port), port);
		await close(server);
	});

	test('waitForManifest is true once the manifest answers', async () => {
		const server = http.createServer((req, res) => {
			res.writeHead(req.url === '/build/manifest.json' ? 200 : 404);
			res.end('{}');
		});
		const port = await listen(server);
		try {
			assert.strictEqual(await waitForManifest(`http://127.0.0.1:${port}/`, 5000), true);
		} finally {
			await close(server);
		}
	});

	test('waitForManifest is false on timeout', async () => {
		const port = await freePort();
		const began = Date.now();
		assert.strictEqual(await waitForManifest(`http://127.0.0.1:${port}/`, 500), false);
		assert.ok(Date.now() - began < 3000);
	});

	test('waitForManifest is false promptly once the process is gone', async () => {
		const port = await freePort();
		const began = Date.now();
		assert.strictEqual(await waitForManifest(`http://127.0.0.1:${port}/`, 30000, () => false), false);
		assert.ok(Date.now() - began < 1000);
	});
});

suite('finding a quilt', () => {
	const made: string[] = [];
	const temp = () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-vscode-'));
		made.push(d);
		return d;
	};
	suiteTeardown(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

	test('accepts a directory whose config.toml declares a quilt', () => {
		const d = temp();
		fs.mkdirSync(path.join(d, 'nodes'));
		fs.writeFileSync(path.join(d, 'config.toml'), '[quilt]\nmain = "drafts/main.tex"\n');
		fs.writeFileSync(path.join(d, 'nodes', 'a.tex'), 'x');
		assert.strictEqual(findQuilt(path.join(d, 'nodes', 'a.tex')), d);
	});

	test('rejects a bare directory of tex files and a config.toml that is not a quilt', () => {
		const bare = temp();
		fs.writeFileSync(path.join(bare, 'paper.tex'), '\\documentclass{article}');
		assert.strictEqual(findQuilt(path.join(bare, 'paper.tex')), undefined);

		const other = temp();
		fs.writeFileSync(path.join(other, 'config.toml'), '[tool.black]\nline-length = 88\n');
		fs.writeFileSync(path.join(other, 'paper.tex'), 'x');
		assert.strictEqual(findQuilt(path.join(other, 'paper.tex')), undefined);
	});
});

suite('the key under the cursor', () => {
	test('takes the argument of the command it sits in', () => {
		const text = 'By Lemma~\\ref{rl-0011} we are done.';
		assert.strictEqual(keyAt(text, text.indexOf('rl-0011') + 2), 'rl-0011');
	});

	test('takes the first item of a list', () => {
		const text = '\\uses{rl-0011, rl-0012}';
		assert.strictEqual(keyAt(text, 8), 'rl-0011');
	});

	test('falls back to the last label above it', () => {
		const text = '\\begin{lemma}\\label{rl-0004}\nSome text.\n\\end{lemma}\n';
		assert.strictEqual(keyAt(text, text.indexOf('Some text') + 3), 'rl-0004');
	});

	test('takes the first node of the file an \\input names, not its path', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-key-'));
		fs.mkdirSync(path.join(root, 'nodes'));
		fs.writeFileSync(path.join(root, 'nodes', 'rl-0008.tex'), '% a comment\n\\begin{example}\\label{rl-0008}\nText.\n\\end{example}\n');
		const text = '\\section{Examples}\\label{rl-0100}\n\\input{nodes/rl-0008}\n\\nest{nodes/rl-0008.tex}\n';
		assert.strictEqual(keyAt(text, text.indexOf('\\input') + 3, root), 'rl-0008');
		assert.strictEqual(keyAt(text, text.indexOf('\\nest') + 8, root), 'rl-0008');
	});

	test('falls back to the label above for an \\input of a file with no node', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-key-'));
		fs.writeFileSync(path.join(root, 'intro.tex'), 'Prose only.\n');
		const text = '\\section{Intro}\\label{rl-0100}\n\\input{intro}\n';
		assert.strictEqual(keyAt(text, text.indexOf('\\input') + 2, root), 'rl-0100');
		assert.strictEqual(keyAt(text, text.indexOf('\\input') + 2), 'rl-0100');
	});

	test('never takes the argument of a command that names no key', () => {
		const text = '\\begin{lemma}\\label{rl-0004}\nA \\emph{widget} is \\textbf{fine}.\n';
		assert.strictEqual(keyAt(text, text.indexOf('widget') + 1), 'rl-0004');
		assert.strictEqual(keyAt('\\section{Setup}', 10), undefined);
	});

	test('takes a reference with an optional argument and a star', () => {
		const text = 'see \\cref*[x]{rl-0011}';
		assert.strictEqual(keyAt(text, text.indexOf('rl-0011') + 1), 'rl-0011');
	});

	test('gives nothing when there is nothing to take', () => {
		assert.strictEqual(keyAt('plain prose with no commands', 4), undefined);
	});
});

suite('compiling with LaTeX Workshop', () => {
	const folder = path.resolve('/work/space');
	const state = (over: Partial<LatexWorkshopState>): LatexWorkshopState => ({
		version: '10.18.1',
		workspaceFolder: folder,
		quiltRoot: folder,
		currentFromFolder: undefined,
		currentFromWorkspaceFolder: undefined,
		...over
	});

	test('names the quilt root from the workspace folder', () => {
		assert.strictEqual(fromFolderValue(folder, folder), '.');
		assert.strictEqual(fromFolderValue(folder, path.join(folder, 'papers', 'q')), 'papers/q');
		const outside = path.resolve('/elsewhere/q');
		assert.strictEqual(fromFolderValue(folder, outside), outside);
		assert.strictEqual(fromFolderValue(folder, path.resolve('/work/spaced')), path.resolve('/work/spaced'));
	});

	test('compares versions numerically', () => {
		assert.ok(compareVersions('10.15.0', '10.9.9') > 0);
		assert.ok(compareVersions('10.14.2', '10.15.0') < 0);
		assert.strictEqual(compareVersions('10.15', '10.15.0'), 0);
		assert.ok(atLeast('10.18.1', '10.15.0'));
		assert.ok(atLeast('10.15.0', '10.15.0'));
		assert.ok(!atLeast('10.12.3', '10.15.0'));
	});

	test('does nothing when LaTeX Workshop is not installed', () => {
		assert.deepStrictEqual(plan(state({ version: undefined })), { kind: 'none', reason: 'not installed' });
	});

	test('sets fromFolder on a recent version', () => {
		assert.deepStrictEqual(plan(state({})), { kind: 'fromFolder', value: '.' });
		assert.deepStrictEqual(plan(state({ quiltRoot: path.join(folder, 'sub', 'q') })), { kind: 'fromFolder', value: 'sub/q' });
		assert.deepStrictEqual(plan(state({ currentFromFolder: 'drafts' })), { kind: 'fromFolder', value: '.' });
	});

	test('does nothing when fromFolder already names the root', () => {
		for (const current of ['.', './', folder]) {
			assert.strictEqual(plan(state({ currentFromFolder: current })).kind, 'none', current);
		}
		assert.strictEqual(plan(state({ quiltRoot: path.join(folder, 'sub', 'q'), currentFromFolder: 'sub/q' })).kind, 'none');
	});

	test('sets fromWorkspaceFolder on 10.12 to 10.14 when the quilt is the folder', () => {
		assert.deepStrictEqual(plan(state({ version: '10.13.0' })), { kind: 'fromWorkspaceFolder' });
		assert.strictEqual(plan(state({ version: '10.13.0', currentFromWorkspaceFolder: true })).kind, 'none');
	});

	test('needs 10.15.0 for a nested quilt, and 10.12.0 for any', () => {
		for (const s of [state({ version: '10.13.0', quiltRoot: path.join(folder, 'sub', 'q') }), state({ version: '10.11.0' })]) {
			const got = plan(s);
			assert.strictEqual(got.kind, 'unsupported');
			assert.match((got as { message: string }).message, /10\.15\.0 or later/);
		}
	});
});
