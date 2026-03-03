import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentState, AgentContext } from './types.js';
import {
	launchNewTerminal,
	removeAgent,
	restoreAgents,
	persistAgents,
	sendExistingAgents,
	sendLayout,
	getProjectDirPath,
	startAttachedStaleCheck,
} from './agentManager.js';
import { ensureProjectScan, adoptExistingSessions, adoptTerminalForFile } from './fileWatcher.js';
import { loadFurnitureAssets, sendAssetsToWebview, loadFloorTiles, sendFloorTilesToWebview, loadWallTiles, sendWallTilesToWebview, loadCharacterSprites, sendCharacterSpritesToWebview, loadDefaultLayout } from './assetLoader.js';
import { WORKSPACE_KEY_AGENT_SEATS, GLOBAL_KEY_SOUND_ENABLED } from './constants.js';
import { writeLayoutToFile, readLayoutFromFile, watchLayoutFile } from './layoutPersistence.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import { log } from './logger.js';

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
	private nextTerminalIndex = { current: 1 };
	private webviewView: vscode.WebviewView | undefined;

	// Bundled default layout (loaded from assets/default-layout.json)
	private defaultLayout: Record<string, unknown> | null = null;

	// Cross-window layout sync
	private layoutWatcher: LayoutWatcher | null = null;

	// Stale attached agent cleanup timer
	private attachedStaleTimer: ReturnType<typeof setInterval> | null = null;

	// Unified agent context — passed to all helper functions
	private ctx: AgentContext = {
		agents: new Map<number, AgentState>(),
		nextAgentIdRef: { current: 1 },
		activeAgentIdRef: { current: null },
		knownJsonlFiles: new Set<string>(),
		adoptableFiles: new Set<string>(),
		fileWatchers: new Map<number, fs.FSWatcher>(),
		waitingTimers: new Map<number, ReturnType<typeof setTimeout>>(),
		permissionTimers: new Map<number, ReturnType<typeof setTimeout>>(),
		jsonlPollTimers: new Map<number, ReturnType<typeof setInterval>>(),
		projectScanTimerRef: { current: null },
		webview: undefined,
		persistAgents: () => {
			persistAgents(this.ctx.agents, this.context);
		},
	};

	constructor(private readonly context: vscode.ExtensionContext) {}

	private get extensionUri(): vscode.Uri {
		return this.context.extensionUri;
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.webviewView = webviewView;
		this.ctx.webview = webviewView.webview;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

		webviewView.webview.onDidReceiveMessage(async (message) => {
			if (message.type === 'openClaude') {
				await launchNewTerminal(
					this.nextTerminalIndex, this.ctx,
					message.folderPath as string | undefined,
				);
			} else if (message.type === 'focusAgent') {
				const agent = this.ctx.agents.get(message.id);
				if (agent?.terminalRef) {
					agent.terminalRef.show();
				}
			} else if (message.type === 'closeAgent') {
				const agent = this.ctx.agents.get(message.id);
				if (agent) {
					if (agent.isAttached) {
						// Attached agents have no terminal — just remove
						removeAgent(message.id as number, this.ctx);
						webviewView.webview.postMessage({ type: 'agentClosed', id: message.id });
					} else if (agent.terminalRef) {
						agent.terminalRef.dispose();
					}
				}
			} else if (message.type === 'saveAgentSeats') {
				// Store seat assignments in a separate key (never touched by persistAgents)
				log.info('saveAgentSeats:', JSON.stringify(message.seats));
				this.context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, message.seats);
			} else if (message.type === 'saveLayout') {
				this.layoutWatcher?.markOwnWrite();
				writeLayoutToFile(message.layout as Record<string, unknown>);
			} else if (message.type === 'setSoundEnabled') {
				this.context.globalState.update(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
			} else if (message.type === 'webviewReady') {
				restoreAgents(this.context, this.nextTerminalIndex, this.ctx);
				// Send persisted settings to webview
				const soundEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
				this.ctx.webview?.postMessage({ type: 'settingsLoaded', soundEnabled });

				// Send workspace folders to webview (only when multi-root)
				const wsFolders = vscode.workspace.workspaceFolders;
				if (wsFolders && wsFolders.length > 1) {
					this.ctx.webview?.postMessage({
						type: 'workspaceFolders',
						folders: wsFolders.map(f => ({ name: f.name, path: f.uri.fsPath })),
					});
				}

				// Adopt already-running sessions before seeding knownJsonlFiles
				const projectDir = getProjectDirPath();
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				log.debug(' workspaceRoot:', workspaceRoot);
				log.debug(' projectDir:', projectDir);
				if (projectDir) {
					adoptExistingSessions(projectDir, this.ctx);
					ensureProjectScan(projectDir, this.ctx);

					// Start stale check for attached (headless) agents
					if (!this.attachedStaleTimer) {
						this.attachedStaleTimer = startAttachedStaleCheck(this.ctx);
					}

					// Load furniture assets BEFORE sending layout
					(async () => {
						try {
							log.debug(' Loading furniture assets...');
							const extensionPath = this.extensionUri.fsPath;
							log.debug(' extensionPath:', extensionPath);

							// Check bundled location first: extensionPath/dist/assets/
							const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
							let assetsRoot: string | null = null;
							if (fs.existsSync(bundledAssetsDir)) {
								log.debug(' Found bundled assets at dist/');
								assetsRoot = path.join(extensionPath, 'dist');
							} else if (workspaceRoot) {
								// Fall back to workspace root (development or external assets)
								log.debug(' Trying workspace for assets...');
								assetsRoot = workspaceRoot;
							}

							if (!assetsRoot) {
								log.debug(' ⚠️  No assets directory found');
								if (this.ctx.webview) {
									sendLayout(this.context, this.ctx.webview, this.defaultLayout);
									this.startLayoutWatcher();
								}
								return;
							}

							log.debug(' Using assetsRoot:', assetsRoot);

							// Load bundled default layout
							this.defaultLayout = loadDefaultLayout(assetsRoot);

							// Load character sprites
							const charSprites = await loadCharacterSprites(assetsRoot);
							if (charSprites && this.ctx.webview) {
								log.debug(' Character sprites loaded, sending to webview');
								sendCharacterSpritesToWebview(this.ctx.webview, charSprites);
							}

							// Load floor tiles
							const floorTiles = await loadFloorTiles(assetsRoot);
							if (floorTiles && this.ctx.webview) {
								log.debug(' Floor tiles loaded, sending to webview');
								sendFloorTilesToWebview(this.ctx.webview, floorTiles);
							}

							// Load wall tiles
							const wallTiles = await loadWallTiles(assetsRoot);
							if (wallTiles && this.ctx.webview) {
								log.debug(' Wall tiles loaded, sending to webview');
								sendWallTilesToWebview(this.ctx.webview, wallTiles);
							}

							const assets = await loadFurnitureAssets(assetsRoot);
							if (assets && this.ctx.webview) {
								log.debug(' ✅ Assets loaded, sending to webview');
								sendAssetsToWebview(this.ctx.webview, assets);
							}
						} catch (err) {
							log.error(' ❌ Error loading assets:', err);
						}
						// Always send saved layout (or null for default)
						if (this.ctx.webview) {
							log.debug(' Sending saved layout');
							sendLayout(this.context, this.ctx.webview, this.defaultLayout);
							this.startLayoutWatcher();
						}
					})();
				} else {
					// No project dir — still try to load floor/wall tiles, then send saved layout
					(async () => {
						try {
							const ep = this.extensionUri.fsPath;
							const bundled = path.join(ep, 'dist', 'assets');
							if (fs.existsSync(bundled)) {
								const distRoot = path.join(ep, 'dist');
								this.defaultLayout = loadDefaultLayout(distRoot);
								const cs = await loadCharacterSprites(distRoot);
								if (cs && this.ctx.webview) {
									sendCharacterSpritesToWebview(this.ctx.webview, cs);
								}
								const ft = await loadFloorTiles(distRoot);
								if (ft && this.ctx.webview) {
									sendFloorTilesToWebview(this.ctx.webview, ft);
								}
								const wt = await loadWallTiles(distRoot);
								if (wt && this.ctx.webview) {
									sendWallTilesToWebview(this.ctx.webview, wt);
								}
							}
						} catch { /* ignore */ }
						if (this.ctx.webview) {
							sendLayout(this.context, this.ctx.webview, this.defaultLayout);
							this.startLayoutWatcher();
						}
					})();
				}
				sendExistingAgents(this.ctx.agents, this.context, this.ctx.webview);
			} else if (message.type === 'openSessionsFolder') {
				const projectDir = getProjectDirPath();
				if (projectDir && fs.existsSync(projectDir)) {
					vscode.env.openExternal(vscode.Uri.file(projectDir));
				}
			} else if (message.type === 'exportLayout') {
				const layout = readLayoutFromFile();
				if (!layout) {
					vscode.window.showWarningMessage('Pixel Agents: No saved layout to export.');
					return;
				}
				const uri = await vscode.window.showSaveDialog({
					filters: { 'JSON Files': ['json'] },
					defaultUri: vscode.Uri.file(path.join(os.homedir(), 'pixel-agents-layout.json')),
				});
				if (uri) {
					fs.writeFileSync(uri.fsPath, JSON.stringify(layout, null, 2), 'utf-8');
					vscode.window.showInformationMessage('Pixel Agents: Layout exported successfully.');
				}
			} else if (message.type === 'importLayout') {
				const uris = await vscode.window.showOpenDialog({
					filters: { 'JSON Files': ['json'] },
					canSelectMany: false,
				});
				if (!uris || uris.length === 0) {return;}
				try {
					const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
					const imported = JSON.parse(raw) as Record<string, unknown>;
					if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
						vscode.window.showErrorMessage('Pixel Agents: Invalid layout file.');
						return;
					}
					this.layoutWatcher?.markOwnWrite();
					writeLayoutToFile(imported);
					this.ctx.webview?.postMessage({ type: 'layoutLoaded', layout: imported });
					vscode.window.showInformationMessage('Pixel Agents: Layout imported successfully.');
				} catch {
					vscode.window.showErrorMessage('Pixel Agents: Failed to read or parse layout file.');
				}
			}
		});

		vscode.window.onDidChangeActiveTerminal((terminal) => {
			this.ctx.activeAgentIdRef.current = null;
			if (!terminal) {return;}
			for (const [id, agent] of this.ctx.agents) {
				if (agent.terminalRef && agent.terminalRef === terminal) {
					this.ctx.activeAgentIdRef.current = id;
					webviewView.webview.postMessage({ type: 'agentSelected', id });
					break;
				}
			}

			// If terminal is unowned and we have deferred adoptable files, adopt one
			if (this.ctx.activeAgentIdRef.current === null && this.ctx.adoptableFiles.size > 0) {
				const pDir = getProjectDirPath();
				if (pDir) {
					for (const file of this.ctx.adoptableFiles) {
						this.ctx.adoptableFiles.delete(file);
						this.ctx.knownJsonlFiles.add(file);
						adoptTerminalForFile(terminal, file, pDir, this.ctx);
						break;
					}
				}
			}
		});

		// Debounce terminal close to absorb rapid close/reopen cycles
		let closeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
		vscode.window.onDidCloseTerminal((closed) => {
			if (closeDebounceTimer) {clearTimeout(closeDebounceTimer);}
			closeDebounceTimer = setTimeout(() => {
				closeDebounceTimer = null;
				for (const [id, agent] of this.ctx.agents) {
					if (agent.terminalRef && agent.terminalRef === closed) {
						if (this.ctx.activeAgentIdRef.current === id) {
							this.ctx.activeAgentIdRef.current = null;
						}
						removeAgent(id, this.ctx);
						webviewView.webview.postMessage({ type: 'agentClosed', id });
					}
				}
			}, 300);
		});
	}

	/** Export current saved layout to webview-ui/public/assets/default-layout.json (dev utility) */
	exportDefaultLayout(): void {
		const layout = readLayoutFromFile();
		if (!layout) {
			vscode.window.showWarningMessage('Pixel Agents: No saved layout found.');
			return;
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			vscode.window.showErrorMessage('Pixel Agents: No workspace folder found.');
			return;
		}
		const targetPath = path.join(workspaceRoot, 'webview-ui', 'public', 'assets', 'default-layout.json');
		const json = JSON.stringify(layout, null, 2);
		fs.writeFileSync(targetPath, json, 'utf-8');
		vscode.window.showInformationMessage(`Pixel Agents: Default layout exported to ${targetPath}`);
	}

	private startLayoutWatcher(): void {
		if (this.layoutWatcher) {return;}
		this.layoutWatcher = watchLayoutFile((layout) => {
			log.info(' External layout change — pushing to webview');
			this.ctx.webview?.postMessage({ type: 'layoutLoaded', layout });
		});
	}

	dispose() {
		this.layoutWatcher?.dispose();
		this.layoutWatcher = null;
		if (this.attachedStaleTimer) {
			clearInterval(this.attachedStaleTimer);
			this.attachedStaleTimer = null;
		}
		for (const id of [...this.ctx.agents.keys()]) {
			removeAgent(id, this.ctx);
		}
		if (this.ctx.projectScanTimerRef.current) {
			clearInterval(this.ctx.projectScanTimerRef.current);
			this.ctx.projectScanTimerRef.current = null;
		}
	}
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
	const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

	let html = fs.readFileSync(indexPath, 'utf-8');

	html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
		const fileUri = vscode.Uri.joinPath(distPath, filePath);
		const webviewUri = webview.asWebviewUri(fileUri);
		return `${attr}="${webviewUri}"`;
	});

	return html;
}
