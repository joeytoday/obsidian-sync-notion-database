import { App, Notice, Plugin, PluginSettingTab, Setting, Modal, TFile, normalizePath, requestUrl } from 'obsidian';

// ==================== Notion API 客户端 (使用 Obsidian requestUrl 避免 CORS) ====================

class NotionClient {
	private token: string;
	private baseUrl = 'https://api.notion.com/v1';

	constructor(token: string) {
		this.token = token;
	}

	private async request<T>(path: string, options?: { method?: string; body?: any }): Promise<T> {
		const response = await requestUrl({
			url: `${this.baseUrl}${path}`,
			method: options?.method || 'GET',
			headers: {
				'Authorization': `Bearer ${this.token}`,
				'Notion-Version': '2022-06-28',
				'Content-Type': 'application/json',
			},
			body: options?.body ? JSON.stringify(options.body) : undefined,
		});

		return response.json as T;
	}

	databases = {
		retrieve: (databaseId: string) =>
			this.request<{
				id: string;
				title: Array<{ plain_text: string }>;
				properties: Record<string, any>;
			}>(`/databases/${databaseId}`),

		query: (databaseId: string, startCursor?: string) =>
			this.request<{
				results: Array<{
					id: string;
					object: string;
					last_edited_time: string;
					properties: Record<string, any>;
				}>;
				next_cursor: string | null;
			}>(`/databases/${databaseId}/query`, {
				method: 'POST',
				body: startCursor ? { start_cursor: startCursor } : undefined,
			}),
	};

	pages = {
		retrieve: (pageId: string) =>
			this.request<{
				id: string;
				properties: Record<string, any>;
			}>(`/pages/${pageId}`),
	};
}

// ==================== 接口定义 ====================

interface NotionSyncSettings {
	notionToken: string;
	databaseId: string;
	syncFolder: string;
	propertyMappings: PropertyMapping[];
	syncRules: SyncRule[];
	fileTemplate: string;
	filenameProperty: string;
	templateFilePath: string;
}

interface PropertyMapping {
	notionProperty: string;
	notionType: string;
	obsidianProperty: string;
	enabled: boolean;
	isTemplateVariable: boolean;
}

interface SyncRule {
	property: string;
	condition: 'equals' | 'notEmpty' | 'isTrue' | 'isFalse';
	value?: string;
}

interface UpdatedFile {
	filename: string;
	oldContent: string;
	newContent: string;
}

interface SyncResult {
	created: string[];
	updated: UpdatedFile[];
	unchanged: number;
	skipped: number;
}

interface PageInfo {
	id: string;
	lastEditedTime: string;
	properties: Record<string, any>;
	title: string;
}

type SyncPreviewStatus = 'new' | 'updated' | 'unchanged' | 'skipped';

interface SyncPreviewItem {
	page: PageInfo;
	filename: string;
	filePath: string;
	status: SyncPreviewStatus;
	newContent: string;
	oldContent: string;
	selected: boolean;
}

// ==================== 默认设置 ====================

const DEFAULT_SETTINGS: NotionSyncSettings = {
	notionToken: '',
	databaseId: '',
	syncFolder: 'Notion Sync',
	propertyMappings: [],
	syncRules: [],
	fileTemplate: '---\n{{frontmatter}}\n---\n\n# {{title}}\n\n{{content}}',
	filenameProperty: 'title',
	templateFilePath: '',
};

// ==================== 主插件类 ====================

export default class NotionSyncPlugin extends Plugin {
	settings: NotionSyncSettings;
	notionClient: NotionClient | null = null;

	async onload() {
		await this.loadSettings();
		this.initializeNotionClient();

		this.addCommand({
			id: 'sync-notion-database',
			name: 'Sync Notion Database',
			callback: async () => {
				await this.syncDatabase();
			},
		});

		this.addSettingTab(new NotionSyncSettingTab(this.app, this));
		console.log('Notion Database Sync plugin loaded');
	}

