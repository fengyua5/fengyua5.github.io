# AGENTS.md

> 本文件为 AI 代理（Agent）提供项目上下文，帮助代理理解项目结构、技术栈和开发约定。

## 项目概述

**fengyua5.github.io** 是一个基于 Hexo 静态站点生成器构建的个人技术博客，使用 Yilia 主题，部署在 GitHub Pages 上。博客内容主要涵盖 React、CSS 等前端技术领域。

- **站点地址**: https://fengyua5.github.io/fengyua5.github.io
- **仓库**: GitHub (`fengyua5/fengyua5.github.io`)
- **部署方式**: GitHub Actions 自动构建并部署到 GitHub Pages

## 工作流

**写 Markdown → 运行 `hexo generate` → 生成 HTML 到 `public/`**

```bash
npm install          # 安装依赖（首次）
npm start            # 启动本地预览服务器 (http://localhost:4000)
npm run build        # 生成静态文件到 public/
npm run clean        # 清理缓存和 public/
npm run new -- "文章标题"  # 新建文章
```

文章源文件放在 `source/_posts/` 目录下，为 Markdown 格式（带 front-matter）。`hexo generate` 会将它们编译为静态 HTML 页面。

### 新建文章

```bash
npm run new -- "我的新文章"
```

会在 `source/_posts/我的新文章.md` 创建文件，编辑该 Markdown 文件即可。完成后运行 `npm run build` 生成 HTML。

## 技术栈

### 核心框架与工具

| 技术 | 版本 | 用途 |
|------|------|------|
| **Hexo** | ^7.3.0 | 静态站点生成器，将 Markdown 编译为静态 HTML |
| **hexo-theme-yilia** | from GitHub (litten) | 博客主题，提供页面布局与交互 |
| **Node.js** | ^22 | 运行时环境 |

### Hexo 插件

| 插件 | 用途 |
|------|------|
| `hexo-renderer-marked` | Markdown → HTML 渲染器 |
| `hexo-renderer-ejs` | EJS 模板渲染器（主题布局） |
| `hexo-renderer-stylus` | Stylus CSS 预处理器渲染器 |
| `hexo-generator-index` | 首页文章列表生成 |
| `hexo-generator-archive` | 归档页面生成 |
| `hexo-generator-category` | 分类页面生成 |
| `hexo-generator-tag` | 标签页面生成 |
| `hexo-generator-json-content` | 生成 content.json（主题搜索功能依赖） |
| `hexo-deployer-git` | Git 部署插件 |

### 前端运行时依赖（Yilia 主题内置）

| 库 | 用途 |
|----|------|
| **Q.js** | 轻量 MVVM 框架（Vue.js 启发），驱动搜索、侧边栏交互 |
| **PhotoSwipe** | 图片灯箱/画廊组件 |
| **BJ_REPORT** | 前端错误监控 |
| **es6-promise** | Promise polyfill |

### CI/CD

- **GitHub Actions** (`.github/workflows/ci.yml`)
  - 触发条件: push 到 `master` 分支
  - 构建流程: `npm install && npx hexo generate`
  - 部署工具: `JamesIves/github-pages-deploy-action`
  - 部署目录: `public/`

## 项目结构

```
fengyua5.github.io/
├── .github/workflows/
│   └── ci.yml                   # GitHub Actions CI/CD 配置
├── source/
│   └── _posts/                  # ★ 博客文章源文件（Markdown）
│       ├── React组件之间的交流.md
│       ├── css之易错点.md
│       ├── react优化.md
│       └── react学习注意.md
├── scaffolds/
│   └── post.md                  # 新建文章的模板
├── themes/
│   └── yilia/                   # Yilia 主题（从 GitHub 克隆）
│       ├── _config.yml          # 主题配置
│       ├── layout/              # EJS 模板
│       └── source/              # 主题静态资源
├── _config.yml                  # Hexo 主配置
├── package.json                 # 项目依赖与脚本
├── .gitignore
├── public/                      # hexo generate 产物（.gitignore 忽略）
└── AGENTS.md                    # 本文件
```

### _config.yml 关键配置

- `permalink: :year/:month/:day/:title/` — 文章 URL 格式
- `theme: yilia` — 使用 Yilia 主题
- `deploy` — Git 部署配置
- `jsonContent` — 搜索功能所需的 JSON 内容生成配置

### 文章 Front-matter 格式

```yaml
---
title: 文章标题
date: 2017-03-11 10:05:59
categories:
  - react
---

正文内容...

<!-- more -->  <!-- 首页摘要截断标记 -->
```

## 注意事项

1. **文章文件名使用英文**：`source/_posts/` 下新建文章的文件名必须用英文（小写、连字符分隔，如 `deepseek-codex-native-integration.md`），不要出现中文。中文标题只写在 front-matter 的 `title` 字段里。
2. **直接编辑 Markdown 文件**：在 `source/_posts/` 下创建或编辑 `.md` 文件，然后运行 `npm run build` 生成 HTML。不要直接编辑 `public/` 下的 HTML 产物。
3. **根目录的旧 HTML 文件**：`index.html`、`main.*.js`、`mobile.*.js`、`slider.*.js` 等是早期直接提交的生成产物。现在使用 Hexo 标准工作流后，生成产物在 `public/` 目录中，根目录的旧文件可以后续清理。
4. **主题**：`themes/` 下有两个主题，**当前 `_config.yml` 生效的是 `flatpaper`**（`theme: flatpaper`），`yilia` 是早期主题，仅作历史保留。改样式前先确认改的是哪个主题。
5. **package.json 中的 hexo 字段**：`"hexo": { "version": "7.3.0" }` 是必需的，Hexo 依赖它来判断是否加载配置。

## 已知坑：配图放错目录会触发 hover 抖动

flatpaper 主题在 `themes/flatpaper/source/css/_partials/_mode/code-dark.styl:433` 有一条：

```styl
.article-content img:not([src*="/covers/"]):hover,
.article-content img:not([src*="/covers/"]):focus-visible {
  box-shadow: 5px 5px 0 rgba(var(--paper-shadow-rgb), 0.1);
  transform: translate(-5px, -5px);
}
```

这是给**正文小插图**做的"拍立得浮起"效果：鼠标划过时平移 5px + 右下错位阴影。它对小图好看，但对**文章顶部大图 / 封面图**就是灾难——一整张大图跟着鼠标上下抖，阴影还会溢出卡片边缘，看起来像页面在跳。

主题用 `:not([src*="/covers/"])` 做了排除，所以规则是：

| 图片类型 | 存放位置 | 引用路径 | hover 效果 |
|---|---|---|---|
| 封面图、文章顶部大图 | `source/img/covers/` | `/img/covers/xxx.jpg` | 无（正确） |
| 正文小插图、示意图 | `source/img/` | `/img/xxx.jpg` | 浮起（正确） |

**写新文章时：任何宽度接近正文满宽的大图，一律放 `source/img/covers/`。** 否则就会出现"鼠标一划过封面图，整页抖一下"的 bug。

历史遗留（仍存在该问题，未修）：`source/img/mcp-purpose.jpg`、`source/img/deepseek-0731.jpg` 放在 `/img/` 根目录。

发布前自检：

```bash
# 文章里引用的图片，src 是满宽大图却不在 /covers/ 下 → 有问题
grep -n '^!\[' source/_posts/<文章>.md
```

## 内容分类

博客文章按技术分类组织：

- **react**: React 组件通信、React 性能优化、React 学习注意事项
- **css**: CSS 布局易错点
