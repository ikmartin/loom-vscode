// The builders, tested on their own: no editor, no loom process, no browser.

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { argvFor, arrasUrl, confirmationFor, Settings } from '../commands';
import { findQuilt, keyAt } from '../quilt';

const settings: Settings = { loomPath: '/opt/loom', serverPath: 'loom-lsp', servePort: 9000 };

suite('the command builders', () => {
	test('put the quilt root on every call', () => {
		for (const name of ['status', 'lint', 'accept', 'serve', 'bundle', 'deps']) {
			const argv = argvFor(name, '/tmp/q', settings, 'rl-0004')!;
			assert.strictEqual(argv[0], '/opt/loom');
			assert.strictEqual(argv[argv.length - 2], '--quilt');
			assert.strictEqual(argv[argv.length - 1], '/tmp/q');
		}
	});

	test('ask lint for json and serve for the configured port', () => {
		assert.deepStrictEqual(argvFor('lint', '/tmp/q', settings), ['/opt/loom', 'lint', '--json', '--quilt', '/tmp/q']);
		assert.deepStrictEqual(argvFor('serve', '/tmp/q', settings), [
			'/opt/loom',
			'serve',
			'--port',
			'9000',
			'--quilt',
			'/tmp/q'
		]);
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

	test('build the arras url on the configured port', () => {
		assert.strictEqual(arrasUrl(settings, 'rl-0004'), 'http://127.0.0.1:9000/node/rl-0004');
	});

	test('confirm only what writes', () => {
		assert.ok(confirmationFor('accept', 'rl-0004')?.includes('rl-0004'));
		assert.strictEqual(confirmationFor('status'), undefined);
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

	test('gives nothing when there is nothing to take', () => {
		assert.strictEqual(keyAt('plain prose with no commands', 4), undefined);
	});
});