	onunload() {
		console.log('Notion Database Sync plugin unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.initializeNotionClient();
	}

	initializeNotionClient() {
		if (this.settings.notionToken) {
			this.notionClient = new NotionClient(this.settings.notionToken);
		} else {
			this.notionClient = null;
		}
	}

	// 获取数据库属性
	async fetchDatabaseProperties(): Promise<Record<string, any> | null> {
		if (!this.notionClient || !this.settings.databaseId) return null;
		try {
			const response = await this.notionClient.databases.retrieve(this.settings.databaseId);
			return response.properties;
		} catch (error) {
			console.error('Failed to fetch database properties:', error);
			return null;
		}
	}

	// 获取所有页面
	async fetchAllPages(): Promise<PageInfo[]> {
		if (!this.notionClient || !this.settings.databaseId) return [];

		const pages: PageInfo[] = [];
		let cursor: string | undefined;
		let pageCount = 0;

		do {
			try {
				const response = await this.notionClient.databases.query(
					this.settings.databaseId,
					cursor
				);
				
				pageCount++;
				console.log(`[Notion Sync] 获取第 ${pageCount} 批数据，本批 ${response.results.length} 条`);

				for (const page of response.results) {
					try {
						const title = this.extractTitle(page.properties);
						pages.push({
							id: page.id,
							lastEditedTime: page.last_edited_time,
							properties: page.properties,
							title,
						});
					} catch (error) {
						console.error(`[Notion Sync] 处理页面 ${page.id} 失败:`, error);
					}
				}

				cursor = response.next_cursor ?? undefined;
			} catch (error) {
				console.error('[Notion Sync] 获取页面失败:', error);
				new Notice(`获取数据失败: ${error.message}`);
				break;
			}
		} while (cursor);
		
		console.log(`[Notion Sync] 总共获取 ${pages.length} 条记录`);
		return pages;
	}

	// 提取页面标题
	extractTitle(properties: Record<string, any>): string {
		// 优先从 title 属性获取
		for (const [, prop] of Object.entries(properties)) {
			if (prop?.type === 'title' && prop.title?.length > 0) {
				return prop.title.map((t: any) => t.plain_text).join('');
			}
		}
		return 'Untitled';
	}

	// 检查记录是否满足同步规则
	checkSyncRules(properties: Record<string, any>): boolean {
		if (this.settings.syncRules.length === 0) return true;

		return this.settings.syncRules.every(rule => {
			const prop = properties[rule.property];
			if (!prop) return false;

			const value = this.extractPropertyValue(prop);

			switch (rule.condition) {
				case 'equals':
					return String(value).toLowerCase() === String(rule.value).toLowerCase();
				case 'notEmpty':
					return value !== null && value !== undefined && value !== '';
				case 'isTrue':
					return value === true || value === 'true' || value === 'yes';
				case 'isFalse':
					return value === false || value === 'false' || value === 'no';
				default:
					return true;
			}
		});
	}

	// 提取属性值
	extractPropertyValue(prop: any): any {
		if (!prop || !prop.type) return '';
		
		switch (prop.type) {
			case 'title':
				return prop.title?.map((t: any) => t.plain_text).join('') || '';
			case 'rich_text':
				return prop.rich_text?.map((t: any) => t.plain_text).join('') || '';
			case 'number':
				return prop.number;
			case 'select':
				return prop.select?.name || '';
			case 'multi_select':
				return prop.multi_select?.map((s: any) => s.name) || [];
			case 'checkbox':
				return prop.checkbox;
			case 'url':
				return prop.url || '';
			case 'email':
				return prop.email || '';
			case 'phone_number':
				return prop.phone_number || '';
			case 'date':
				return prop.date?.start || '';
			case 'status':
				return prop.status?.name || '';
			case 'formula': {
				if (!prop.formula) return '';
				const formulaType = prop.formula.type;
				if (formulaType === 'string') return prop.formula.string || '';
				if (formulaType === 'number') return prop.formula.number ?? '';
				if (formulaType === 'boolean') return prop.formula.boolean ?? '';
				if (formulaType === 'date') return prop.formula.date?.start || '';
				return '';
			}
			case 'rollup':
				// rollup 可能是数组或单个值，转换为字符串
				if (!prop.rollup) return '';
				if (prop.rollup.type === 'array' && prop.rollup.array) {
					// 提取数组中的值
					const values = prop.rollup.array.map((item: any) => {
						if (item.title) return item.title.map((t: any) => t.plain_text).join('');
						if (item.rich_text) return item.rich_text.map((t: any) => t.plain_text).join('');
						if (item.number !== undefined) return String(item.number);
						if (item.select?.name) return item.select.name;
						return '';
					}).filter((v: string) => v);
					return values.join(', ');
				}
				if (prop.rollup.type === 'number') return prop.rollup.number ?? '';
				if (prop.rollup.type === 'date') return prop.rollup.date?.start || '';
				return '';
			case 'files':
				if (!prop.files || prop.files.length === 0) return '';
				return prop.files.map((f: any) => {
					if (f.type === 'external') return f.external?.url || '';
					if (f.type === 'file') return f.file?.url || '';
					return '';
				}).filter((url: string) => url).join(', ');
			case 'relation':
				if (!prop.relation || prop.relation.length === 0) return '';
				return prop.relation.map((r: any) => r.id || '').join(', ');
			case 'created_time':
				return this.formatDateTimeForObsidian(prop.created_time || '');
			case 'last_edited_time':
				return this.formatDateTimeForObsidian(prop.last_edited_time || '');
			case 'created_by':
				return prop.created_by?.name || '';
			case 'last_edited_by':
				return prop.last_edited_by?.name || '';
			default:
				return '';
		}
	}

	// 生成文件名
	generateFilename(page: PageInfo): string {
		const mapping = this.settings.propertyMappings.find(
			m => m.notionProperty === this.settings.filenameProperty
		);

		let filename: string;
		if (mapping) {
			const prop = page.properties[this.settings.filenameProperty];
			filename = prop ? this.extractPropertyValue(prop) : page.title;
		} else {
			filename = page.title;
		}

		// 清理文件名中的非法字符
		return filename.replace(/[<>:"/\\|?*]/g, '_').trim() || 'Untitled';
	}

	// 获取 relation 属性中关联页面的标题
	async fetchRelationTitles(relationIds: string[]): Promise<string[]> {
		if (!this.notionClient || relationIds.length === 0) return [];

		const titles: string[] = [];
		for (const pageId of relationIds) {
			try {
				const page = await this.notionClient.pages.retrieve(pageId);
				const title = this.extractTitle(page.properties);
				titles.push(title);
			} catch (error) {
				console.warn(`[Notion Sync] 获取关联页面 ${pageId} 标题失败:`, error);
				titles.push(pageId.slice(0, 8));
			}
		}
		return titles;
	}

	// 提取属性值（异步版本，支持 relation 标题解析）
	async extractPropertyValueAsync(prop: any): Promise<any> {
		if (!prop || !prop.type) return '';

		if (prop.type === 'relation') {
			if (!prop.relation || prop.relation.length === 0) return '';
			const relationIds = prop.relation.map((r: any) => r.id).filter((id: string) => id);
			const titles = await this.fetchRelationTitles(relationIds);
			return titles.length === 1 ? titles[0] : titles;
		}

		return this.extractPropertyValue(prop);
	}

	// 格式化 ISO 时间为 Obsidian 友好格式（YYYY-MM-DD HH:mm）
	formatDateTimeForObsidian(dateString: string): string {
		if (!dateString) return '';
		// 匹配 ISO 8601 格式（如 2026-02-10T07:40:00.000Z）
		const isoMatch = dateString.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
		if (isoMatch) {
			return `${isoMatch[1]} ${isoMatch[2]}`;
		}
		// 已经是简单日期格式则直接返回
		return dateString;
	}

	// 将属性值格式化为 YAML frontmatter 格式的字符串
	formatValueForYaml(value: any): string {
		if (value === null || value === undefined || value === '') {
			return '';
		}

		if (Array.isArray(value)) {
			if (value.length === 0) return '';
			return '\n' + value.map(v => `  - ${v}`).join('\n');
		}

		if (typeof value === 'boolean') {
			return String(value);
		}

		if (typeof value === 'number') {
			return String(value);
		}

		const stringValue = String(value);

		// 日期时间格式化：将 ISO 格式转为 Obsidian 友好格式
		if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(stringValue)) {
			return this.formatDateTimeForObsidian(stringValue);
		}

		// 纯日期格式（YYYY-MM-DD）直接返回
		if (/^\d{4}-\d{2}-\d{2}$/.test(stringValue)) {
			return stringValue;
		}

		// 多行文本使用 YAML 块标量语法
		if (stringValue.includes('\n')) {
			const indentedLines = stringValue.split('\n').map(line => `  ${line}`).join('\n');
			return `|\n${indentedLines}`;
		}

		// 包含需要引号的 YAML 特殊字符
		// 注意：冒号后跟空格、# 前有空格、[] {} 等需要引号
		// 但 URL（http:// https://）、斜杠路径、emoji 等不需要引号
		if (this.needsYamlQuoting(stringValue)) {
			return `"${stringValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
		}

		return stringValue;
	}

	// 判断字符串是否需要 YAML 引号包裹
	needsYamlQuoting(value: string): boolean {
		// 空字符串不需要
		if (!value) return false;

		// 以特殊字符开头需要引号
		if (/^[&*!|>%@`]/.test(value)) return true;

		// 包含 `: `（冒号+空格）需要引号，但纯 URL 不需要
		if (value.includes(': ') && !value.match(/^https?:\/\//)) return true;

		// 包含 ` #`（空格+井号，YAML 注释）需要引号
		if (value.includes(' #')) return true;

		// 以 `{` 或 `[` 开头（YAML flow 语法）需要引号
		if (/^[{[]/.test(value)) return true;

		// YAML 保留值需要引号
		const reserved = ['true', 'false', 'yes', 'no', 'null', 'on', 'off'];
		if (reserved.includes(value.toLowerCase())) return true;

		return false;
	}

	// 构建 Notion 属性数据的 Map（obsidianProperty -> 格式化后的值）
	async buildNotionPropertyMap(properties: Record<string, any>): Promise<Map<string, string>> {
		const propertyMap = new Map<string, string>();
		const enabledMappings = this.settings.propertyMappings.filter(m => m.enabled);

		for (const mapping of enabledMappings) {
			const prop = properties[mapping.notionProperty];
			if (!prop) continue;

			try {
				const value = await this.extractPropertyValueAsync(prop);
				const formattedValue = this.formatValueForYaml(value);
				propertyMap.set(mapping.obsidianProperty, formattedValue);
			} catch (error) {
				console.error(`[Notion Sync] 提取属性 ${mapping.notionProperty} 失败:`, error);
			}
		}

		return propertyMap;
	}

	// 生成 frontmatter（用于默认模板中的 {{frontmatter}} 占位符）
	async generateFrontmatter(properties: Record<string, any>): Promise<string> {
		const propertyMap = await this.buildNotionPropertyMap(properties);
		const lines: string[] = [];

		for (const [key, value] of propertyMap) {
			lines.push(`${key}: ${value}`);
		}

		// 添加元信息
		lines.push(`notion_id: ${properties.id || ''}`);
		const lastEdited = this.formatDateTimeForObsidian(properties.last_edited_time || '');
		lines.push(`notion_last_edited: ${lastEdited}`);

		return lines.join('\n');
	}

	// 解析 frontmatter 字符串为有序的键值对列表（保留原始顺序和格式）
	parseFrontmatterLines(frontmatterBlock: string): { key: string; originalLine: string }[] {
		const lines = frontmatterBlock.split('\n');
		const result: { key: string; originalLine: string }[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// 匹配 YAML 键值对（key: value 或 key:）
			const keyMatch = line.match(/^(\s*)([\w\-\u4e00-\u9fff]+)\s*:/);
			if (keyMatch) {
				// 收集多行值（如 YAML 列表）
				let fullLine = line;
				while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
					i++;
					fullLine += '\n' + lines[i];
				}
				result.push({ key: keyMatch[2], originalLine: fullLine });
			}
		}

		return result;
	}

	// 获取模板内容
	async getTemplateContent(): Promise<string> {
		if (this.settings.templateFilePath) {
			const file = this.app.vault.getAbstractFileByPath(this.settings.templateFilePath);
			if (file instanceof TFile) {
				try {
					return await this.app.vault.read(file);
				} catch (error) {
					console.error('读取模板文件失败:', error);
					new Notice(`读取模板文件失败: ${error.message}`);
				}
			}
		}
		return this.settings.fileTemplate;
	}

	// 生成文件内容
	async generateFileContent(page: PageInfo): Promise<string> {
		let content = await this.getTemplateContent();

		// 构建 Notion 属性数据
		const notionPropertyMap = await this.buildNotionPropertyMap(page.properties);

		// 检查模板是否包含 frontmatter 块
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

		if (frontmatterMatch) {
			// 模板有 frontmatter 块：解析并用 Notion 数据覆盖属性值
			const templateFrontmatter = frontmatterMatch[1];

			if (templateFrontmatter.includes('{{frontmatter}}')) {
				// 模板使用 {{frontmatter}} 占位符 → 直接替换
				const generatedFrontmatter = await this.generateFrontmatter(page.properties);
				content = content.replace('{{frontmatter}}', generatedFrontmatter);
			} else {
				// 模板直接写了属性名 → 解析并逐个覆盖
				const parsedLines = this.parseFrontmatterLines(templateFrontmatter);
				const newFrontmatterLines: string[] = [];
				const processedKeys = new Set<string>();

				for (const { key, originalLine } of parsedLines) {
					processedKeys.add(key);

					if (notionPropertyMap.has(key)) {
						const notionValue = notionPropertyMap.get(key) ?? '';

						// 对于列表类型属性（如 tags），合并模板默认值和 Notion 数据
						if (notionValue.startsWith('\n') && /^\s+-\s/.test(originalLine.split('\n').slice(1).join('\n'))) {
							const templateItems = originalLine.split('\n')
								.filter(line => /^\s+-\s/.test(line))
								.map(line => line.replace(/^\s+-\s+/, '').trim());
							const notionItems = notionValue.split('\n')
								.filter(line => /^\s+-\s/.test(line))
								.map(line => line.replace(/^\s+-\s+/, '').trim());
							const mergedItems = [...new Set([...templateItems, ...notionItems])];
							const mergedValue = '\n' + mergedItems.map(item => `  - ${item}`).join('\n');
							newFrontmatterLines.push(`${key}: ${mergedValue}`);
						} else {
							newFrontmatterLines.push(`${key}: ${notionValue}`);
						}
					} else {
						newFrontmatterLines.push(originalLine);
					}
				}

				// 添加 Notion 中有但模板中没有的属性
				for (const [key, value] of notionPropertyMap) {
					if (!processedKeys.has(key)) {
						newFrontmatterLines.push(`${key}: ${value}`);
					}
				}

				// 添加元信息
				if (!processedKeys.has('notion_id')) {
					newFrontmatterLines.push(`notion_id: ${page.id}`);
				}
				if (!processedKeys.has('notion_last_edited')) {
					newFrontmatterLines.push(`notion_last_edited: ${this.formatDateTimeForObsidian(page.lastEditedTime)}`);
				}

				const newFrontmatter = newFrontmatterLines.join('\n');
				content = content.replace(frontmatterMatch[0], `---\n${newFrontmatter}\n---`);
			}
		} else {
			// 模板没有 frontmatter 块 → 生成并添加到开头
			const generatedFrontmatter = await this.generateFrontmatter(page.properties);
			content = `---\n${generatedFrontmatter}\n---\n\n${content}`;
		}

		// 替换正文中的模板变量
		content = content.replace(/{{title}}/g, page.title);
		content = content.replace(/{{content}}/g, '');

		// 替换自定义属性变量（用于正文部分）
		for (const [key, value] of notionPropertyMap) {
			const placeholder = new RegExp(`{{${key}}}`, 'g');
			content = content.replace(placeholder, value.startsWith('\n') ? value.trim() : value);
		}

		return content;
	}

	// 同步数据库（入口：打开同步中心）
	async syncDatabase(): Promise<void> {
		if (!this.notionClient) {
			new Notice('请先配置 Notion Token');
			return;
		}

		if (!this.settings.databaseId) {
			new Notice('请先配置 Database ID');
			return;
		}

		new Notice('正在从 Notion 获取数据...');

		try {
			const pages = await this.fetchAllPages();
			console.log(`[Notion Sync] Fetched ${pages.length} pages from Notion`);

			const folderPath = normalizePath(this.settings.syncFolder);
			await this.ensureFolderExists(folderPath);

			new Notice('正在分析同步状态...');
			const previewItems = await this.prepareSyncPreview(pages, folderPath);

			new SyncCenterModal(this.app, this, previewItems, folderPath).open();
		} catch (error) {
			console.error('Sync error:', error);
			new Notice(`获取数据失败: ${error.message}`);
		}
	}

	// 确保文件夹存在
	async ensureFolderExists(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(path))) {
			await adapter.mkdir(path);
		}
	}

	// 预分析同步状态（不实际写入文件）
	async prepareSyncPreview(pages: PageInfo[], folderPath: string): Promise<SyncPreviewItem[]> {
		const previewItems: SyncPreviewItem[] = [];
		const filenameCount = new Map<string, number>();
		const processedIds = new Set<string>();

		for (const page of pages) {
			try {
				if (!this.checkSyncRules(page.properties)) {
					continue;
				}

				if (processedIds.has(page.id)) {
					continue;
				}
				processedIds.add(page.id);

				const filename = this.generateFilename(page);

				let uniqueFilename = filename;
				const count = filenameCount.get(filename) || 0;
				if (count > 0) {
					uniqueFilename = `${filename}_${count}`;
				}
				filenameCount.set(filename, count + 1);

				const filePath = normalizePath(`${folderPath}/${uniqueFilename}.md`);
				const newContent = await this.generateFileContent(page);
				const existingFile = this.app.vault.getAbstractFileByPath(filePath);

				let status: SyncPreviewStatus;
				let oldContent = '';

				if (existingFile instanceof TFile) {
					oldContent = await this.app.vault.read(existingFile);
					const lastSyncMatch = oldContent.match(/notion_last_edited:\s*(.+)/);
					const lastSyncTime = lastSyncMatch ? new Date(lastSyncMatch[1]).getTime() : 0;
					const notionEditTime = new Date(page.lastEditedTime).getTime();

					if (notionEditTime > lastSyncTime || oldContent !== newContent) {
						status = 'updated';
					} else {
						status = 'unchanged';
					}
				} else {
					status = 'new';
				}

				previewItems.push({
					page,
					filename: uniqueFilename,
					filePath,
					status,
					newContent,
					oldContent,
					selected: status === 'new' || status === 'updated',
				});
			} catch (error) {
				console.error(`[Notion Sync] 预分析页面 ${page.id} 失败:`, error);
			}
		}

		return previewItems;
	}

	// 执行选中项的同步
	async performSelectedSync(items: SyncPreviewItem[], folderPath: string): Promise<SyncResult> {
		const result: SyncResult = {
			created: [],
			updated: [],
			unchanged: 0,
			skipped: 0,
		};

		await this.ensureFolderExists(folderPath);

		for (const item of items) {
			if (!item.selected) {
				if (item.status === 'unchanged') {
					result.unchanged++;
				} else {
					result.skipped++;
				}
				continue;
			}

			try {
				const existingFile = this.app.vault.getAbstractFileByPath(item.filePath);

				if (item.status === 'new') {
					await this.app.vault.create(item.filePath, item.newContent);
					result.created.push(item.filename);
				} else if (item.status === 'updated') {
					if (existingFile instanceof TFile) {
						await this.app.vault.modify(existingFile, item.newContent);
						result.updated.push({
							filename: item.filename,
							oldContent: item.oldContent,
							newContent: item.newContent,
						});
					}
				} else {
					result.unchanged++;
				}
			} catch (error) {
				console.error(`[Notion Sync] 同步文件 ${item.filename} 失败:`, error);
			}
		}

		return result;
	}
}

// ==================== 同步中心弹窗 ====================

class SyncCenterModal extends Modal {
	plugin: NotionSyncPlugin;
	previewItems: SyncPreviewItem[];
	folderPath: string;
	listContainer: HTMLElement;

	constructor(app: App, plugin: NotionSyncPlugin, previewItems: SyncPreviewItem[], folderPath: string) {
		super(app);
		this.plugin = plugin;
		this.previewItems = previewItems;
		this.folderPath = folderPath;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('sync-center-modal');

		contentEl.createEl('h2', { text: '📋 同步中心' });

		const newItems = this.previewItems.filter(item => item.status === 'new');
		const updatedItems = this.previewItems.filter(item => item.status === 'updated');
		const unchangedItems = this.previewItems.filter(item => item.status === 'unchanged');

		// 统计信息
		const statsDiv = contentEl.createDiv('sync-center-stats');
		statsDiv.style.display = 'flex';
		statsDiv.style.gap = '16px';
		statsDiv.style.marginBottom = '16px';
		statsDiv.style.padding = '12px';
		statsDiv.style.borderRadius = '8px';
		statsDiv.style.backgroundColor = 'var(--background-secondary)';

		this.createStatBadge(statsDiv, '🆕 新增', newItems.length, '#2ea043');
		this.createStatBadge(statsDiv, '📝 更新', updatedItems.length, '#d29922');
		this.createStatBadge(statsDiv, '✅ 未变更', unchangedItems.length, 'var(--text-muted)');

		// 操作栏
		const actionBar = contentEl.createDiv('sync-center-action-bar');
		actionBar.style.display = 'flex';
		actionBar.style.justifyContent = 'space-between';
		actionBar.style.alignItems = 'center';
		actionBar.style.marginBottom = '12px';

		const selectActions = actionBar.createDiv();
		selectActions.style.display = 'flex';
		selectActions.style.gap = '8px';

		const selectAllBtn = selectActions.createEl('button', { text: '全选' });
		selectAllBtn.style.fontSize = '12px';
		selectAllBtn.addEventListener('click', () => {
			this.previewItems.forEach(item => {
				if (item.status !== 'unchanged') item.selected = true;
			});
			this.renderList();
		});

		const deselectAllBtn = selectActions.createEl('button', { text: '取消全选' });
		deselectAllBtn.style.fontSize = '12px';
		deselectAllBtn.addEventListener('click', () => {
			this.previewItems.forEach(item => item.selected = false);
			this.renderList();
		});

		const selectNewBtn = selectActions.createEl('button', { text: '仅选新增' });
		selectNewBtn.style.fontSize = '12px';
		selectNewBtn.addEventListener('click', () => {
			this.previewItems.forEach(item => {
				item.selected = item.status === 'new';
			});
			this.renderList();
		});

		const selectUpdatedBtn = selectActions.createEl('button', { text: '仅选更新' });
		selectUpdatedBtn.style.fontSize = '12px';
		selectUpdatedBtn.addEventListener('click', () => {
			this.previewItems.forEach(item => {
				item.selected = item.status === 'updated';
			});
			this.renderList();
		});

		// 文件列表容器
		this.listContainer = contentEl.createDiv('sync-center-list');
		this.listContainer.style.maxHeight = '400px';
		this.listContainer.style.overflow = 'auto';
		this.listContainer.style.border = '1px solid var(--background-modifier-border)';
		this.listContainer.style.borderRadius = '8px';
		this.renderList();

		// 底部按钮
		const footerDiv = contentEl.createDiv('sync-center-footer');
		footerDiv.style.display = 'flex';
		footerDiv.style.justifyContent = 'flex-end';
		footerDiv.style.gap = '10px';
		footerDiv.style.marginTop = '16px';

		const cancelBtn = footerDiv.createEl('button', { text: '取消' });
		cancelBtn.addEventListener('click', () => this.close());

		const syncBtn = footerDiv.createEl('button', { text: '🔄 开始同步', cls: 'mod-cta' });
		syncBtn.addEventListener('click', async () => {
			const selectedCount = this.previewItems.filter(item => item.selected).length;
			if (selectedCount === 0) {
				new Notice('请至少选择一个文件进行同步');
				return;
			}

			syncBtn.disabled = true;
			syncBtn.textContent = '同步中...';

			try {
				const result = await this.plugin.performSelectedSync(this.previewItems, this.folderPath);
				this.close();

				new Notice(
					`同步完成！新增: ${result.created.length}, 更新: ${result.updated.length}, ` +
					`未变更: ${result.unchanged}, 跳过: ${result.skipped}`
				);

				new SyncResultModal(this.app, result).open();
			} catch (error) {
				console.error('Sync error:', error);
				new Notice(`同步失败: ${error.message}`);
				syncBtn.disabled = false;
				syncBtn.textContent = '🔄 开始同步';
			}
		});
	}

	createStatBadge(container: HTMLElement, label: string, count: number, color: string) {
		const badge = container.createDiv();
		badge.style.display = 'flex';
		badge.style.alignItems = 'center';
		badge.style.gap = '6px';

		const countSpan = badge.createSpan({ text: String(count) });
		countSpan.style.fontSize = '20px';
		countSpan.style.fontWeight = 'bold';
		countSpan.style.color = color;

		badge.createSpan({ text: label });
	}

	renderList() {
		this.listContainer.empty();

		const newItems = this.previewItems.filter(item => item.status === 'new');
		const updatedItems = this.previewItems.filter(item => item.status === 'updated');
		const unchangedItems = this.previewItems.filter(item => item.status === 'unchanged');

		if (newItems.length > 0) {
			this.renderSection('🆕 新增文件', newItems);
		}
		if (updatedItems.length > 0) {
			this.renderSection('📝 需要更新', updatedItems);
		}
		if (unchangedItems.length > 0) {
			this.renderSection('✅ 未变更', unchangedItems);
		}

		if (this.previewItems.length === 0) {
			const emptyDiv = this.listContainer.createDiv();
			emptyDiv.style.padding = '40px';
			emptyDiv.style.textAlign = 'center';
			emptyDiv.style.color = 'var(--text-muted)';
			emptyDiv.textContent = '没有满足同步规则的记录';
		}
	}

	renderSection(title: string, items: SyncPreviewItem[]) {
		const sectionHeader = this.listContainer.createDiv('sync-section-header');
		sectionHeader.style.padding = '8px 12px';
		sectionHeader.style.fontWeight = 'bold';
		sectionHeader.style.fontSize = '13px';
		sectionHeader.style.backgroundColor = 'var(--background-secondary)';
		sectionHeader.style.borderBottom = '1px solid var(--background-modifier-border)';
		sectionHeader.style.position = 'sticky';
		sectionHeader.style.top = '0';
		sectionHeader.style.zIndex = '1';
		sectionHeader.textContent = `${title} (${items.length})`;

		items.forEach(item => {
			const row = this.listContainer.createDiv('sync-item-row');
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.gap = '10px';
			row.style.padding = '8px 12px';
			row.style.borderBottom = '1px solid var(--background-modifier-border)';

			// 勾选框
			const checkbox = row.createEl('input', { type: 'checkbox' });
			checkbox.checked = item.selected;
			checkbox.style.cursor = 'pointer';
			if (item.status === 'unchanged') {
				checkbox.disabled = true;
				checkbox.style.opacity = '0.5';
			}
			checkbox.addEventListener('change', () => {
				item.selected = checkbox.checked;
			});

			// 状态标签
			const statusBadge = row.createSpan();
			statusBadge.style.fontSize = '11px';
			statusBadge.style.padding = '2px 6px';
			statusBadge.style.borderRadius = '4px';
			statusBadge.style.fontWeight = '500';
			statusBadge.style.flexShrink = '0';

			if (item.status === 'new') {
				statusBadge.textContent = '新增';
				statusBadge.style.backgroundColor = 'rgba(46, 160, 67, 0.15)';
				statusBadge.style.color = '#2ea043';
			} else if (item.status === 'updated') {
				statusBadge.textContent = '更新';
				statusBadge.style.backgroundColor = 'rgba(210, 153, 34, 0.15)';
				statusBadge.style.color = '#d29922';
			} else {
				statusBadge.textContent = '未变更';
				statusBadge.style.backgroundColor = 'var(--background-secondary)';
				statusBadge.style.color = 'var(--text-muted)';
			}

			// 文件名
			const filenameSpan = row.createSpan({ text: item.filename });
			filenameSpan.style.flex = '1';
			filenameSpan.style.overflow = 'hidden';
			filenameSpan.style.textOverflow = 'ellipsis';
			filenameSpan.style.whiteSpace = 'nowrap';

			// 操作按钮
			if (item.status === 'updated') {
				const diffBtn = row.createEl('button', { text: '对比' });
				diffBtn.style.fontSize = '11px';
				diffBtn.style.padding = '2px 8px';
				diffBtn.style.flexShrink = '0';
				diffBtn.addEventListener('click', () => {
					new DiffModal(this.app, item.filename, item.oldContent, item.newContent).open();
				});
			}

			if (item.status === 'new') {
				const previewBtn = row.createEl('button', { text: '预览' });
				previewBtn.style.fontSize = '11px';
				previewBtn.style.padding = '2px 8px';
				previewBtn.style.flexShrink = '0';
				previewBtn.addEventListener('click', () => {
					new DiffModal(this.app, item.filename, '', item.newContent).open();
				});
			}
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ==================== 差异对比弹窗 ====================

class DiffModal extends Modal {
	filename: string;
	oldContent: string;
	newContent: string;

	constructor(app: App, filename: string, oldContent: string, newContent: string) {
		super(app);
		this.filename = filename;
		this.oldContent = oldContent;
		this.newContent = newContent;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: `文件对比: ${this.filename}` });

		// 说明
		const desc = contentEl.createEl('p', {
			text: '红色为删除的内容，绿色为新增的内容',
			cls: 'setting-item-description',
		});
		desc.style.marginBottom = '15px';

		// 对比容器
		const diffContainer = contentEl.createDiv();
		diffContainer.style.maxHeight = '400px';
		diffContainer.style.overflow = 'auto';
		diffContainer.style.border = '1px solid var(--background-modifier-border)';
		diffContainer.style.borderRadius = '4px';
		diffContainer.style.fontFamily = 'monospace';
		diffContainer.style.fontSize = '12px';
		diffContainer.style.lineHeight = '1.5';

		// 计算差异
		const diff = this.computeDiff(this.oldContent, this.newContent);

		// 渲染差异
		diff.forEach(part => {
			const line = diffContainer.createDiv();
			line.style.padding = '2px 8px';
			line.style.whiteSpace = 'pre-wrap';
			line.style.wordBreak = 'break-all';

			if (part.added) {
				line.style.backgroundColor = 'rgba(0, 255, 0, 0.1)';
				line.style.color = '#2ea043';
				line.textContent = `+ ${part.value}`;
			} else if (part.removed) {
				line.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
				line.style.color = '#f85149';
				line.textContent = `- ${part.value}`;
			} else {
				line.style.color = 'var(--text-muted)';
				line.textContent = `  ${part.value}`;
			}
		});

		// 按钮区域
		const buttonContainer = contentEl.createDiv();
		buttonContainer.style.marginTop = '20px';
		buttonContainer.style.display = 'flex';
		buttonContainer.style.gap = '10px';

		// 查看文件按钮
		const viewBtn = buttonContainer.createEl('button', { text: '在笔记中查看' });
		viewBtn.addEventListener('click', () => {
			const folderPath = normalizePath(
				(this.app as any).plugins.plugins['notion-database-sync']?.settings?.syncFolder || 'Notion Sync'
			);
			const filePath = normalizePath(`${folderPath}/${this.filename}.md`);
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				this.app.workspace.openLinkText(filePath, '');
				this.close();
			}
		});

		// 关闭按钮
		const closeBtn = buttonContainer.createEl('button', { text: '关闭', cls: 'mod-cta' });
		closeBtn.addEventListener('click', () => {
			this.close();
		});
	}

	// 简单的行级差异计算
	computeDiff(oldText: string, newText: string): { value: string; added?: boolean; removed?: boolean }[] {
		const oldLines = oldText.split('\n');
		const newLines = newText.split('\n');
		const result: { value: string; added?: boolean; removed?: boolean }[] = [];

		let i = 0, j = 0;
		while (i < oldLines.length || j < newLines.length) {
			if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
				// 相同的行
				result.push({ value: oldLines[i] });
				i++;
				j++;
			} else if (j < newLines.length && (i >= oldLines.length || !oldLines.slice(i).includes(newLines[j]))) {
				// 新增的行
				result.push({ value: newLines[j], added: true });
				j++;
			} else if (i < oldLines.length) {
				// 删除的行
				result.push({ value: oldLines[i], removed: true });
				i++;
			} else {
				// 剩余的新增行
				result.push({ value: newLines[j], added: true });
				j++;
			}
		}

		return result;
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ==================== 同步结果弹窗 ====================

class SyncResultModal extends Modal {
	result: SyncResult;

	constructor(app: App, result: SyncResult) {
		super(app);
		this.result = result;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: '同步结果' });

		// 统计信息
		const statsDiv = contentEl.createDiv();
		statsDiv.style.marginBottom = '20px';
		statsDiv.createEl('p', { text: `✅ 新增: ${this.result.created.length} 个文件` });
		statsDiv.createEl('p', { text: `📝 更新: ${this.result.updated.length} 个文件` });
		statsDiv.createEl('p', { text: `⏭️ 未变更: ${this.result.unchanged} 个文件` });
		statsDiv.createEl('p', { text: `⏭️ 跳过: ${this.result.skipped} 个文件` });

		// 新增文件列表
		if (this.result.created.length > 0) {
			contentEl.createEl('h3', { text: '📄 新增文件' });
			const createdList = contentEl.createEl('ul');
			this.result.created.forEach(filename => {
				const li = createdList.createEl('li');
				li.style.display = 'flex';
				li.style.alignItems = 'center';
				li.style.gap = '10px';

				li.createSpan({ text: filename });

				// 查看按钮
				const viewBtn = li.createEl('button', { text: '查看' });
				viewBtn.style.fontSize = '12px';
				viewBtn.style.padding = '2px 8px';
				viewBtn.addEventListener('click', () => {
					const folderPath = normalizePath(
						(this.app as any).plugins.plugins['notion-database-sync']?.settings?.syncFolder || 'Notion Sync'
					);
					const filePath = normalizePath(`${folderPath}/${filename}.md`);
					const file = this.app.vault.getAbstractFileByPath(filePath);
					if (file instanceof TFile) {
						this.app.workspace.openLinkText(filePath, '');
						this.close();
					}
				});
			});
		}

		// 更新文件列表
		if (this.result.updated.length > 0) {
			contentEl.createEl('h3', { text: '🔄 更新文件' });
			const updatedList = contentEl.createEl('ul');
			this.result.updated.forEach(({ filename, oldContent, newContent }) => {
				const li = updatedList.createEl('li');
				li.style.display = 'flex';
				li.style.alignItems = 'center';
				li.style.gap = '10px';

				li.createSpan({ text: filename });

				// 对比按钮
				const diffBtn = li.createEl('button', { text: '对比' });
				diffBtn.style.fontSize = '12px';
				diffBtn.style.padding = '2px 8px';
				diffBtn.addEventListener('click', () => {
					new DiffModal(this.app, filename, oldContent, newContent).open();
				});

				// 查看按钮
				const viewBtn = li.createEl('button', { text: '查看' });
				viewBtn.style.fontSize = '12px';
				viewBtn.style.padding = '2px 8px';
				viewBtn.addEventListener('click', () => {
					const folderPath = normalizePath(
						(this.app as any).plugins.plugins['notion-database-sync']?.settings?.syncFolder || 'Notion Sync'
					);
					const filePath = normalizePath(`${folderPath}/${filename}.md`);
					const file = this.app.vault.getAbstractFileByPath(filePath);
					if (file instanceof TFile) {
						this.app.workspace.openLinkText(filePath, '');
						this.close();
					}
				});
			});
		}

		// 关闭按钮
		const closeBtn = contentEl.createEl('button', { text: '关闭', cls: 'mod-cta' });
		closeBtn.style.marginTop = '20px';
		closeBtn.addEventListener('click', () => {
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// 模板文件选择模态框
class TemplateFileSuggestModal extends Modal {
	onSelect: (file: TFile) => void;

	constructor(app: App, onSelect: (file: TFile) => void) {
		super(app);
		this.onSelect = onSelect;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('选择模板文件');

		// 获取所有 markdown 文件
		const files = this.app.vault.getMarkdownFiles();

		// 创建文件列表
		const listEl = contentEl.createDiv('template-file-list');
		listEl.style.maxHeight = '400px';
		listEl.style.overflow = 'auto';

		if (files.length === 0) {
			listEl.createEl('p', { text: '没有找到 Markdown 文件' });
			return;
		}

		// 按路径排序
		files.sort((a, b) => a.path.localeCompare(b.path));

		files.forEach((file) => {
			const itemEl = listEl.createDiv('template-file-item');
			itemEl.style.padding = '8px 12px';
			itemEl.style.cursor = 'pointer';
			itemEl.style.borderRadius = '4px';
			itemEl.style.marginBottom = '4px';

			// 鼠标悬停效果
			itemEl.addEventListener('mouseenter', () => {
				itemEl.style.backgroundColor = 'var(--background-modifier-hover)';
			});
			itemEl.addEventListener('mouseleave', () => {
				itemEl.style.backgroundColor = '';
			});

			// 文件名和路径
			const nameEl = itemEl.createDiv('template-file-name');
			nameEl.style.fontWeight = '500';
			nameEl.textContent = file.name;

			const pathEl = itemEl.createDiv('template-file-path');
			pathEl.style.fontSize = '0.85em';
			pathEl.style.color = 'var(--text-muted)';
			pathEl.textContent = file.path;

			// 点击选择
			itemEl.addEventListener('click', () => {
				this.onSelect(file);
				this.close();
			});
		});

		// 添加搜索框
		const searchContainer = contentEl.createDiv('search-container');
		searchContainer.style.marginBottom = '12px';
		const searchInput = searchContainer.createEl('input', {
			type: 'text',
			placeholder: '搜索文件...',
		});
		searchInput.style.width = '100%';
		searchInput.style.padding = '8px';

		searchInput.addEventListener('input', (e) => {
			const query = (e.target as HTMLInputElement).value.toLowerCase();
			const items = listEl.querySelectorAll('.template-file-item');
			items.forEach((item) => {
				const path = item.querySelector('.template-file-path')?.textContent || '';
				const name = item.querySelector('.template-file-name')?.textContent || '';
				if (path.toLowerCase().includes(query) || name.toLowerCase().includes(query)) {
					(item as HTMLElement).style.display = 'block';
				} else {
					(item as HTMLElement).style.display = 'none';
				}
			});
		});

		// 将搜索框插入到列表之前
		contentEl.insertBefore(searchContainer, listEl);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ==================== 设置页面 ====================

class NotionSyncSettingTab extends PluginSettingTab {
	plugin: NotionSyncPlugin;
	propertyMappingsContainer: HTMLElement;
	syncRulesContainer: HTMLElement;

	constructor(app: App, plugin: NotionSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Notion Database Sync 设置' });

		// 基础配置
		containerEl.createEl('h3', { text: '基础配置' });

		new Setting(containerEl)
			.setName('Notion Token')
			.setDesc('你的 Notion Integration Token')
			.addText((text) =>
				text
					.setPlaceholder('secret_xxx')
					.setValue(this.plugin.settings.notionToken)
					.onChange(async (value) => {
						this.plugin.settings.notionToken = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Database ID')
			.setDesc('要同步的 Notion 数据库 ID')
			.addText((text) =>
				text
					.setPlaceholder('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
					.setValue(this.plugin.settings.databaseId)
					.onChange(async (value) => {
						this.plugin.settings.databaseId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('同步文件夹')
			.setDesc('同步文件保存的文件夹路径')
			.addText((text) =>
				text
					.setPlaceholder('Notion Sync')
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncFolder = value.trim() || 'Notion Sync';
						await this.plugin.saveSettings();
					})
			);

		// 测试连接（放在基础配置区域内）
		const testConnectionSetting = new Setting(containerEl)
			.setName('测试连接')
			.setDesc('验证 Notion Token 和 Database ID 是否配置正确');

		const testStatusEl = testConnectionSetting.descEl.createSpan();
		testStatusEl.style.marginLeft = '8px';

		testConnectionSetting.addButton((button) =>
			button
				.setButtonText('测试连接')
				.onClick(async () => {
					button.setButtonText('连接中...');
					button.setDisabled(true);
					testStatusEl.textContent = '';

					const result = await this.testConnection();

					if (result.success) {
						testStatusEl.textContent = ` ✅ ${result.message}`;
						testStatusEl.style.color = '#2ea043';
					} else {
						testStatusEl.textContent = ` ❌ ${result.message}`;
						testStatusEl.style.color = '#f85149';
					}

					button.setButtonText('测试连接');
					button.setDisabled(false);
				})
		);

		// 文件名配置
		containerEl.createEl('h3', { text: '文件名配置' });

		new Setting(containerEl)
			.setName('文件名属性')
			.setDesc('使用哪个 Notion 属性作为文件名（默认为标题）')
			.addText((text) =>
				text
					.setPlaceholder('title')
					.setValue(this.plugin.settings.filenameProperty)
					.onChange(async (value) => {
						this.plugin.settings.filenameProperty = value.trim() || 'title';
						await this.plugin.saveSettings();
					})
			);

		// 属性映射配置
		containerEl.createEl('h3', { text: '属性映射配置' });

		containerEl.createEl('p', {
			text: '点击"刷新属性"获取 Notion 数据库的属性列表',
		});

		new Setting(containerEl)
			.setName('获取数据库属性')
			.setDesc('从 Notion 数据库获取最新的属性列表')
			.addButton((button) =>
				button
					.setButtonText('刷新属性')
					.onClick(async () => {
						await this.refreshProperties();
					})
			);

		this.propertyMappingsContainer = containerEl.createDiv('property-mappings-container');
		this.renderPropertyMappings();

		// 同步规则配置
		containerEl.createEl('h3', { text: '同步规则配置' });

		containerEl.createEl('p', {
			text: '配置同步判定规则，只有满足所有规则的记录才会被同步',
		});

		new Setting(containerEl)
			.setName('添加同步规则')
			.setDesc('添加一条新的同步判定规则')
			.addButton((button) =>
				button
					.setButtonText('添加规则')
					.onClick(async () => {
						this.plugin.settings.syncRules.push({
							property: '',
							condition: 'notEmpty',
						});
						await this.plugin.saveSettings();
						this.renderSyncRules();
					})
			);

		this.syncRulesContainer = containerEl.createDiv('sync-rules-container');
		this.renderSyncRules();

		// 文件模板配置
		containerEl.createEl('h3', { text: '文件模板配置' });

		// 模板文件选择
		const templateFileSetting = new Setting(containerEl)
			.setName('模板文件')
			.setDesc('选择本地仓库中的文件作为模板（可选）。如果设置了模板文件，将优先使用文件内容而不是下方文本框中的模板。')
			.addText((text) => {
				text
					.setPlaceholder('未选择文件')
					.setValue(this.plugin.settings.templateFilePath)
					.onChange(async (value) => {
						this.plugin.settings.templateFilePath = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.style.width = '250px';
			})
			.addButton((button) => {
				button
					.setButtonText('选择文件')
					.onClick(() => {
						new TemplateFileSuggestModal(this.app, (file) => {
							this.plugin.settings.templateFilePath = file.path;
							this.plugin.saveSettings();
							// 更新文本框显示
							templateFileSetting.controlEl.querySelector('input')!.value = file.path;
						}).open();
					});
			})
			.addButton((button) => {
				button
					.setButtonText('清除')
					.onClick(async () => {
						this.plugin.settings.templateFilePath = '';
						await this.plugin.saveSettings();
						templateFileSetting.controlEl.querySelector('input')!.value = '';
					});
			});

		new Setting(containerEl)
			.setName('默认文件模板')
			.setDesc('使用 {{变量名}} 作为模板变量，{{frontmatter}} 表示所有启用的属性，{{title}} 表示标题，{{content}} 表示内容占位符。当未设置模板文件时使用此模板。')
			.addTextArea((text) => {
				text
					.setPlaceholder('---\n{{frontmatter}}\n---\n\n# {{title}}\n\n{{content}}')
					.setValue(this.plugin.settings.fileTemplate)
					.onChange(async (value) => {
						this.plugin.settings.fileTemplate = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 6;
				text.inputEl.style.width = '100%';
			});

	}

	async refreshProperties(): Promise<void> {
		const properties = await this.plugin.fetchDatabaseProperties();
		if (!properties) {
			new Notice('获取属性失败，请检查 Token 和 Database ID');
			return;
		}

		const existingMappings = new Map(
			this.plugin.settings.propertyMappings.map(m => [m.notionProperty, m])
		);

		this.plugin.settings.propertyMappings = Object.entries(properties).map(([name, prop]: [string, any]) => {
			const existing = existingMappings.get(name);
			return {
				notionProperty: name,
				notionType: prop.type,
				obsidianProperty: existing?.obsidianProperty || name.toLowerCase().replace(/\s+/g, '_'),
				enabled: existing?.enabled ?? true,
				isTemplateVariable: existing?.isTemplateVariable ?? true,
			};
		});

		await this.plugin.saveSettings();
		this.renderPropertyMappings();
		new Notice(`已获取 ${Object.keys(properties).length} 个属性`);
	}

	renderPropertyMappings(): void {
		this.propertyMappingsContainer.empty();

		if (this.plugin.settings.propertyMappings.length === 0) {
			this.propertyMappingsContainer.createEl('p', {
				text: '暂无属性映射，请先点击"刷新属性"获取数据库属性',
				cls: 'setting-item-description',
			});
			return;
		}

		const headerRow = this.propertyMappingsContainer.createDiv('property-mapping-header');
		headerRow.style.display = 'grid';
		headerRow.style.gridTemplateColumns = '2fr 1.5fr 80px 100px 60px';
		headerRow.style.gap = '8px';
		headerRow.style.padding = '8px';
		headerRow.style.fontWeight = 'bold';
		headerRow.style.borderBottom = '1px solid var(--background-modifier-border)';

		headerRow.createSpan({ text: 'Notion 属性' });
		headerRow.createSpan({ text: 'Obsidian 属性' });
		headerRow.createSpan({ text: '类型' });
		headerRow.createSpan({ text: '同步' });
		headerRow.createSpan({ text: '模板' });

		this.plugin.settings.propertyMappings.forEach((mapping, index) => {
			const row = this.propertyMappingsContainer.createDiv('property-mapping-row');
			row.style.display = 'grid';
			row.style.gridTemplateColumns = '2fr 1.5fr 80px 100px 60px';
			row.style.gap = '8px';
			row.style.padding = '8px';
			row.style.borderBottom = '1px solid var(--background-modifier-border)';
			row.style.alignItems = 'center';

			row.createSpan({ text: mapping.notionProperty });

			const obsidianInput = row.createEl('input', {
				type: 'text',
				value: mapping.obsidianProperty,
			});
			obsidianInput.style.width = '100%';
			obsidianInput.addEventListener('change', async (e) => {
				this.plugin.settings.propertyMappings[index].obsidianProperty = (e.target as HTMLInputElement).value;
				await this.plugin.saveSettings();
			});

			row.createSpan({ 
				text: mapping.notionType,
				cls: 'setting-item-description',
			});

			const enabledContainer = row.createDiv();
			enabledContainer.style.display = 'flex';
			enabledContainer.style.alignItems = 'center';
			const enabledToggle = enabledContainer.createEl('input', {
				type: 'checkbox',
			});
			enabledToggle.checked = mapping.enabled;
			enabledToggle.addEventListener('change', async (e) => {
				this.plugin.settings.propertyMappings[index].enabled = (e.target as HTMLInputElement).checked;
				await this.plugin.saveSettings();
			});

			const templateContainer = row.createDiv();
			templateContainer.style.display = 'flex';
			templateContainer.style.alignItems = 'center';
			const templateToggle = templateContainer.createEl('input', {
				type: 'checkbox',
			});
			templateToggle.checked = mapping.isTemplateVariable;
			templateToggle.addEventListener('change', async (e) => {
				this.plugin.settings.propertyMappings[index].isTemplateVariable = (e.target as HTMLInputElement).checked;
				await this.plugin.saveSettings();
			});
		});

		const desc = this.propertyMappingsContainer.createEl('p', {
			text: '同步：是否在 Obsidian 中同步此属性 | 模板：是否可在文件模板中作为变量使用',
			cls: 'setting-item-description',
		});
		desc.style.marginTop = '8px';
		desc.style.fontSize = '12px';
	}

	renderSyncRules(): void {
		this.syncRulesContainer.empty();

		if (this.plugin.settings.syncRules.length === 0) {
			this.syncRulesContainer.createEl('p', {
				text: '暂无同步规则，所有记录都会被同步',
				cls: 'setting-item-description',
			});
			return;
		}

		const availableProperties = this.plugin.settings.propertyMappings.map(m => m.notionProperty);

		this.plugin.settings.syncRules.forEach((rule, index) => {
			const row = this.syncRulesContainer.createDiv('sync-rule-row');
			row.style.display = 'flex';
			row.style.gap = '8px';
			row.style.padding = '8px';
			row.style.borderBottom = '1px solid var(--background-modifier-border)';
			row.style.alignItems = 'center';
			row.style.flexWrap = 'wrap';

			const propertySelect = row.createEl('select');
			propertySelect.style.width = '150px';
			propertySelect.add(new Option('选择属性', ''));
			availableProperties.forEach(prop => {
				propertySelect.add(new Option(prop, prop));
			});
			propertySelect.value = rule.property;
			propertySelect.addEventListener('change', async (e) => {
				this.plugin.settings.syncRules[index].property = (e.target as HTMLSelectElement).value;
				await this.plugin.saveSettings();
			});

			const conditionSelect = row.createEl('select');
			conditionSelect.style.width = '120px';
			const conditions: { value: SyncRule['condition']; label: string }[] = [
				{ value: 'equals', label: '等于' },
				{ value: 'notEmpty', label: '不为空' },
				{ value: 'isTrue', label: '为真' },
				{ value: 'isFalse', label: '为假' },
			];
			conditions.forEach(c => {
				conditionSelect.add(new Option(c.label, c.value));
			});
			conditionSelect.value = rule.condition;
			conditionSelect.addEventListener('change', async (e) => {
				this.plugin.settings.syncRules[index].condition = (e.target as HTMLSelectElement).value as SyncRule['condition'];
				await this.plugin.saveSettings();
				this.renderSyncRules();
			});

			if (rule.condition === 'equals') {
				const valueInput = row.createEl('input', {
					type: 'text',
					value: rule.value || '',
					placeholder: '输入值',
				});
				valueInput.style.width = '120px';
				valueInput.addEventListener('change', async (e) => {
					this.plugin.settings.syncRules[index].value = (e.target as HTMLInputElement).value;
					await this.plugin.saveSettings();
				});
			}

			const deleteBtn = row.createEl('button', {
				text: '删除',
			});
			deleteBtn.addEventListener('click', async () => {
				this.plugin.settings.syncRules.splice(index, 1);
				await this.plugin.saveSettings();
				this.renderSyncRules();
			});
		});

		const desc = this.syncRulesContainer.createEl('p', {
			text: '只有满足所有规则的记录才会被同步到 Obsidian',
			cls: 'setting-item-description',
		});
		desc.style.marginTop = '8px';
		desc.style.fontSize = '12px';
	}

	async testConnection(): Promise<{ success: boolean; message: string }> {
		if (!this.plugin.notionClient) {
			const message = '请先配置 Notion Token';
			new Notice(message);
			return { success: false, message };
		}

		if (!this.plugin.settings.databaseId) {
			const message = '请先配置 Database ID';
			new Notice(message);
			return { success: false, message };
		}

		try {
			const response = await this.plugin.notionClient.databases.retrieve(this.plugin.settings.databaseId);
			const dbTitle = response.title?.[0]?.plain_text ?? '未命名';
			const message = `连接成功！数据库: ${dbTitle}`;
			new Notice(message);
			return { success: true, message };
		} catch (error) {
			console.error('Connection test error:', error);
			const message = `连接失败: ${error.message}`;
			new Notice(message);
			return { success: false, message };
		}
	}
}

