---
title: Skills 最佳实践
date: 2026-08-03 10:00:00
tags: [agent, skill, opencode, claude-code, best-practice]
categories: AI
---

Skill（技能）是 2025 年底 Agent 圈最热门的扩展方式。Anthropic 在 2025 年 12 月把 Agent Skills 开源成开放标准，Codex CLI、Cursor、Gemini CLI 先后跟进，一个 `SKILL.md` 可以在多个工具间通用。

但很多人把 `SKILL.md` 丢进目录就完事了——**它到底是什么时候被加载的？调用的时候长什么样？为什么我写的 skill 从来不触发？** 这篇文章以 opencode 和 Claude Code 双视角拆开看，最后总结一份写 Skill 的最佳实践清单。

<!-- more -->

## 1. 全景：Skill 的四阶段生命周期

不管是 opencode 还是 Claude Code，一个 Skill 的生命周期都分四步：

1. **发现（Discovery）**：启动时扫描技能目录，收集每个 Skill 的元数据（`name` + `description`）
2. **注册（Registration）**：把元数据注入系统提示词 / 暴露成工具，告诉 Agent「我有这些技能可用」
3. **触发（Trigger）**：Agent 根据你的请求和 `description` 做语义匹配，决定是否调用
4. **执行（Execution）**：加载 `SKILL.md` 全文 + 相关资源，按指令执行任务

理解这四步的关键是：**元数据是「常驻的」，正文是「按需加载的」**。这个设计叫 **渐进式披露（Progressive Disclosure）**。

## 2. 什么时候加载？——渐进式披露

### 一级：会话启动，只注入元数据

启动时 Agent 读取所有 Skill 的 frontmatter（`name` + `description`），把它们放进系统提示词或工具定义里。此时 `SKILL.md` 的**正文完全不进场**，每个 Skill 只占约 100 tokens。

以 opencode 为例，每个 Skill 在启动时变成一个工具定义：

```
skill(openclaw): 管理 OpenClaw 小龙虾的配置与启动，处理多智能体编排、备份恢复、日志排查
skill(md-to-xiaohongshu): 把 Markdown 转成小红书图文稿，清除 Markdown 符号、加 emoji、按平台格式收尾
```

### 二级：描述匹配，加载正文

当你的请求与某个 Skill 的 `description` 语义匹配时，Agent 才会真正去读 `SKILL.md` 正文，注入上下文（约 1K-5K tokens）。

```
用户：把这篇 markdown 转成小红书文案
  └─ Agent 扫元数据，命中 md-to-xiaohongshu 的 description
      └─ 调用 skill({name: "md-to-xiaohongshu"})
          └─ 读取 SKILL.md 全文 → 注入上下文 → 按规则执行
```

### 三级：正文引用，按需读取资源

`SKILL.md` 里引用的 `references/`、`scripts/` 等配套文件，只在需要时读取——用到才加载，用不到零成本。

**结论：`description` 是唯一的触发开关，正文平时零成本。** 模糊的 description 意味着 Skill 永远不触发。

## 3. 调用现场长什么样？

### Claude Code：`Skill` 元工具 + 两条消息注入

Claude Code 把 Skill 实现为一个名为 `Skill` 的元工具（meta-tool）。模型发起工具调用 `Skill({command: "pdf"})` 后，系统会注入**两条用户消息**：

- 一条给用户看的可见元数据
- 一条带 `isMeta: true` 标记的隐藏指令（正文），用户在终端看不到，但模型能完整读到

> 这就是为什么你在终端只看到 `/pdf running...`，而背后的几千字指引已经进入模型上下文了。`isMeta` 解决了「UI 污染」问题。

### opencode：原生 `skill` 工具

opencode 的做法更直接：启动时把每个 Skill 注册成原生 `skill` 工具，模型在每一步对话时看到可用列表，匹配即调用：

```
skill({ name: "md-to-xiaohongshu" })
```

调用后才会把该 Skill 的完整内容（SKILL.md 正文 + frontmatter）加载进上下文。**没被调用的 Skill 永远不进入上下文**。

### 对照：Tools vs Skills vs Commands vs CLAUDE.md

| 机制 | 本质 | 谁触发 | 加载时机 |
|------|------|--------|----------|
| Tools | 执行具体动作（读文件、跑命令） | 模型 | 工具定义常驻，执行按需 |
| **Skills** | **注入指令、改变模型行为** | **模型（model-invoked）** | **元数据常驻，正文按需** |
| Commands（slash） | 用户主动触发的工作流 | 用户（`/xxx`） | 用户调用时 |
| CLAUDE.md | 项目级规则/事实 | 常驻 | **启动即全量加载** |

Skills 与 CLAUDE.md 的关键区别：**CLAUDE.md 每个会话都全量占用上下文，Skills 平时只有几十字元数据**。所以「长参考材料」应该做成 Skill，而不是塞进 CLAUDE.md。

## 4. Skill 的三个层级（作用域）

