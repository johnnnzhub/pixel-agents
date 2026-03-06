import type { AgentContext, AgentState } from './types.js';
import { PERMISSION_TIMER_DELAY_MS, SUBAGENT_TOOL_STALE_MS } from './constants.js';
import { log } from './logger.js';

export function clearAgentActivity(
	agentId: number,
	ctx: AgentContext,
): void {
	const agent = ctx.agents.get(agentId);
	if (!agent) {return;}
	agent.activeToolIds.clear();
	agent.activeToolStatuses.clear();
	agent.activeToolNames.clear();
	agent.activeSubagentToolIds.clear();
	agent.activeSubagentToolNames.clear();
	agent.activeSubagentToolTimestamps.clear();
	agent.isWaiting = false;
	agent.permissionSent = false;
	agent.turnState = 'idle';
	cancelPermissionTimer(agentId, ctx);
	ctx.webview?.postMessage({ type: 'agentToolsClear', id: agentId });
	ctx.webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
}

export function cancelWaitingTimer(
	agentId: number,
	ctx: AgentContext,
): void {
	const timer = ctx.waitingTimers.get(agentId);
	if (timer) {
		clearTimeout(timer);
		ctx.waitingTimers.delete(agentId);
	}
}

export function startWaitingTimer(
	agentId: number,
	delayMs: number,
	ctx: AgentContext,
): void {
	cancelWaitingTimer(agentId, ctx);
	const timer = setTimeout(() => {
		ctx.waitingTimers.delete(agentId);
		const agent = ctx.agents.get(agentId);
		if (agent) {
			agent.isWaiting = true;
		}
		ctx.webview?.postMessage({
			type: 'agentStatus',
			id: agentId,
			status: 'waiting',
		});
	}, delayMs);
	ctx.waitingTimers.set(agentId, timer);
}

export function cancelPermissionTimer(
	agentId: number,
	ctx: AgentContext,
): void {
	const timer = ctx.permissionTimers.get(agentId);
	if (timer) {
		clearTimeout(timer);
		ctx.permissionTimers.delete(agentId);
	}
}

/**
 * Remove sub-agent tool entries that have been active longer than SUBAGENT_TOOL_STALE_MS.
 * Prevents zombie entries from accumulating when sub-agents crash without emitting tool_result.
 */
export function cleanupStaleSubagentTools(
	agentId: number,
	agent: AgentState,
	ctx: AgentContext,
): void {
	const now = Date.now();
	for (const [parentToolId, timestamps] of agent.activeSubagentToolTimestamps) {
		const staleIds: string[] = [];
		for (const [subToolId, startTime] of timestamps) {
			if (now - startTime > SUBAGENT_TOOL_STALE_MS) {
				staleIds.push(subToolId);
			}
		}
		if (staleIds.length === 0) {continue;}

		const subTools = agent.activeSubagentToolIds.get(parentToolId);
		const subNames = agent.activeSubagentToolNames.get(parentToolId);
		for (const subToolId of staleIds) {
			log.info(`Agent ${agentId}: cleaning stale sub-agent tool ${subToolId} (parent: ${parentToolId})`);
			subTools?.delete(subToolId);
			subNames?.delete(subToolId);
			timestamps.delete(subToolId);
			ctx.webview?.postMessage({
				type: 'subagentToolDone',
				id: agentId,
				parentToolId,
				toolId: subToolId,
			});
		}
		// Clean up empty parent entries
		if (timestamps.size === 0) {
			agent.activeSubagentToolTimestamps.delete(parentToolId);
		}
		if (subTools?.size === 0) {
			agent.activeSubagentToolIds.delete(parentToolId);
		}
		if (subNames?.size === 0) {
			agent.activeSubagentToolNames.delete(parentToolId);
		}
	}
}

export function startPermissionTimer(
	agentId: number,
	permissionExemptTools: Set<string>,
	ctx: AgentContext,
): void {
	cancelPermissionTimer(agentId, ctx);
	const timer = setTimeout(() => {
		ctx.permissionTimers.delete(agentId);
		const agent = ctx.agents.get(agentId);
		if (!agent) {return;}

		// Clean up stale sub-agent tools before checking permissions
		cleanupStaleSubagentTools(agentId, agent, ctx);

		// Only flag if there are still active non-exempt tools (parent or sub-agent)
		let hasNonExempt = false;
		for (const toolId of agent.activeToolIds) {
			const toolName = agent.activeToolNames.get(toolId);
			if (!permissionExemptTools.has(toolName || '')) {
				hasNonExempt = true;
				break;
			}
		}

		// Check sub-agent tools for non-exempt tools
		const stuckSubagentParentToolIds: string[] = [];
		for (const [parentToolId, subToolNames] of agent.activeSubagentToolNames) {
			for (const [, toolName] of subToolNames) {
				if (!permissionExemptTools.has(toolName)) {
					stuckSubagentParentToolIds.push(parentToolId);
					hasNonExempt = true;
					break;
				}
			}
		}

		if (hasNonExempt) {
			agent.permissionSent = true;
			log.info(`Agent ${agentId}: possible permission wait detected`);
			ctx.webview?.postMessage({
				type: 'agentToolPermission',
				id: agentId,
			});
			// Also notify stuck sub-agents
			for (const parentToolId of stuckSubagentParentToolIds) {
				ctx.webview?.postMessage({
					type: 'subagentToolPermission',
					id: agentId,
					parentToolId,
				});
			}
		}
	}, PERMISSION_TIMER_DELAY_MS);
	ctx.permissionTimers.set(agentId, timer);
}
