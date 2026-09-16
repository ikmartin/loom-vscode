// Making LaTeX Workshop compile a quilt from its root, where loom.sty, nodes/ and refs.bib are found. Nothing here touches the VS Code API, so the planning is testable on its own.

import * as path from 'node:path';

/** The first version with `latex-workshop.latex.build.fromFolder`. */
export const FROM_FOLDER_SINCE = '10.15.0';
/** The first version with the boolean `latex-workshop.latex.build.fromWorkspaceFolder`. */
export const FROM_WORKSPACE_FOLDER_SINCE = '10.12.0';

/** The workspaceState key that records "Don't ask again" for a quilt. */
export function dismissedKey(root: string): string {
	return `loom.latexWorkshop.dismissed:${root}`;
}

/** The `fromFolder` value naming `quiltRoot` from `workspaceFolder`: `.` when equal, a forward-slash relative path when inside, the absolute root when outside. */
export function fromFolderValue(workspaceFolder: string, quiltRoot: string): string {
	const rel = path.relative(path.resolve(workspaceFolder), path.resolve(quiltRoot));
	if (rel === '') {
		return '.';
	}
	if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
		return path.resolve(quiltRoot);
	}
	return rel.split(path.sep).join('/');
}

/** Compare dotted versions numerically: negative, zero or positive. A pre-release suffix is ignored. */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string) => v.split(/[-+]/)[0].split('.').map((p) => parseInt(p, 10) || 0);
	const x = parts(a);
	const y = parts(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) {
			return d;
		}
	}
	return 0;
}

export function atLeast(version: string, minimum: string): boolean {
	return compareVersions(version, minimum) >= 0;
}

export interface LatexWorkshopState {
	/** The installed LaTeX Workshop version, undefined when it is not installed. */
	version: string | undefined;
	/** The workspace folder containing the quilt root, if any. */
	workspaceFolder: string | undefined;
	quiltRoot: string;
	currentFromFolder: string | undefined;
	currentFromWorkspaceFolder: boolean | undefined;
}

export type LatexWorkshopPlan =
	| { kind: 'none'; reason: 'not installed' | 'already from root' }
	| { kind: 'fromFolder'; value: string }
	| { kind: 'fromWorkspaceFolder' }
	| { kind: 'unsupported'; message: string };

/** What to set so LaTeX Workshop compiles the quilt from its root, or why nothing is set. */
export function plan(state: LatexWorkshopState): LatexWorkshopPlan {
	const { version, workspaceFolder, quiltRoot } = state;
	if (!version) {
		return { kind: 'none', reason: 'not installed' };
	}
	if (!workspaceFolder) {
		return { kind: 'unsupported', message: 'LaTeX Workshop settings are per workspace folder; open the quilt root as a workspace folder to compile it from its root.' };
	}
	const root = path.resolve(quiltRoot);
	const atFolder = path.resolve(workspaceFolder) === root;
	if (atLeast(version, FROM_FOLDER_SINCE)) {
		if (state.currentFromFolder && path.resolve(workspaceFolder, state.currentFromFolder) === root) {
			return { kind: 'none', reason: 'already from root' };
		}
		return { kind: 'fromFolder', value: fromFolderValue(workspaceFolder, quiltRoot) };
	}
	const needed = `LaTeX Workshop ${version} compiles from the main file's folder, where loom.sty and nodes/ are not found; LaTeX Workshop ${FROM_FOLDER_SINCE} or later is needed to compile this quilt from its root.`;
	if (atLeast(version, FROM_WORKSPACE_FOLDER_SINCE) && atFolder) {
		return state.currentFromWorkspaceFolder === true ? { kind: 'none', reason: 'already from root' } : { kind: 'fromWorkspaceFolder' };
	}
	return { kind: 'unsupported', message: needed };
}
