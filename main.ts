import {
	EventRef,
	MetadataCache,
	OpenViewState,
	PaneType,
	Plugin,
	TFile,
	Vault, View,
	Workspace,
	WorkspaceLeaf
} from 'obsidian';
import { around } from "monkey-around";

declare module 'obsidian' {
	interface MetadataCache {
		on(name: 'finished', callback: (file: TFile) => any, ctx?: any): EventRef;

		resolvedLinks: {
			[key: string]: {
				[key: string]: number
			}
		};
		saveFileCache: (path: string, cache: {
			hash: string;
			mtime: number;
			size: number;
		}) => Promise<void>;
		saveMetaCache: (hash: string, meta: {
			links: {
				displayText: string;
				link: string;
				original: string;
				position: {
					start: {
						line: number,
						ch: number,
						offset: string
					};
					end: {
						line: number,
						ch: number,
						offset: string
					};
				}
			}[]
		}) => Promise<void>;
	}
}

async function makeid(raw: string) {
	const msgBuffer = new TextEncoder().encode(raw);
	const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);

	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map(b => ('00' + b.toString(16)).slice(-2)).join('');
	return hashHex;
}

const getBaseName = (path: string) => {
	return path.replace('.md', '');
};

export default class MyPlugin extends Plugin {
	linkCountMap: {
		[key: string]: {
			[key: string]: number
		}
	} = {};
	fileCacheMap: {
		[key: string]: {
			hash: string;
			mtime: number;
			size: number;
		}
	} = {};
	metaCacheMap: {
		[key: string]: {
			links: {
				displayText: string;
				link: string;
				original: string;
				position: {
					start: {
						line: number,
						ch: number,
						offset: string
					};
					end: {
						line: number,
						ch: number,
						offset: string
					};
				}
			}[]
		}
	} = {};

	async onload() {
		this.patchBacklinks();

		this.app.metadataCache.on('finished', async () => {
			await this.initBacklinks();
			// this.app.metadataCache.trigger('resolve');
		});

		this.app.vault.on('modify', async (file: TFile) => {
			if (file.extension === "canvas") {
				this.initSpecialBacklinks(file);
				this.app.metadataCache.trigger('resolve', file);
			}
		});

		this.app.metadataCache.on('resolved', async () => {
			this.restoreBacklinks();
		});
		this.app.workspace.on('active-leaf-change', async () => {
			this.restoreBacklinks();
		});


		this.app.workspace.onLayoutReady(() => {
			this.patchOutgoingLinks();
		});
	}

	onunload() {
		this.fileCacheMap = {};
		this.metaCacheMap = {};
		this.linkCountMap = {};
	}

	restoreBacklinks() {
		Object.keys(this.fileCacheMap).forEach(async (path) => {
			const cache = this.fileCacheMap[path];
			const meta = this.metaCacheMap[cache.hash];
			if (!meta) return;
			this.app.metadataCache.resolvedLinks[path] = this.linkCountMap[path];
			await this.app.metadataCache.saveMetaCache(cache.hash, meta);
			await this.app.metadataCache.saveFileCache(path, cache);
		});
		// this.app.metadataCache.trigger('resolve');
	}

	async initSpecialBacklinks(file: TFile) {
		if (file.extension !== "canvas") return;
		const fileContent = await this.app.vault.read(file);
		const nodes = JSON.parse(fileContent)?.nodes;
		if (!nodes || nodes.length === 0) return;

		// Check if the file is already in the cache
		if (this.fileCacheMap[file.path]) {
			// Update the metaCacheMap and call saveMetaCache
			const hash = this.fileCacheMap[file.path].hash;
			const linksArray = [];
			const linkCountMap: {
				[key: string]: number
			} = {};

			const fileNodes = nodes.filter((node: { type: string; }) => node.type === "file");
			for (const node of fileNodes) {
				const link = getBaseName(node.file) || node.file;
				const original = `[[${link}]]`;
				const position = {
					start: {
						line: 1,
						ch: 1,
						offset: node.id
					}, end: {
						line: 1,
						ch: 1,
						offset: node.id
					}
				};

				linksArray.push({
					displayText: link,
					link,
					original,
					position
				});

				if (!linkCountMap[node.file]) {
					linkCountMap[node.file] = 1;
				} else {
					linkCountMap[node.file]++;
				}
			}

			this.linkCountMap[file.path] = linkCountMap;
			this.metaCacheMap[hash] = {links: linksArray};

			// Update metaCacheMap and call saveMetaCache
			await this.app.metadataCache.saveMetaCache(hash, this.metaCacheMap[hash]);
			this.app.metadataCache.resolvedLinks[file.path] = linkCountMap;
		}

		// Create a new cache for the file
		const hash = await makeid(file.path);
		const mtime = file.stat.mtime;
		const size = file.stat.size;

		// Update fileCacheMap and call saveFileCache
		this.fileCacheMap[file.path] = {hash, mtime, size};
		await this.app.metadataCache.saveFileCache(file.path, this.fileCacheMap[file.path]);

		const linksArray = [];
		const linkCountMap: {
			[key: string]: number
		} = {};

		const fileNodes = nodes.filter((node: { type: string; }) => node.type === "file");
		for (const node of fileNodes) {
			const link = getBaseName(node.file) || node.file;
			const original = `[[${link}]]`;
			const position = {
				start: {
					line: 1,
					ch: 1,
					offset: node.id
				}, end: {
					line: 1,
					ch: 1,
					offset: node.id
				}
			};

			linksArray.push({
				displayText: link,
				link,
				original,
				position
			});

			if (!linkCountMap[node.file]) {
				linkCountMap[node.file] = 1;
			} else {
				linkCountMap[node.file]++;
			}
		}

		this.linkCountMap[file.path] = linkCountMap;
		// Update metaCacheMap and call saveMetaCache
		this.metaCacheMap[hash] = {links: linksArray};
		await this.app.metadataCache.saveMetaCache(hash, this.metaCacheMap[hash]);
		this.app.metadataCache.resolvedLinks[file.path] = linkCountMap;
	}

