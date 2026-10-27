---
title: Agent 开发到底该学什么？我整理了一条学习路线
date: 2026-10-27 10:00:00
tags: [Agent, LLM, 学习路径]
categories: AI
cover: /img/covers/agent-learning-path-wide.png
---

<p style="text-align:center"><img src="/img/covers/agent-learning-path-wide.png" alt="Agent 开发到底该学什么？我整理了一条学习路线"></p>

大家好，我是风雨，后续会陆续更新一下 Agent 开发所需知识。

我自己学 Agent 的时候知识点比较零散，东看一篇西看一篇，效率不高。现在把踩过的路整理成一套学习路线，大致就是下面这十块，按顺序走会顺一些。

<!-- more -->

## 一、学习 Python 或者 TypeScript

先把语言和工程基本功打牢：异步、类型、环境管理、调 HTTP 接口和看懂 JSON。会其中一门就够了。

## 二、LLM 基础认知

搞清楚模型能做什么、为什么它会出错：token、上下文窗口、训练阶段、解码参数、幻觉、成本与延迟、模型选型。

## 三、提示词工程

把正确的信息，用正确的形式，放进有限的上下文窗口：指令设计、示例、结构化输出、上下文分层与压缩、prompt 缓存。

## 四、工具调用

让模型从「说」变成「做」：function calling 原理、工具 schema 设计、并行调用、错误回传、MCP、沙箱执行与权限控制。

## 五、RAG 与记忆

把模型不知道的东西给它：切分、embedding、向量与关键词混合检索、重排、query 改写，以及短期/长期记忆的写入与遗忘。

## 六、Agent 核心机制

整条路径的分水岭：谁来控制循环、循环什么时候停。ReAct、Plan-and-Execute、Reflection、状态机、终止条件、错误恢复、human-in-the-loop。

## 七、多 Agent 与编排

先确认真的需要：Supervisor / Handoff / Swarm 等拓扑、上下文隔离、共享状态与最终决策权。

## 八、工程栈与框架

不要为了框架学框架：Agent SDK、LangGraph 这类编排工具、MCP 与工具网关、沙箱、存储与会话状态。

## 九、评估与可观测性

决定能不能上生产：评测集怎么建、LLM-as-judge、分阶段评估、trace、成功率 / 延迟 / 单任务成本、回归 CI。

## 十、实战

最后一定要落到项目上：流式聊天 → 工具调用 Agent → RAG 问答 → 手写 Agent Loop → 补评测与 trace → 接 MCP 与沙箱 → 多 Agent → 生产化改造。
