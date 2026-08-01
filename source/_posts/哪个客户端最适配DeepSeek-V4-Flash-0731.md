---
title: DeepSeek 能原生接入 Codex，不要高兴那么早
date: 2026-08-01 12:00:00
tags: [deepseek, v4-flash, client, agent]
categories: AI
---

2026-07-31，DeepSeek 官方正式发布 **V4-Flash-0731**。这次升级的意义不只是模型本身，而是把「兼容」做到了极致——**DeepSeek 已经能原生接入 Codex 了**。

![DeepSeek V4 Flash 0731](https://fengyua5.github.io/img/deepseek-0731.jpg)

作为开源社区公认的「价格屠夫」，DeepSeek V4 在推理能力、上下文窗口和成本上又上了一个台阶，而且这次它主动拥抱了 OpenAI 的 **Responses API**——要知道这是 OpenAI 官方为 agent 场景准备的新协议。一个开源模型，愿意追着行业龙头的新协议走，这种诚意确实值得点赞。

不过，先别高兴太早。

<!-- more -->

## 为什么说「不要高兴那么早」

**第一，原生接入，但不是全量接入。** 目前只有 `deepseek-v4-flash` 支持接入 Codex，`deepseek-v4-pro` 要等到 2026 年 8 月初才跟上。

**第二，Responses API 不支持图片的多模态输入。** 即使原生接入 Codex，也传不了图——协议层面的限制，不是模型能力问题。

这两点决定了：DeepSeek 的 Codex 兼容是个「好开头」，但离「全场景可用」还有距离。下面细说协议的问题。

## 协议的问题：Responses vs Messages vs Chat Completions

为什么「哪个客户端最适配」这个问题，本质上是「哪套协议最适合跑 DeepSeek V4」？因为 V4 系列同时暴露了两套端点：

| 端点 | 协议 | base_url |
|------|------|----------|
| OpenAI 兼容（原生支持 Responses API） | Responses / Chat Completions | `https://api.deepseek.com` |
| Anthropic 兼容 | Messages API | `https://api.deepseek.com/anthropic` |

三套协议的本质区别如下。

### OpenAI Responses API

Responses API 是 Chat Completions 面向 **agent 场景**的进化版，Simon Willison 在 2025 年 3 月专门写过对比：

- **Chat Completions 是无状态的**：每次调用都要传完整的 `messages` 数组，多轮对话成本线性上涨。
- **Responses API 是有状态的**：响应以 `items`（input/output items）结构化返回，工具调用是第一公民，原生支持代码执行，还有 `previous_response_id` 做**状态串联**——agent 上下文不用每次全量重发。
- Assistants API 将下线，官方路线是全部收敛到 Responses API。
- DeepSeek 原生支持这套协议，所以 Codex 这类基于 Responses 的 agent 能零适配跑起来。

### Anthropic Messages API

- 请求体是 **content blocks 数组**，`system` 参数独立于 messages。
- 流式走 **SSE 事件流**：`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`。
- **工具调用回环**：模型返回 `tool_use` block → 客户端执行 → 塞回 `tool_result` block，全程在 content block 维度流转。
- 需要 `anthropic-version: 2023-06-01` 请求头。
- DeepSeek 用兼容端点实现了这套协议，但「用 Anthropic 协议驱动 DeepSeek」终究不是原生组合。

### 协议对比表

| 维度 | Chat Completions | Responses API | Messages API |
|------|------------------|---------------|--------------|
| 状态 | 无状态，全量重发 | 有状态，`previous_response_id` 串联 | 无状态，全量重发 |
| 工具调用 | 支持 | 第一公民，结构化 items | content block 回环 |
| 代码执行 | 不支持 | 原生支持 | 不支持 |
| 图片输入 | **支持** | **不支持** | 不支持 |
| 典型代表 | 通用 SDK | Codex / Reasonix | Claude Desktop |

### 图片输入的坑

这是很多人踩过的坑：**DeepSeek V4 Flash 的 Responses API 协议并不支持直接的图片输入**。

注意这是**协议限制，不是模型能力问题**——DeepSeek V4 Flash 通过 **Chat Completions API 是支持图片输入的**。也就是说：

- 用 Responses API（Codex、以及所有「Responses 兼容」的 agent 客户端）→ 传图会失败或直接被忽略。
- 用 Chat Completions API → 可以正常传 `image_url` 或 base64 图片。

所以如果你的工作流依赖**多模态输入**（截图、UI 稿、流程图），那基于 Responses API 的客户端直接出局，只能走 Chat Completions。这一点在选择客户端时几乎是一票否决项。

## 盘点：哪个工具对 DeepSeek 支持最好

候选有三个：Reasonix、Codex、Claude Desktop。它们分别对应三种完全不同的协议路线。

### 1. Reasonix —— DeepSeek 原生选手

`github.com/wandrewchan/reasonix`，一个 **DeepSeek 原生**的终端 coding agent。它不是通用客户端去「适配」DeepSeek，而是从设计之初就围绕 DeepSeek 的模型特性来写：

- **围绕 prefix-cache 稳定性设计**：DeepSeek 的上下文缓存按前缀命中，prompt 编排刻意保持前缀稳定，让缓存命中率最大化。
- 命令：`reasonix chat`（聊天）、`reasonix run`（执行任务）、`reasonix doctor`（诊断）、`reasonix update`（更新）。
- 提供 **Tauri 桌面客户端**（目前是 prerelease）。
- 真实用户案例：435M input tokens 中 **99.82% 缓存命中**，成本约 `$12`，对比不优化的 `$61`，省了 80%。

### 2. Codex —— OpenAI 官方，原生接入 DeepSeek

OpenAI 官方 CLI，基于 **Responses API**（不是旧的 Chat Completions）。**DeepSeek 官方已经原生接入 Codex**——官方提供了完整的 [Codex 集成文档](https://api-docs.deepseek.com/quick_start/agent_integrations/codex)，还配了一键配置脚本（macOS/Linux 一行 `bash <(curl -fsSL ...)`，Windows 用 PowerShell），自动写好 `~/.codex/models.json` 和 `config.toml`，Codex CLI、ChatGPT 桌面端、VS Code 插件三端通用。

### 3. Claude Desktop —— Anthropic 官方，Messages API 阵营

Anthropic 官方客户端，走 **Messages API**。DeepSeek 虽然提供了 Anthropic 兼容端点（`https://api.deepseek.com/anthropic`），但 **Claude Desktop 不能像 Codex 那样直接配置接入**——它原生只认 Claude 的模型 ID（`claude-sonnet-*`/`claude-opus-*`/`claude-haiku-*`），必须借助 **CC Switch** 这类第三方工具做模型映射 + 本地路由代理才能连上 DeepSeek，用起来最「隔一层」。

## 适配度对比

| 维度 | Reasonix | Codex | Claude Desktop |
|------|----------|-------|----------------|
| 协议 | 原生围绕 DeepSeek 优化 | Responses API | Messages API |
| 缓存友好（前缀稳定） | 最强，为 prefix-cache 专门设计 | 一般 | 一般 |
| 官方集成文档 | 无（本来就是 DeepSeek 原生） | 官方有 Codex 接入教程 | 官方兼容端点教程 |
| 桌面端 | Tauri 桌面版（prerelease） | 纯 CLI | 成熟桌面客户端 |
| 图片输入 | 走 Chat Completions，支持 | 不支持 | 不支持 |
| 成本（同量级缓存场景） | 最低（99.82% 命中示例） | 中等 | 中等 |

## 结论：推荐排序

**Reasonix > Codex > Claude Desktop**

- **首选 Reasonix**：DeepSeek V4 的原生形态。前缀缓存稳定 + 成本最优，是三个里唯一「为 DeepSeek 而生」的客户端。注意桌面版还是 prerelease，日常用 CLI 最稳。
- **次选 Codex**：如果你已经在 OpenAI 生态、习惯 Responses API，DeepSeek 官方给了现成的接入教程，切换成本极低。但它对 V4 没有缓存层面的专门优化，而且**原生接入不支持图片的多模态输入**（Responses 协议限制）。
- **最后 Claude Desktop**：Anthropic 协议驱动 DeepSeek 是「翻译层」而非原生，能用但体验一般。

**一句话总结**：DeepSeek 能原生接入 Codex，是个值得点赞的好开头，但别高兴太早——想要 DeepSeek V4 Flash 0731 的最佳体验，还得看 **Reasonix**；需要**图片输入**的话，务必确认客户端走的是 Chat Completions 协议而不是 Responses 协议。