	async initBacklinks() {
		const files = this.app.vault.getFiles().filter(file => file.extension === "canvas");
		for (const file of files) {
			const fileContent = await this.app.vault.read(file);
			const nodes = JSON.parse(fileContent)?.nodes;
			if (!nodes || nodes.length === 0) continue;

			const fileNodes = nodes.filter((node: { type: string; }) => node.type === "file");
			if (fileNodes.length === 0) continue;

			const hash = await makeid(file.path);
			const mtime = file.stat.mtime;
			const size = file.stat.size;

			// Update fileCacheMap and call saveFileCache
			this.fileCacheMap[file.path] = {hash, mtime, size};
			await this.app.metadataCache.saveFileCache(file.path, this.fileCacheMap[file.path]);

			const linksArray = [];
			const linkCountMap: {
				[key: string]: number
			} = {};
			for (const node of fileNodes) {
				const link = getBaseName(node.file) || node.file;
				const original = `[[${link}]]`;
				const position = {
					start: {
						line: 1,
						ch: 1,
						offset: node.id
					}, end: {
						line: 1,
						ch: 1,
						offset: node.id
					}
				};

				linksArray.push({
					displayText: link,
					link,
					original,
					position
				});

				if (!linkCountMap[node.file]) {
					linkCountMap[node.file] = 1;
				} else {
					linkCountMap[node.file]++;
				}
			}

			this.linkCountMap[file.path] = linkCountMap;
			// Update metaCacheMap and call saveMetaCache
			this.metaCacheMap[hash] = {links: linksArray};
			await this.app.metadataCache.saveMetaCache(hash, this.metaCacheMap[hash]);
			this.app.metadataCache.resolvedLinks[file.path] = linkCountMap;
		}
	}


	patchBacklinks() {
		const metadataCacheUninstaller = around(MetadataCache.prototype, {
			getCache: (next: any) => {
				return function (path: string) {
					const result = next.apply(this, [path]);
					if (path.contains('.canvas')) {
						const t = this.fileCache[path].hash;
						if (!t) {
							return {};
						}
						return this.metadataCache[t] || null;
					}
					return result;
				};
			}
		});

		const vaultUninstaller = around(Vault.prototype, {
			getMarkdownFiles: (next: any) => {
				return function () {
					const result = next.apply(this);
					const canvasFiles = this.getFiles().filter((file: TFile) => file.extension === "canvas");
					return [
						...result, ...canvasFiles
					];
				};
			}
		});

		const workspaceLeafUninstaller = around(WorkspaceLeaf.prototype, {
			openFile: (next: any) => {
				return async function (file: TFile, state?: OpenViewState) {
					await next.apply(this, [file, state]);
					if (file.extension === "canvas" && state?.eState?.match?.matches[0]) {
						setTimeout(() => {
							const canvas = this.view.canvas;
							const nodes = canvas.nodes;
							const nodeid = state?.eState?.match?.matches[0][0];
							const node = nodes.get(nodeid);
							canvas.selectOnly(node);
							canvas.zoomToSelection();
						}, 200);
					}
					return;
				};
			}
		});

		this.register(metadataCacheUninstaller);
		this.register(vaultUninstaller);
		this.register(workspaceLeafUninstaller);
	}

	patchOutgoingLinks() {
		const view = this.app.workspace.getLeavesOfType('outgoing-link')[0].view;
		const outgoingLink = (view as View & {
			outgoingLink: any;
		}).outgoingLink;

		const outgoingLinkUninstaller = around(outgoingLink.constructor.prototype, {
			recomputeLinks: (next: any) => {
				return function () {
					let isCanvas = false;
					if (this?.file?.extension === "canvas") {
						this.file.extension = "md";
						isCanvas = true;
					}
					next.apply(this);
					if (isCanvas) {
						this.file.extension = "canvas";
					}
				};
			}
		});

		this.register(outgoingLinkUninstaller);
	}

}
