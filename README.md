# Notion Database Sync

将 Notion 数据库记录同步到 Obsidian 笔记的插件。支持属性映射、同步规则过滤、模板文件、同步中心预览等功能，让你的 Notion 数据库与 Obsidian 笔记无缝衔接。

👇 演示视频



## 功能特性

### 📋 同步中心

调用同步命令后，插件会先从 Notion 获取数据并预分析，弹出**同步中心**弹窗，展示所有满足条件的记录：

- 分类展示：🆕 新增 / 📝 更新 / ✅ 未变更
- 支持勾选要同步的文件，默认选中新增和更新项
- 快捷操作：全选、取消全选、仅选新增、仅选更新
- 更新文件可点击「对比」查看新旧内容差异
- 新增文件可点击「预览」查看将要生成的内容
- 确认后点击「开始同步」执行同步

> 📸 *同步中心弹窗界面*

<img width="848" height="476" alt="image" src="https://github.com/user-attachments/assets/73982339-0719-42ab-a662-cfcf17455f13" />


### 🔗 基础配置

- 配置 Notion Integration Token 和 Database ID
- 一键测试连接，验证配置是否正确
- 自定义同步文件保存的文件夹路径

> 📸 *设置页面的基础配置区域*

<img width="792" height="400" alt="image" src="https://github.com/user-attachments/assets/a6ea3d8d-76b5-40bb-abc1-16dd0c9b8c39" />


### 🗂️ 属性映射

- 点击「刷新属性」自动获取 Notion 数据库的属性列表
- 支持 Notion 属性名与 Obsidian 属性名的自定义映射
- 可单独控制每个属性是否同步、是否作为模板变量
- 支持 **relation 类型自动解析关联页面标题**（而非仅显示 ID）
- 支持 **files 类型提取文件 URL**（如封面图片）

> 📸 *属性映射配置表格*

<img width="796" height="580" alt="image" src="https://github.com/user-attachments/assets/a21321f3-9266-4f17-b394-2bde48f568ab" />


### 📏 同步规则

- 支持添加多条同步判定规则
- 支持条件：等于、不为空、为真、为假
- 只有满足**所有规则**的记录才会被同步
- 例如：只同步 `year` 等于 `2026` 且 `start-date` 不为空的记录

> 📸 *同步规则配置区域*

<img width="796" height="289" alt="image" src="https://github.com/user-attachments/assets/ee712b2f-4036-4930-b8a5-43e47ef2bc93" />


### 📄 文件模板

插件支持两种模板模式：

#### 模式一：使用 `{{frontmatter}}` 占位符

在模板中使用 `{{frontmatter}}`，插件会自动生成所有启用属性的 YAML frontmatter：

```markdown
---
{{frontmatter}}
---

# {{title}}

{{content}}
```

#### 模式二：直接在模板中定义属性（推荐）

在模板文件中直接写好 frontmatter 属性名，插件会**智能识别并用 Notion 数据覆盖对应属性值**，同时保留模板中未映射的属性：

```yaml
---
ISBN:
country:
author:
tags:
  - 这世界/阅读
type: books
cover: https://img.example.com/books/{{title}}.jpg
created: 2026-01-11 23:59
---
```

**模板特性**：
- 支持选择本地仓库中的 `.md` 文件作为模板
- 模板中的 `{{title}}` 等变量会被自动替换
- 列表类型属性（如 `tags`）会与模板默认值**合并去重**
- 模板中未被 Notion 映射的属性（如 `type`、`created`）会被保留

> 📸 *模板文件配置区域*

<img width="807" height="305" alt="image" src="https://github.com/user-attachments/assets/35fc5001-5020-4dfa-a2df-a1ee9f799481" />


### 📊 同步结果

同步完成后展示详细结果：

- 统计信息：新增、更新、未变更、跳过的文件数量
- 新增文件列表：可直接点击查看
- 更新文件列表：可点击「对比」查看差异，或点击「查看」打开文件
- 差异对比：行级对比，绿色为新增内容，红色为删除内容

> 📸 *同步结果弹窗*

<img width="556" height="551" alt="image" src="https://github.com/user-attachments/assets/0c6ba02f-3dab-4cc7-bb56-24b0a3381682" />


### 🧩 Frontmatter 格式

生成的 frontmatter 严格遵循 Obsidian Properties 规范：

