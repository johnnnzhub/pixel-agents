import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentState, AgentContext } from '../types.js';
import { processTranscriptLine, formatToolStatus } from '../transcriptParser.js';

function makeAgent(overrides?: Partial<AgentState>): AgentState {
	return {
		id: 1,
		terminalRef: {} as AgentState['terminalRef'],
		projectDir: '/test',
		jsonlFile: '/test/session.jsonl',
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		activeSubagentToolTimestamps: new Map(),
		isWaiting: false,
		permissionSent: false,
		turnState: 'idle',
		...overrides,
	};
}

function makeCtx(agent: AgentState): AgentContext {
	const agents = new Map<number, AgentState>();
	agents.set(agent.id, agent);
	return {
		agents,
		nextAgentIdRef: { current: 2 },
		activeAgentIdRef: { current: null },
		knownJsonlFiles: new Set(),
		adoptableFiles: new Set(),
		fileWatchers: new Map(),
		waitingTimers: new Map(),
		permissionTimers: new Map(),
		jsonlPollTimers: new Map(),
		projectScanTimerRef: { current: null },
		webview: { postMessage: vi.fn() } as unknown as AgentContext['webview'],
		persistAgents: vi.fn(),
	};
}

describe('formatToolStatus', () => {
	it('formats Read tool', () => {
		expect(formatToolStatus('Read', { file_path: '/a/b/c.ts' })).toBe('Reading c.ts');
	});

	it('formats Edit tool', () => {
		expect(formatToolStatus('Edit', { file_path: '/src/index.ts' })).toBe('Editing index.ts');
	});

	it('formats Bash with truncation', () => {
		const longCmd = 'npm run build && npm run test && npm run lint';
		const result = formatToolStatus('Bash', { command: longCmd });
		expect(result.length).toBeLessThanOrEqual(40);
		expect(result).toContain('…');
	});

	it('formats Bash short command', () => {
		expect(formatToolStatus('Bash', { command: 'ls' })).toBe('Running: ls');
	});

	it('formats Glob', () => {
		expect(formatToolStatus('Glob', {})).toBe('Searching files');
	});

	it('formats Task with description', () => {
		expect(formatToolStatus('Task', { description: 'Fix bug' })).toBe('Subtask: Fix bug');
	});

	it('formats unknown tool', () => {
		expect(formatToolStatus('CustomTool', {})).toBe('Using CustomTool');
	});
});

describe('processTranscriptLine', () => {
	let agent: AgentState;
	let ctx: AgentContext;

	beforeEach(() => {
		vi.useFakeTimers();
		agent = makeAgent();
		ctx = makeCtx(agent);
	});

	it('handles tool_use in assistant message', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: {
				content: [
					{ type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/test.ts' } },
				],
			},
		});

		processTranscriptLine(1, line, ctx);

		expect(agent.activeToolIds.has('tool_1')).toBe(true);
		expect(agent.activeToolNames.get('tool_1')).toBe('Read');
		expect(agent.turnState).toBe('tool_active');
		expect(ctx.webview!.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'agentToolStart', id: 1, toolId: 'tool_1' }),
		);
	});

	it('handles tool_result in user message', () => {
		// Setup: tool is active
		agent.activeToolIds.add('tool_1');
		agent.activeToolStatuses.set('tool_1', 'Reading test.ts');
		agent.activeToolNames.set('tool_1', 'Read');
		agent.turnState = 'tool_active';

		const line = JSON.stringify({
			type: 'user',
			message: {
				content: [
					{ type: 'tool_result', tool_use_id: 'tool_1' },
				],
			},
		});

		processTranscriptLine(1, line, ctx);

		expect(agent.activeToolIds.has('tool_1')).toBe(false);
		expect(agent.turnState).toBe('tool_draining');

		// agentToolDone is delayed
		vi.advanceTimersByTime(400);
		expect(ctx.webview!.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'agentToolDone', id: 1, toolId: 'tool_1' }),
		);
	});

	it('handles turn_duration (turn end)', () => {
		agent.turnState = 'tool_active';
		agent.activeToolIds.add('tool_1');
		agent.activeToolStatuses.set('tool_1', 'test');
		agent.activeToolNames.set('tool_1', 'Read');

		const line = JSON.stringify({
			type: 'system',
			subtype: 'turn_duration',
		});

		processTranscriptLine(1, line, ctx);

		expect(agent.turnState).toBe('idle');
		expect(agent.isWaiting).toBe(true);
		expect(agent.activeToolIds.size).toBe(0);
		expect(ctx.webview!.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'agentStatus', status: 'waiting' }),
		);
	});

	it('handles text-only assistant message (idle → text_cooldown)', () => {
		const line = JSON.stringify({
			type: 'assistant',
			message: {
				content: [{ type: 'text', text: 'Hello!' }],
			},
		});

		processTranscriptLine(1, line, ctx);

		expect(agent.turnState).toBe('text_cooldown');
	});

	it('does not start text_cooldown when in tool_active state', () => {
		agent.turnState = 'tool_active';

		const line = JSON.stringify({
			type: 'assistant',
			message: {
				content: [{ type: 'text', text: 'Working...' }],
			},
		});

		processTranscriptLine(1, line, ctx);

		expect(agent.turnState).toBe('tool_active');
	});

	it('handles user text prompt (resets to idle)', () => {
		agent.turnState = 'tool_active';

		const line = JSON.stringify({
			type: 'user',
			message: { content: 'new question' },
		});

		processTranscriptLine(1, line, ctx);

		expect(agent.turnState).toBe('idle');
	});

	it('handles malformed JSONL gracefully', () => {
		// Should not throw
		processTranscriptLine(1, 'not json at all', ctx);
		processTranscriptLine(1, '{}', ctx);
		processTranscriptLine(1, '{"type": "unknown"}', ctx);
	});

	it('handles Task tool completion with subagent cleanup', () => {
		agent.activeToolIds.add('task_1');
		agent.activeToolNames.set('task_1', 'Task');
		agent.activeToolStatuses.set('task_1', 'Running subtask');
		agent.activeSubagentToolIds.set('task_1', new Set(['sub_1']));
		agent.activeSubagentToolNames.set('task_1', new Map([['sub_1', 'Read']]));
		agent.turnState = 'tool_active';

		const line = JSON.stringify({
			type: 'user',
			message: {
				content: [{ type: 'tool_result', tool_use_id: 'task_1' }],
			},
		});

		processTranscriptLine(1, line, ctx);

		expect(agent.activeSubagentToolIds.has('task_1')).toBe(false);
		expect(agent.activeSubagentToolNames.has('task_1')).toBe(false);
		expect(ctx.webview!.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'subagentClear', parentToolId: 'task_1' }),
		);
	});
});
