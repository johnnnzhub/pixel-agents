import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentState, AgentContext } from '../types.js';
import {
	clearAgentActivity,
	cancelWaitingTimer,
	startWaitingTimer,
	cancelPermissionTimer,
	startPermissionTimer,
} from '../timerManager.js';

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

describe('timerManager', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('clearAgentActivity', () => {
		it('clears all agent state', () => {
			const agent = makeAgent({
				activeToolIds: new Set(['t1']),
				activeToolStatuses: new Map([['t1', 'test']]),
				activeToolNames: new Map([['t1', 'Read']]),
				isWaiting: true,
				permissionSent: true,
				turnState: 'tool_active',
			});
			const ctx = makeCtx(agent);

			clearAgentActivity(1, ctx);

			expect(agent.activeToolIds.size).toBe(0);
			expect(agent.activeToolStatuses.size).toBe(0);
			expect(agent.activeToolNames.size).toBe(0);
			expect(agent.isWaiting).toBe(false);
			expect(agent.permissionSent).toBe(false);
			expect(agent.turnState).toBe('idle');
			expect(ctx.webview!.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'agentToolsClear' }),
			);
		});

		it('does nothing for non-existent agent', () => {
			const agent = makeAgent();
			const ctx = makeCtx(agent);

			// Call with wrong id
			clearAgentActivity(99, ctx);
			expect(ctx.webview!.postMessage).not.toHaveBeenCalled();
		});
	});

	describe('startWaitingTimer / cancelWaitingTimer', () => {
		it('sets isWaiting after delay', () => {
			const agent = makeAgent();
			const ctx = makeCtx(agent);

			startWaitingTimer(1, 5000, ctx);
			expect(agent.isWaiting).toBe(false);

			vi.advanceTimersByTime(5000);
			expect(agent.isWaiting).toBe(true);
			expect(ctx.webview!.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'agentStatus', status: 'waiting' }),
			);
		});

		it('cancels before firing', () => {
			const agent = makeAgent();
			const ctx = makeCtx(agent);

			startWaitingTimer(1, 5000, ctx);
			cancelWaitingTimer(1, ctx);

			vi.advanceTimersByTime(5000);
			expect(agent.isWaiting).toBe(false);
		});

		it('replaces existing timer', () => {
			const agent = makeAgent();
			const ctx = makeCtx(agent);

			startWaitingTimer(1, 5000, ctx);
			startWaitingTimer(1, 10000, ctx);

			vi.advanceTimersByTime(5000);
			expect(agent.isWaiting).toBe(false);

			vi.advanceTimersByTime(5000);
			expect(agent.isWaiting).toBe(true);
		});
	});

	describe('startPermissionTimer / cancelPermissionTimer', () => {
		it('sets permissionSent for non-exempt tools', () => {
			const agent = makeAgent({
				activeToolIds: new Set(['t1']),
				activeToolNames: new Map([['t1', 'Read']]),
			});
			const ctx = makeCtx(agent);
			const exemptTools = new Set(['Task', 'AskUserQuestion']);

			startPermissionTimer(1, exemptTools, ctx);

			vi.advanceTimersByTime(7000);
			expect(agent.permissionSent).toBe(true);
			expect(ctx.webview!.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'agentToolPermission', id: 1 }),
			);
		});

		it('does not flag exempt-only tools', () => {
			const agent = makeAgent({
				activeToolIds: new Set(['t1']),
				activeToolNames: new Map([['t1', 'Task']]),
			});
			const ctx = makeCtx(agent);
			const exemptTools = new Set(['Task', 'AskUserQuestion']);

			startPermissionTimer(1, exemptTools, ctx);

			vi.advanceTimersByTime(7000);
			expect(agent.permissionSent).toBe(false);
		});

		it('cancels permission timer', () => {
			const agent = makeAgent({
				activeToolIds: new Set(['t1']),
				activeToolNames: new Map([['t1', 'Read']]),
			});
			const ctx = makeCtx(agent);
			const exemptTools = new Set(['Task']);

			startPermissionTimer(1, exemptTools, ctx);
			cancelPermissionTimer(1, ctx);

			vi.advanceTimersByTime(7000);
			expect(agent.permissionSent).toBe(false);
		});

		it('detects stuck sub-agent tools', () => {
			const agent = makeAgent({
				activeToolIds: new Set(['task_1']),
				activeToolNames: new Map([['task_1', 'Task']]),
				activeSubagentToolNames: new Map([
					['task_1', new Map([['sub_1', 'Bash']])],
				]),
			});
			const ctx = makeCtx(agent);
			const exemptTools = new Set(['Task', 'AskUserQuestion']);

			startPermissionTimer(1, exemptTools, ctx);

			vi.advanceTimersByTime(7000);
			expect(agent.permissionSent).toBe(true);
			expect(ctx.webview!.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'subagentToolPermission', parentToolId: 'task_1' }),
			);
		});
	});
});
