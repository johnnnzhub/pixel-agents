import * as path from 'path';
import type { AgentContext } from './types.js';
import {
	cancelWaitingTimer,
	startWaitingTimer,
	clearAgentActivity,
	startPermissionTimer,
	cancelPermissionTimer,
} from './timerManager.js';
import {
	TOOL_DONE_DELAY_MS,
	TEXT_IDLE_DELAY_MS,
	BASH_COMMAND_DISPLAY_MAX_LENGTH,
	TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
	SUBAGENT_TOOL_STALE_MS,
} from './constants.js';
import { log } from './logger.js';

export const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'Agent', 'AskUserQuestion']);

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
	const base = (p: unknown) => typeof p === 'string' ? path.basename(p) : '';
	switch (toolName) {
		case 'Read': return `Reading ${base(input.file_path)}`;
		case 'Edit': return `Editing ${base(input.file_path)}`;
		case 'Write': return `Writing ${base(input.file_path)}`;
		case 'Bash': {
			const cmd = (input.command as string) || '';
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
		}
		case 'Glob': return 'Searching files';
		case 'Grep': return 'Searching code';
		case 'WebFetch': return 'Fetching web content';
		case 'WebSearch': return 'Searching the web';
		case 'Task':
		case 'Agent': {
			const desc = typeof input.description === 'string' ? input.description : '';
			return desc ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}` : 'Running subtask';
		}
		case 'AskUserQuestion': return 'Waiting for your answer';
		case 'EnterPlanMode': return 'Planning';
		case 'NotebookEdit': return `Editing notebook`;
		default: return `Using ${toolName}`;
	}
}

export function processTranscriptLine(
	agentId: number,
	line: string,
	ctx: AgentContext,
): void {
	const agent = ctx.agents.get(agentId);
	if (!agent) {return;}
	try {
		const record = JSON.parse(line);

		if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
			const blocks = record.message.content as Array<{
				type: string; id?: string; name?: string; input?: Record<string, unknown>;
			}>;
			const hasToolUse = blocks.some(b => b.type === 'tool_use');

			if (hasToolUse) {
				// idle|thinking → tool_active
				cancelWaitingTimer(agentId, ctx);
				agent.isWaiting = false;
				agent.turnState = 'tool_active';
				ctx.webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
				let hasNonExemptTool = false;
				for (const block of blocks) {
					if (block.type === 'tool_use' && block.id) {
						const toolName = block.name || '';
						const status = formatToolStatus(toolName, block.input || {});
						log.info(`Agent ${agentId} tool start: ${block.id} ${status}`);
						agent.activeToolIds.add(block.id);
						agent.activeToolStatuses.set(block.id, status);
						agent.activeToolNames.set(block.id, toolName);
						if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
							hasNonExemptTool = true;
						}
						ctx.webview?.postMessage({
							type: 'agentToolStart',
							id: agentId,
							toolId: block.id,
							status,
						});
					}
				}
				if (hasNonExemptTool) {
					startPermissionTimer(agentId, PERMISSION_EXEMPT_TOOLS, ctx);
				}
			} else if (blocks.some(b => b.type === 'text')) {
				if (agent.turnState === 'idle') {
					// idle → text_cooldown (text-only turn, no tools yet)
					agent.turnState = 'text_cooldown';
					startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, ctx);
				}
				// In tool_active/tool_draining states, text blocks are ignored
				// (turn_duration will handle the turn-end)
			}
		} else if (record.type === 'progress') {
			processProgressRecord(agentId, record, ctx);
		} else if (record.type === 'user') {
			const content = record.message?.content;
			if (Array.isArray(content)) {
				const blocks = content as Array<{ type: string; tool_use_id?: string }>;
				const hasToolResult = blocks.some(b => b.type === 'tool_result');
				if (hasToolResult) {
					for (const block of blocks) {
						if (block.type === 'tool_result' && block.tool_use_id) {
							log.info(`Agent ${agentId} tool done: ${block.tool_use_id}`);
							const completedToolId = block.tool_use_id;
							// If the completed tool was a Task/Agent, clear its subagent tools
							const completedToolName = agent.activeToolNames.get(completedToolId);
							if (completedToolName === 'Task' || completedToolName === 'Agent') {
								agent.activeSubagentToolIds.delete(completedToolId);
								agent.activeSubagentToolNames.delete(completedToolId);
								agent.activeSubagentToolTimestamps.delete(completedToolId);
								ctx.webview?.postMessage({
									type: 'subagentClear',
									id: agentId,
									parentToolId: completedToolId,
								});
							}
							agent.activeToolIds.delete(completedToolId);
							agent.activeToolStatuses.delete(completedToolId);
							agent.activeToolNames.delete(completedToolId);
							const toolId = completedToolId;
							setTimeout(() => {
								ctx.webview?.postMessage({
									type: 'agentToolDone',
									id: agentId,
									toolId,
								});
							}, TOOL_DONE_DELAY_MS);
						}
					}
					// tool_active → tool_draining when all tools complete
					if (agent.activeToolIds.size === 0) {
						agent.turnState = 'tool_draining';
					}
				} else {
					// New user text prompt — new turn starting → idle
					cancelWaitingTimer(agentId, ctx);
					clearAgentActivity(agentId, ctx);
					agent.turnState = 'idle';
				}
			} else if (typeof content === 'string' && content.trim()) {
				// New user text prompt — new turn starting → idle
				cancelWaitingTimer(agentId, ctx);
				clearAgentActivity(agentId, ctx);
				agent.turnState = 'idle';
			}
		} else if (record.type === 'system' && record.subtype === 'turn_duration') {
			// Definitive turn-end: any state → idle
			cancelWaitingTimer(agentId, ctx);
			cancelPermissionTimer(agentId, ctx);

			// Clean up any stale tool state
			if (agent.activeToolIds.size > 0) {
				agent.activeToolIds.clear();
				agent.activeToolStatuses.clear();
				agent.activeToolNames.clear();
				agent.activeSubagentToolIds.clear();
				agent.activeSubagentToolNames.clear();
				agent.activeSubagentToolTimestamps.clear();
				ctx.webview?.postMessage({ type: 'agentToolsClear', id: agentId });
			}

			agent.isWaiting = true;
			agent.permissionSent = false;
			agent.turnState = 'idle';
			ctx.webview?.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	} catch (e) {
		log.warn('Malformed JSONL line:', e);
	}
}

function processProgressRecord(
	agentId: number,
	record: Record<string, unknown>,
	ctx: AgentContext,
): void {
	const agent = ctx.agents.get(agentId);
	if (!agent) {return;}

	const parentToolId = record.parentToolUseID as string | undefined;
	if (!parentToolId) {return;}

	const data = record.data as Record<string, unknown> | undefined;
	if (!data) {return;}

	// bash_progress / mcp_progress: tool is actively executing, not stuck on permission.
	// Restart the permission timer to give the running tool another window.
	const dataType = data.type as string | undefined;
	if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
		if (agent.activeToolIds.has(parentToolId)) {
			startPermissionTimer(agentId, PERMISSION_EXEMPT_TOOLS, ctx);
		}
		return;
	}

	// Verify parent is an active Task/Agent tool (agent_progress handling)
	const parentToolName = agent.activeToolNames.get(parentToolId);
	if (parentToolName !== 'Task' && parentToolName !== 'Agent') {return;}

	const msg = data.message as Record<string, unknown> | undefined;
	if (!msg) {return;}

	const msgType = msg.type as string;
	const innerMsg = msg.message as Record<string, unknown> | undefined;
	const content = innerMsg?.content;
	if (!Array.isArray(content)) {return;}

	if (msgType === 'assistant') {
		let hasNonExemptSubTool = false;
		for (const block of content) {
			if (block.type === 'tool_use' && block.id) {
				const toolName = block.name || '';
				const status = formatToolStatus(toolName, block.input || {});
				log.info(` Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`);

				// Track sub-tool IDs
				let subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (!subTools) {
					subTools = new Set();
					agent.activeSubagentToolIds.set(parentToolId, subTools);
				}
				subTools.add(block.id);

				// Track sub-tool names (for permission checking)
				let subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (!subNames) {
					subNames = new Map();
					agent.activeSubagentToolNames.set(parentToolId, subNames);
				}
				subNames.set(block.id, toolName);

				// Track sub-tool start timestamps (for stale cleanup)
				let subTimestamps = agent.activeSubagentToolTimestamps.get(parentToolId);
				if (!subTimestamps) {
					subTimestamps = new Map();
					agent.activeSubagentToolTimestamps.set(parentToolId, subTimestamps);
				}
				subTimestamps.set(block.id, Date.now());

				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					hasNonExemptSubTool = true;
				}

				ctx.webview?.postMessage({
					type: 'subagentToolStart',
					id: agentId,
					parentToolId,
					toolId: block.id,
					status,
				});
			}
		}
		if (hasNonExemptSubTool) {
			startPermissionTimer(agentId, PERMISSION_EXEMPT_TOOLS, ctx);
		}
	} else if (msgType === 'user') {
		for (const block of content) {
			if (block.type === 'tool_result' && block.tool_use_id) {
				log.info(` Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`);

				// Remove from tracking
				const subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (subTools) {
					subTools.delete(block.tool_use_id);
				}
				const subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (subNames) {
					subNames.delete(block.tool_use_id);
				}
				const subTimestamps = agent.activeSubagentToolTimestamps.get(parentToolId);
				if (subTimestamps) {
					subTimestamps.delete(block.tool_use_id);
				}

				const toolId = block.tool_use_id;
				setTimeout(() => {
					ctx.webview?.postMessage({
						type: 'subagentToolDone',
						id: agentId,
						parentToolId,
						toolId,
					});
				}, 300);
			}
		}
		// If there are still active non-exempt sub-agent tools, restart the permission timer
		// (handles the case where one sub-agent completes but another is still stuck)
		let stillHasNonExempt = false;
		for (const [, subNames] of agent.activeSubagentToolNames) {
			for (const [, toolName] of subNames) {
				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					stillHasNonExempt = true;
					break;
				}
			}
			if (stillHasNonExempt) {break;}
		}
		if (stillHasNonExempt) {
			startPermissionTimer(agentId, PERMISSION_EXEMPT_TOOLS, ctx);
		}
	}
}