- **URL** 直接输出，不加引号：`url: https://example.com`
- **多行文本** 使用 YAML 块标量语法：`comment: |`
- **日期时间** 格式化为 Obsidian 友好格式：`2026-02-10 07:40`
- **列表** 使用标准 YAML 列表格式：
  ```yaml
  tags:
    - tag1
    - tag2
  ```
- **数字** 直接输出，不加引号：`score: 7.9`
- 仅在必要时（YAML 保留字、特殊字符等）才使用引号包裹

## 支持的 Notion 属性类型

| 类型 | 说明 | 输出示例 |
|------|------|----------|
| `title` | 标题 | `我的笔记` |
| `rich_text` | 富文本 | `这是一段文本` |
| `number` | 数字 | `7.9` |
| `select` | 单选 | `小说文学` |
| `multi_select` | 多选 | YAML 列表格式 |
| `checkbox` | 复选框 | `true` / `false` |
| `url` | 链接 | `https://example.com` |
| `email` | 邮箱 | `user@example.com` |
| `phone_number` | 电话 | `+86 138xxxx` |
| `date` | 日期 | `2026-01-30` |
| `status` | 状态 | `进行中` |
| `formula` | 公式 | 自动识别返回类型 |
| `rollup` | 汇总 | 自动提取数组/单值 |
| `relation` | 关联 | **自动解析为页面标题** |
| `files` | 文件 | 提取文件 URL |
| `created_time` | 创建时间 | `2026-01-11 23:59` |
| `last_edited_time` | 最后编辑时间 | `2026-02-10 07:40` |
| `created_by` | 创建者 | 用户名 |
| `last_edited_by` | 最后编辑者 | 用户名 |

## 安装方法

### 手动安装

1. 确保已安装 Node.js (v16+)
2. 克隆或下载本仓库
3. 在项目目录运行：
   ```bash
   npm install
   npm run build
   ```
4. 将以下文件复制到 Obsidian 插件目录 `.obsidian/plugins/notion-database-sync/`：
   - `main.js`
   - `manifest.json`
   - `styles.css`
5. 重启 Obsidian，在设置 → 第三方插件中启用 **Notion Database Sync**

### 插件目录位置

| 系统 | 路径 |
|------|------|
| macOS | `~/Documents/Obsidian Vault/.obsidian/plugins/notion-database-sync/` |
| Windows | `%USERPROFILE%\Documents\Obsidian Vault\.obsidian\plugins\notion-database-sync\` |
| Linux | `~/Documents/Obsidian Vault/.obsidian/plugins/notion-database-sync/` |

## 使用指南

### 第一步：获取 Notion Token

1. 访问 [Notion Integrations](https://www.notion.so/my-integrations)
2. 点击「New integration」创建一个新的集成
3. 复制生成的 Internal Integration Token（以 `ntn_` 或 `secret_` 开头）
4. 在 Notion 中打开目标数据库页面，点击右上角 `...` → 「Connections」→ 添加你创建的集成

### 第二步：获取 Database ID

从 Notion 数据库页面的 URL 中提取 Database ID：

```
https://www.notion.so/your-workspace/DATABASE_ID?v=xxx
                                      ^^^^^^^^^^^
                                      这部分就是 Database ID
```

### 第三步：配置插件

1. 打开 Obsidian 设置 → Notion Database Sync
2. 填写 Notion Token 和 Database ID
3. 点击「测试连接」验证配置
4. 设置同步文件夹路径（如 `2-areas/book/2026`）

> 📸 *填写 Token 和 Database ID 后点击测试连接*

### 第四步：配置属性映射

1. 点击「刷新属性」获取数据库属性列表
2. 根据需要调整 Obsidian 属性名称
3. 勾选要同步的属性和可作为模板变量的属性

### 第五步：配置模板（可选）

1. 在仓库中创建一个模板 `.md` 文件
2. 在设置中选择该文件作为模板
3. 模板中的属性名会被 Notion 数据自动填充

### 第六步：执行同步

1. 打开命令面板（`Ctrl/Cmd + P`）
2. 输入 `Sync Notion Database`
3. 在同步中心中勾选要同步的文件
4. 点击「开始同步」

> 📸 *命令面板中调用同步命令*

## 开发

```bash
# 安装依赖
npm install

# 开发模式（自动编译，文件变更时自动重新构建）
npm run dev

# 生产构建
npm run build
```

## 许可证

MIT License
