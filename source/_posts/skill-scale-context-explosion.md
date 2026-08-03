---
title: 装了 100 个 Skill 后，Agent 突然变笨了
date: 2026-08-03 15:30:00
tags: [agent, skill, opencode, claude-code, context-window, llm]
categories: AI
---

上一篇《[Skills 最佳实践](/2026/08/03/skill-loading-and-best-practices/)》讲了 Skill 的加载机制：**元数据常驻、正文按需加载**，结论是「Skill 平时只有几十字元数据，所以可以随便装」。

然后我就信了。一个、两个、十个……装了 50 多个 Skill，Agent 开始变笨了：反应变慢、该触发的 skill 不触发、偶尔还答非所问。上篇说的「零成本」去哪了？

这篇文章把账算清楚：**Skill 元数据确实是常驻的，100 个就是 10K tokens 起。** 以及社区为这个问题给出的六套解法。

<!-- more -->

## 1. 问题：100 个 Skill ≈ 10K tokens 常驻

回看加载机制：每次会话启动，Agent 把所有 Skill 的 `name + description` 注入系统提示词。上篇算过，一个 Skill 的元数据约 100 tokens。

于是成本就是纯乘法：

| Skill 数量 | 元数据体积（约） | 感受 |
|-----------|------------------|------|
| 10 个 | ~1K tokens | 无感 |
| 100 个 | ~10K tokens | 开始拖慢 |
| 500 个 | ~50K tokens | 明显变笨 |
| 1500 个 | ~150K tokens | 上下文直接爆掉 |

而且这是**每一轮对话都要重发**的。它不像正文那样「触发才加载」，元数据常驻意味着你问「今天天气」时，模型也要先读一遍那 10K tokens 的 Skill 清单。

**真实案例**（opencode issue #20647）：一位用户装了 1500 个 Skill，光元数据就吃掉约 **147K tokens**，占模型 262K 上下文窗口的 **56%**。模型一半的脑容量在记技能名，哪还有空间思考你问的问题？

## 2. 归因：为什么「常驻元数据」这么贵

要解决问题，先看清它贵在哪：

1. **全量注入**：不管用不用得上，全部 Skill 的 description 一个不落进 system prompt。描述写得越长，每个 Skill 的 100 tokens 越接近 200-300。
2. **每轮重发**：system prompt 属于「固定前缀」，但很多工具会整段重发，而不是只发增量。token 数不变，成本每轮都付。
3. **上下文挤压**：模型可用的上下文是一块固定蛋糕。Skill 元数据 + CLAUDE.md + 工具定义 + 历史对话都在抢，抢走 56% 之后，留给推理和答案的空间就少了。
4. **注意力稀释**：1500 个 description 摆在那，模型在语义匹配时更容易「眼花」，该触发的 skill 匹配错或漏掉——这解释了「装了越多越不触发」。

一句话：**渐进式披露只保护了正文，没保护元数据。** 元数据本身成为新的膨胀点。

## 3. 解法全景：六套方案，从轻到重

### 3.1 精简 description（零成本，先做）

最简单的一招：**description 越短越好**。很多 skill 把整段操作步骤写进 description，触发只需要三要素：做什么 + 何时用 + 触发场景。把多余的话删掉，100 tokens 能压到 50。

配合上篇的「渐进式披露」：细节放 `references/`、机械活放 `scripts/`，正文别长，description 更别长。

**这一个动作能省一半元数据体积，成本为零。**

### 3.2 技能路由：低频 Skill 不进扫描目录（改配置）

把「不常用」的 Skill 移出自动扫描目录（如 `~/.config/opencode/skills/`），换成手动查询。做法是保留一个常驻的 **skill-router**（路由 Skill）：它自己不装技能，而是用 grep 按需搜索其他 Skill 的 description。

```
用户：处理一下这个 PDF
  └─ Agent 查 skill-router 目录索引
      └─ grep 到 pdf 类 skill → 读取该 skill 正文 → 执行
```

但社区实测（Claude 内部社区讨论）提醒：纯 description 匹配的触发率 **不到 30%**，靠「关键词 + 交叉引用」能到 70-80%，仍然不可靠。适合低频、边界清晰的技能；核心技能别走这条。

### 3.3 两层架构：pinned + ecosystem（要改框架）

把 Skill 分成两类：

- **Pinned（钉住）**：高频使用的 10-15 个，永远注入元数据
- **Ecosystem（生态）**：其余全部，元数据不进上下文，只在需要时被发现加载

实现依赖 `skills.ecosystem` 之类的配置项，当前 opencode / Claude Code 原生不直接支持，需要改框架源码或等官方落地。这是「标准答案」的方向，但还不是开箱即用的。

**实战变体：按 domain 分组。** pinned + ecosystem 的按需发现做细一点，可以按领域（domain）分组——每个领域只注入该领域自己的元数据，把「当前任务无关」的领域整体挡在上下文外。举个前端工程师的例子：

```
~/.config/opencode/skills/
├── _domain-frontend/          # 前端领域：常驻
│   ├── react-optimization/
│   ├── css-typo-checklist/
│   └── vite-config-guide/
├── _domain-backend/           # 后端领域：按需发现
│   ├── go-http-handler/
│   └── sql-query-review/
├── _domain-data/              # 数据领域：按需发现
│   ├── etl-troubleshoot/
│   └── dbt-migration/
└── skill-router/              # 路由：按 domain 分桶搜索
```

`_domain-frontend` 是 pinned（写 React 时永远在），后端和数据领域不进上下文。当用户突然问「这个 Go 接口怎么优化」，路由 skill 先按 domain 索引找到 `_domain-backend`，再把它的元数据临时注入——**当前领域零成本，跨领域才付费**。代价和 3.2 一样：路由触发靠匹配，低频冷门请求可能漏；所以「常驻 domain」要挑最常干的活，别贪多。