Skill 可以放在三个不同的位置，作用域完全不同：

| 层级 | opencode | Claude Code | 作用域 | 典型用途 |
|------|----------|-------------|--------|----------|
| **全局层**（用户级） | `~/.config/opencode/skills/` | `~/.claude/skills/` | 所有项目 | 通用工作流：提交信息规范、PDF 处理、通用审查清单 |
| **工具层**（插件/内置） | 插件 bundle 的 skills、`~/.agents/skills/` | Claude Code 内置 skills（如 `pdf`）、插件 skills | 随工具/插件分发，跨仓库可用 | 工具自带能力、第三方技能库 |
| **项目层** | `.opencode/skills/` | `.claude/skills/` | 仅当前项目 | 项目专属约定：md-to-xiaohongshu、本仓库规范 |

**同名冲突时，项目层 > 全局层 > 工具层**。

**怎么选？** 一套思路：

- 所有项目都用 → 放全局层
- 跟着工具/插件走、别人也能装 → 工具层
- 只对这个仓库有意义 → 项目层

## 5. 写 Skill 的最佳实践

### 5.1 frontmatter：两个必填字段

```yaml
---
name: md-to-xiaohongshu
description: 把 Markdown 转成小红书图文稿，清除 Markdown 符号、加 emoji、按平台格式收尾
---
```

- **`name`**：小写字母、数字、连字符；**必须和目录名一致**（`.opencode/skills/md-to-xiaohongshu/SKILL.md`）
- **`description`**：触发开关，必填

### 5.2 description 三要素写法

description 要回答三个问题：**做什么** + **什么时候用** + **怎么触发**。越具体越容易命中。

```yaml
# ❌ 模糊，几乎不触发
description: 处理小红书内容

# ✅ 具体，指明触发场景
description: |
  把 Markdown 文档转换为可直接发布到小红书的图文稿，清除 Markdown 符号、
  用 emoji 提升可读性、按平台格式收尾。当用户要求把 markdown/博客文章
  转成小红书文案时使用。
```

**判断标准：你读完 description 能立刻知道什么时候该用，Agent 才能知道。**

### 5.3 渐进式披露：SKILL.md 精简，细节放外面

- 主文件只放核心规则和流程
- 长参考材料 → `references/` 子目录
- 机械性的校验、解析、格式化 → `scripts/` 脚本（模型做判断，脚本做脏活）

### 5.4 一技能一事 + 权限控制

- 一个 Skill 只负责一件事，不要试图覆盖五个工作流
- 有副作用的操作（部署、发消息）用 `disable-model-invocation: true`，只允许用户 `/命令` 触发
- 需要特定工具的 Skill 用 `allowed-tools` 声明

### 5.5 自查清单

写完后逐条验证：

- [ ] `grep -c '\*\*' 输出文件` 为 0（无残留 Markdown 符号）
- [ ] description 里能读到触发场景
- [ ] name 与目录名一致、全小写连字符
- [ ] 正文没有塞大段参考文档（应放 references/）
- [ ] 实测触发一次，确认能命中

## 6. 真实案例复盘：md-to-xiaohongshu 的三个坑

我在自己的博客项目里写了一个 `md-to-xiaohongshu` skill，踩了三个典型坑：

**坑 1：description 太泛，Skill 不触发。** 最初描述是「处理小红书内容」，push 完成后怎么都不触发。改成「把 Markdown 文档转换为可直接发布到小红书的图文稿……当用户要求把 markdown/博客文章转成小红书文案时使用」才命中。

**坑 2：会话级缓存导致注册过期。** 把 skill 从全局层迁到项目层后，当前会话的注册表还指向旧路径，加载直接报错。**技能目录在会话启动时扫描，改了位置要重启会话。**

**坑 3：输出模板与规则自相矛盾。** skill 里规则写着「标题去掉 `#`」，输出模板却画着 `# {标题}`——模型照模板输出，标题带了一堆 `#`。**规则和模板必须一致，自查项要能 grep 验证。**

## 7. 结论 + 速查表

**一句话总结**：Skill 的本质是「**平时零成本的按需指令注入**」——启动只带元数据，触发才加载正文；`description` 决定是否触发，层级决定作用域。

| 维度 | 要点 |
|------|------|
| 加载时机 | 启动只注入元数据，触发才加载正文，资源按需读取 |
| 触发开关 | `description`，三要素：做什么 + 何时用 + 触发场景 |
| 三层级 | 全局 `~/.config/opencode/skills` / `~/.claude/skills`，工具（插件/内置），项目 `.opencode/skills` / `.claude/skills`；项目优先 |
| 与 CLAUDE.md | CLAUDE.md 常驻全量，Skill 按需加载，长参考用 Skill |
| 最佳实践 | 一技能一事、SKILL.md 精简、机械活放脚本、权限控制、grep 自查 |

想自己动手写一个？从「你反复粘贴到聊天里的那段流程」开始——它就该是一个 Skill。
