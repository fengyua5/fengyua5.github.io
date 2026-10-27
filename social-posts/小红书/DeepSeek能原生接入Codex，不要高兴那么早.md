DeepSeek 能原生接入 Codex，不要高兴那么早

2026-07-31，DeepSeek 官方正式发布 V4-Flash-0731。这次升级的意义不只是模型本身，而是把兼容做到了极致——DeepSeek 已经能原生接入 Codex 了 🚀

作为开源社区公认的价格屠夫，DeepSeek V4 在推理能力、上下文窗口和成本上又上了一个台阶，而且这次它主动拥抱了 OpenAI 的 Responses API——OpenAI 官方为 agent 场景准备的新协议。一个开源模型，愿意追着行业龙头的新协议走，这种诚意确实值得点赞 ✨

不过，先别高兴太早。

1️⃣ 为什么说不要高兴那么早

第一，原生接入，但不是全量接入。目前只有 deepseek-v4-flash 支持接入 Codex，deepseek-v4-pro 要等到 2026 年 8 月初才跟上 ⏳

第二，Responses API 不支持图片的多模态输入。即使原生接入 Codex，也传不了图——这是协议层面的限制，不是模型能力问题 ⚠️

这两点决定了：DeepSeek 的 Codex 兼容是个好开头，但离全场景可用还有距离。

2️⃣ 协议的问题

为什么哪个客户端最适配，本质上是哪套协议最适合跑 DeepSeek V4？因为 V4 系列同时暴露了两套端点：OpenAI 兼容（原生支持 Responses API，base_url https://api.deepseek.com）和 Anthropic 兼容（Messages API，base_url https://api.deepseek.com/anthropic）。

OpenAI Responses API

Responses API 是 Chat Completions 面向 agent 场景的进化版。

1️⃣ Chat Completions 是无状态的：每次调用都要传完整的 messages 数组，多轮对话成本线性上涨。

2️⃣ Responses API 是有状态的：响应以 items 结构化返回，工具调用是第一公民，原生支持代码执行，还有 previous_response_id 做状态串联——agent 上下文不用每次全量重发。

Assistants API 将下线，官方路线全部收敛到 Responses API。DeepSeek 原生支持这套协议，所以 Codex 这类基于 Responses 的 agent 能零适配跑起来。

Anthropic Messages API

请求体是 content blocks 数组，system 参数独立于 messages。流式走 SSE 事件流：message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop。

工具调用回环：模型返回 tool_use block → 客户端执行 → 塞回 tool_result block，全程在 content block 维度流转。需要 anthropic-version 请求头。

DeepSeek 用兼容端点实现了这套协议，但用 Anthropic 协议驱动 DeepSeek，终究不是原生组合。

图片输入的坑

这是很多人踩过的坑：DeepSeek V4 Flash 的 Responses API 协议并不支持直接的图片输入。

注意这是协议限制，不是模型能力问题——DeepSeek V4 Flash 通过 Chat Completions API 是支持图片输入的：

- 用 Responses API（Codex、以及所有 Responses 兼容的 agent 客户端）→ 传图会失败或直接被忽略。
- 用 Chat Completions API → 可以正常传 image_url 或 base64 图片。

如果你的工作流依赖多模态输入（截图、UI 稿、流程图），那基于 Responses API 的客户端直接出局，只能走 Chat Completions。这一点在选择客户端时几乎是一票否决项 💡

3️⃣ 盘点：哪个工具对 DeepSeek 支持最好

候选有三个：Reasonix、Codex、Claude Desktop，分别对应三种完全不同的协议路线。

Reasonix —— DeepSeek 原生选手

github.com/wandrewchan/reasonix，一个 DeepSeek 原生的终端 coding agent，从设计之初就围绕 DeepSeek 的模型特性来写：

- 围绕 prefix-cache 稳定性设计：DeepSeek 的上下文缓存按前缀命中，prompt 编排刻意保持前缀稳定，让缓存命中率最大化。
- 命令：reasonix chat（聊天）、reasonix run（执行任务）、reasonix doctor（诊断）、reasonix update（更新）。
- 提供 Tauri 桌面客户端（目前是 prerelease）。
- 真实用户案例：435M input tokens 中 99.82% 缓存命中，成本约 12 美元，对比不优化的 61 美元，省了 80% 💰

Codex —— OpenAI 官方，原生接入 DeepSeek

OpenAI 官方 CLI，基于 Responses API。DeepSeek 官方已经原生接入 Codex——提供了完整的集成文档，还配了一键配置脚本（macOS/Linux 一行 bash <(curl -fsSL ...)，Windows 用 PowerShell），自动写好 ~/.codex/models.json 和 config.toml，Codex CLI、ChatGPT 桌面端、VS Code 插件三端通用。

Claude Desktop —— Anthropic 官方，Messages API 阵营

Anthropic 官方客户端，走 Messages API。DeepSeek 虽然提供了 Anthropic 兼容端点，但 Claude Desktop 不能像 Codex 那样直接配置接入——它原生只认 Claude 的模型 ID，必须借助 CC Switch 这类第三方工具做模型映射 + 本地路由代理才能连上 DeepSeek，用起来最隔一层。

4️⃣ 适配度对比

- Reasonix：协议原生围绕 DeepSeek 优化；缓存最友好（为 prefix-cache 专门设计）；Tauri 桌面版；图片输入走 Chat Completions，支持；成本最低（99.82% 命中示例）。
- Codex：Responses API；缓存一般；官方有接入教程；纯 CLI；图片输入不支持；成本中等。
- Claude Desktop：Messages API；缓存一般；官方兼容端点教程；成熟桌面客户端；图片输入不支持；成本中等。

5️⃣ 结论：推荐排序

推荐排序：Reasonix > Codex > Claude Desktop ✅

首选 Reasonix：DeepSeek V4 的原生形态，前缀缓存稳定 + 成本最优，是三个里唯一为 DeepSeek 而生的客户端。注意桌面版还是 prerelease，日常用 CLI 最稳。

次选 Codex：如果你已经在 OpenAI 生态、习惯 Responses API，官方给了现成的接入教程，切换成本极低。但它对 V4 没有缓存层面的专门优化，而且原生接入不支持图片的多模态输入（Responses 协议限制）。

最后 Claude Desktop：Anthropic 协议驱动 DeepSeek 是翻译层而非原生，能用但体验一般。

一句话总结：DeepSeek 能原生接入 Codex，是个值得点赞的好开头，但别高兴太早——想要 DeepSeek V4 Flash 0731 的最佳体验，还得看 Reasonix；需要图片输入的话，务必确认客户端走的是 Chat Completions 协议而不是 Responses 协议 🔥

源码：https://github.com/fengyua5/fengyua5.github.io

#DeepSeek #V4Flash #Codex #AI编程 #Agent #程序员 #效率工具