目录树里那个 `skill-router/` 本身也是一个常驻 Skill，它不装任何技能，只负责「发现」——**自己是路由，也是唯一常驻的索引**：

```markdown
---
name: skill-router
description: 按领域索引仓库内所有 Skill。当用户请求与已安装
  技能相关、但当前未加载该领域时使用。
---

# Skill 路由器

当前领域索引（来自 scripts/build-index.sh 生成）：

| 领域 | 路径 | 关键词 |
|------|------|--------|
| backend | _domain-backend/ | go, http, handler, sql |
| data | _domain-data/ | etl, dbt, migration |

## 匹配流程
1. 提取用户请求的关键词，对照上表找命中领域
2. 命中后调用 `skill({name: "对应 Skill 名"})` 加载正文
3. 没命中任何领域 → 直接告知用户「当前没有可用技能」，不要硬凑

## 维护
- 新增/删除 Skill 后运行 `scripts/build-index.sh` 重建索引
```

关键设计：**路由的索引是脚本生成的**（`scripts/build-index.sh`），不是手写——这样新增 Skill 时索引不会过期，也不会像 3.2 那样靠 grep 碰运气。路由本身只有 ~300 tokens，常驻成本可忽略。代价是：一个「没命中」的冷门请求，模型会诚实告诉你没技能，而不是硬猜——这是有意的取舍。

再看路由命中后、跨域加载的子域 Skill 长相（以 `_domain-backend/go-http-handler/SKILL.md` 为例），**meta 尽量短，正文按需进**：

```markdown
---
name: go-http-handler
description: 审查/优化 Go 的 net/http 与 chi 路由处理函数。当用户
  提到 Go 后端接口、handler 或路由性能时使用。
---

# Go HTTP Handler 审查清单

## 快速检查
- [ ] 方法、路径、状态码是否与 REST 约定一致
- [ ] context 是否贯穿到 DB 调用（超时、取消）
- [ ] panic 是否 recover，错误是否包装（%w）语义
- [ ] 是否把 handler 逻辑抽到 service 层

## 性能
- 避免在 hot path 里做字符串拼接/反射
- 连接池、pprof 检查内存分配

## 参考
详见 `references/routing-patterns.md`
```

前端领域没加载它，它的正文零成本；只有路由把 `_domain-backend` 拉进来，这 ~500 tokens 才进场。**description 里那句「当用户提到 Go 后端接口…时使用」就是路由匹配的抓手**——所以跨域 Skill 的 description 必须写清触发场景，否则路由找不到。

### 3.4 向量化路由：embedding 做语义匹配（长期方案）

既然 description 匹配靠关键字不靠谱，那就上向量：把每个 Skill 的 description 提前做 embedding 存进向量库，每轮请求对用户问题算相似度，**只把 top-K（如 5 个）最相关的 Skill 元数据注入上下文**。

好处是上下文体积从 O(N) 降到 O(K)，还解决了语义匹配不准的问题。代价是要维护向量索引、引入相似度阈值，属于架构级改动。hermes-agent 社区把这条列为官方 Roadmap 的候选。

### 3.5 缓存优化：append-to-end 保住前缀缓存（调工具）

大模型推理有 **前缀缓存（prefix cache）**：如果 system prompt 每次都一样，服务端可以复用计算，速度快、成本低。

但很多工具在每轮对话中**把 Skill 元数据动态追加进 system prompt**，前缀一变，缓存失效，等于每轮都全量重算。解法是把**静态前缀固定、动态内容 append 到末尾**，让前缀部分稳定命中缓存。这条不改架构、只调实现，收益立竿见影。

### 3.6 SkillReducer：构建期压缩 Skill（读论文）

一篇很新的论文《SkillReducer: Compressing Skills for Efficient Large Language Model Inference》（arXiv 2603.29919）提出：与其在运行时优化加载，不如在**构建期**就把 Skill 写得更 token 高效——删除冗余示例、合并重复指令、压缩格式。

方法论很简单：把 SKILL.md 当代码，CI 里跑 token 计数，超阈值就报警，逼着作者精简。**「把 Skill 当代码来管理」**——版本化、review、lint，是这条路的精髓。

## 4. 动手路径：先测量，再裁剪

解决方案再多，不动手都是零。推荐从测量开始：

1. **测**：用 TokenScope 这类插件（opencode 生态的 token 分析器）看当前上下文里每个 Skill 吃多少 token，找出大户。
2. **删**：干掉从没触发过的 Skill——`description` 写得模糊的、装了就忘的，全清。
3. **压**：剩下的 Skill 统一精简 description，机械步骤移进 `scripts/`。
4. **分**：低频技能挪到手动路由，高频技能保持原生触发。
5. **盯**：固定一个元数据预算（比如 5K tokens），新增 Skill 前先算账，超标就不装。

## 5. 结论

Skill 的「零成本」是**相对的**——正文按需加载没问题，但元数据是常驻的。装到 100 个，10K tokens 就压上来了。

| 方案 | 成本 | 收益 | 适用 |
|------|------|------|------|
| 精简 description | 零 | 减半 | 立即做 |
| 技能路由 | 低 | 中（触发率 30-80%） | 低频技能 |
| pinned + ecosystem | 高（改框架） | 高 | 标准答案，等落地 |
| 向量化路由 | 高（架构级） | 高 | 长期 |
| append-to-end 缓存 | 低 | 高 | 立刻 |
| SkillReducer 压缩 | 低 | 中 | 写新 Skill 时 |

上篇教你「怎么写好一个 Skill」，这篇告诉你「装多了怎么办」。**保持克制**——Skill 的价值在触发率，不在数量。10 个用得好的，胜过 100 个躺着占内存的。
