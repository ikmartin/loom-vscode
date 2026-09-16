import { defineConfig } from '@vscode/test-cli';

// Two runs: one inside a copy of loom's synthetic quilt, where everything is exercised, and one in a plain LaTeX folder, where the extension must do nothing.
// LOOM_LSP and LOOM_BIN name the executables; the extension host has its own environment and does not inherit the shell's PATH.
const env = { LOOM_LSP: process.env.LOOM_LSP ?? '', LOOM_BIN: process.env.LOOM_BIN ?? '' };

export default defineConfig([
	{
		label: 'in a quilt',
		files: ['out/test/unit.test.js', 'out/test/integration.test.js'],
		workspaceFolder: './fixtures/synthetic',
		mocha: { timeout: 120000 },
		env
	},
	{
		label: 'outside a quilt',
		files: 'out/test/outside.test.js',
		workspaceFolder: './fixtures/plain',
		mocha: { timeout: 120000 },
		env
	}
]);
