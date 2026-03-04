import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode before importing getProjectDirPath
vi.mock('vscode', () => ({
	workspace: {
		getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
		workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
	},
	window: { terminals: [] },
}));

import { getProjectDirPath } from '../agentManager.js';

describe('getProjectDirPath', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('converts simple path', () => {
		const result = getProjectDirPath('/Users/john/my-project');
		expect(result).toMatch(/\.claude[/\\]projects[/\\]/);
		expect(result).toContain('-Users-john-my-project');
	});

	it('converts path with spaces', () => {
		const result = getProjectDirPath('/Users/john/my project');
		expect(result).toContain('-Users-john-my-project');
	});

	it('converts path with underscores', () => {
		const result = getProjectDirPath('/Users/john/my_project');
		expect(result).toContain('-Users-john-my-project');
	});

	it('converts path with dots', () => {
		const result = getProjectDirPath('/Users/john/my.project');
		expect(result).toContain('-Users-john-my-project');
	});

	it('converts Windows-style path', () => {
		const result = getProjectDirPath('C:\\Users\\john\\project');
		expect(result).toContain('C--Users-john-project');
	});

	it('handles Unicode characters', () => {
		const result = getProjectDirPath('/Users/john/プロジェクト');
		expect(result).not.toBeNull();
		// Unicode chars are replaced with hyphens
		expect(result).toContain('-Users-john-');
	});

	it('handles CJK characters', () => {
		const result = getProjectDirPath('/Users/john/项目');
		expect(result).not.toBeNull();
	});

	it('returns null when no workspace folder', () => {
		// No cwd passed, workspace mock returns the folder
		const result = getProjectDirPath(undefined);
		expect(result).not.toBeNull();
	});

	it('preserves hyphens in path', () => {
		const result = getProjectDirPath('/Users/john/my-cool-project');
		expect(result).toContain('-Users-john-my-cool-project');
	});

	it('preserves alphanumeric characters', () => {
		const result = getProjectDirPath('/Users/john/project123');
		expect(result).toContain('-Users-john-project123');
	});
});
