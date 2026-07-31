---
title: PI Agent 源代码设计深度解析
date: 2026-07-31 10:58:00
tags: [pi-agent, architecture, source-code]
categories: tech
---

## 概述

PI Agent 是一个基于模块化架构的智能体框架，旨在提供可扩展、可维护的 AI 代理解决方案。本文深入剖析其核心源代码设计思路与架构模式。

## 设计目标

- **解耦性**：将智能体的感知、决策、执行模块分离
- **可扩展性**：通过插件机制支持新能力接入
- **可观测性**：内置完整的日志追踪与性能监控
- **容错性**：异常自动恢复与重试机制

## 核心模块

### 1. Agent 基类

```
src/agent/base.js
├── execute()       // 主执行入口
├── plan()          // 任务规划
├── act()           // 行动执行
├── reflect()       // 反思复盘
└── learn()         // 经验学习
```

采用 **策略模式** 与 **责任链模式** 组合，每个步骤可由子类自由替换实现。

### 2. Planner 规划器

```
src/planner/
├── default.js      // 默认序列规划
└── recursive.js    // 递归分解规划
```

使用 **上下文提示工程** 结合 LLM 进行多步任务分解，支持自引用调用以处理复杂子问题。

### 3. Tool 工具注册中心

```
src/tools/
├── registry.js     // 全局注册表
├── core.js         // 工具基类
└── validators/     // 输入验证器
```

基于 **装饰器模式** 声明工具元数据（name, description, params），运行时自动完成参数校验与类型转换。

### 4. Memory 记忆系统

```
src/memory/
├── short-term.js   // 短期工作记忆（最近 N 条交互）
├── long_term.js    // 长期向量记忆（FAISS 索引）
└── episodic.js     // 事件记忆（结构化时间线）}
```

三层记忆架构：短期 → 长期 → 事件，分别对应不同粒度的信息留存策略。

## 运行流程

```
┌─────────┐    ┌────────┐    ┌────────┐    ┌────────┐
│  Input  │───▶│  Plan  │───▶│  Act   │───▶│  Output│
└─────────┘    └────────┘    └────────┘    └────────┘
      ▲              │            │               │
      │              ▼            ▼               │
   ┌──────┐      ┌──────────┐ ┌──────────┐     │
   │Memory│◀─────│Reflection│ │ToolCall  │     │
   └──────┘      └──────────┘ └──────────┘     │
      └───────────────┬───────────────────────┘
                      ▼
                 (Feedback Loop)
```

## 关键技术点

### 1. 动态提示模板

使用 Handlebars 模板引擎动态生成 prompt，支持变量插值与条件分支：

```handlebar
{{#if user_context}}
请结合用户上下文：{{user_context}}
{{/if}}
```

### 2. 函数调用封装

LLM 函数调用被统一封装为 `ToolInvocation` 对象，包含：
- `name`: 工具名
- `args`: 解析后的参数字典  
- `call_id`: 唯一调用标识，用于追踪

### 3. 异常熔断机制

最大重试次数 + 超时阈值 + 错误分类，避免死循环与无界等待。

## 扩展实践

要添加新能力只需三步：

1. 实现新的 `Tool` 类并注册到 registry
2. （可选）编写新的 `Planner` 策略
3. 在 `agent.js` 中注入对应的 memory type

> 完整代码仓库：`github.com/fengyua5/pi-agent`

<!-- more -->

## 附录：项目结构树

```
src/
├── agent/          # 智能体核心
├── planner/        # 任务规划
├── tools/          # 工具库
├── memory/         # 记忆系统
├── llm/            # LLM 适配器
├── utils/          # 工具函数
└── index.js        # 入口
```
