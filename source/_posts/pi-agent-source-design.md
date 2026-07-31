---
title: PI Agent 源代码设计深度解析
date: 2026-07-31 10:58:00
tags: [pi-agent, architecture, source-code]
categories: AI
---

PI Agent（开源仓库 `badlogic/pi-mono`，本文基于 commit `74caa26`）是目前最成熟的 Typescript Code Agent 智能体框架之一。它把「上下文工程」当作第一等公民，核心只做一件事：**让 agent 在有限的上下文窗口里高效地思考、行动、并且永远知道自己下一步该干什么**。

本文不再泛泛而谈，直接沿着源码拆解它的 **5 个灵魂机制**：

1. **Agent Loop** —— 双层循环驱动的主执行引擎（`packages/agent/src/agent-loop.ts`）
2. **插件化架构** —— 一组 `register*` 函数构成的可扩展 API（`extensions/loader.ts` + `extensions/types.ts`）
3. **时机监听** —— webpack 式的事件总线，agent 生命周期每个节点都可挂载（`extensions/runner.ts` + `agent-session.ts`）
4. **上下文压缩** —— compaction 机制，让上下文永不撑爆（`core/compaction/compaction.ts`）
5. **Skills 加载机制** —— 目录扫描 + 校验 + 注入系统提示词（`core/skills.ts`）

<!-- more -->

---

## 1. Agent Loop：agent 的主循环

> 源码：`packages/agent/src/agent-loop.ts`

Agent Loop 是 PI Agent 最底层的多轮执行引擎。它不管 TUI、不管 session 持久化，**只专注于"调 LLM → 执行工具 → 再调 LLM"这个循环**，全程以统一的 `AgentMessage[]` 流转，只在调用 LLM 的边界处转成 provider 需要的 `Message[]`。

### 1.1 入口

```ts
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}
```

注意它返回的不是 `Promise`，而是一个 **`EventStream`** —— 调用方订阅事件流（`agent_start`、`turn_start`、`message_update`…），最后通过 `agent_end` 事件拿到最终消息列表。**事件是 PI Agent 的第一公民**，第 3 节会看到它如何接出去。

### 1.2 双层循环 `runLoop`

这是全项目最核心的 40 行，务必逐行读懂：

```ts
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });
			// ... prepareNextTurn / shouldStopAfterTurn / getSteeringMessages ...
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}
```

**设计要点：**

- **内层循环**处理"同一轮对话内的工具调用链"：LLM 返回一条含 `toolCall` 的消息 → 执行工具 → 把 `toolResult` 追加进上下文 → 继续下一次 LLM 调用，直到模型不再调用工具（`hasMoreToolCalls = false`）。
- **外层循环**处理"跨轮的后续消息"：当 agent 准备停止时，如果用户在流式期间又发了 follow-up 消息（`getFollowUpMessages`），就回到内层循环继续。这是**可中断/可注入**的关键。
- **steering（转向）消息**在每轮 LLM 调用前被注入到上下文中，实现了"人机穿插对话"。

### 1.3 流式响应 `streamAssistantResponse`

每个 assistant 消息都是**流式累积**的：先 push 一个占位的 partial 消息，然后 `message_update` 事件逐 token 更新它。

```ts
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const response = await streamFunction(config.model, llmContext, { ...config, apiKey, signal });

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_delta":
			case "thinking_delta":
			case "toolcall_delta":
				// ...逐片更新最后一个 partial 消息并 emit message_update...
				partialMessage = event.partial;
				context.messages[context.messages.length - 1] = partialMessage;
				await emit({ type: "message_update", assistantMessageEvent: event, message: { ...partialMessage } });
				break;

			case "done":
			case "error":
				// 把最终消息落回上下文，emit message_end
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
		}
	}
	// ...
}
```

这里 `transformContext` 是**上下文压缩的注入点**（第 4 节），`convertToLlm` 是自定义消息类型（`bashExecution`、`custom`…）与 provider 格式之间的适配层。

### 1.4 工具调用执行

工具可以**并行**也可以**串行**执行，由工具的 `executionMode` 决定：

```ts
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}
```

在真正执行前，每个 tool call 都会经过 **`prepareToolCall`**：参数预处理（`prepareArguments`）→ 参数校验（`validateToolArguments`）→ **`config.beforeToolCall` 钩子（可以 block 掉这次调用）**。执行后再走 **`config.afterToolCall` 钩子**：

```ts
if (config.beforeToolCall) {
	const beforeResult = await config.beforeToolCall(
		{ assistantMessage, toolCall, args: validatedArgs, context: currentContext },
		signal,
	);
	if (beforeResult?.block) {
		return {
			kind: "immediate",
			result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
			isError: true,
		};
	}
}
```

这就是"各种时机监听"的最底层钩子形态 —— 第 3 节的事件系统是它上层更完整的抽象。

### 1.5 Steering 与 Follow-up：消息是怎么产生和消费的

回到 1.2 节的双层循环，你会发现它反复调用 `config.getSteeringMessages()` 和 `config.getFollowUpMessages()`。这两个"消息源"是整个 loop 能被人机穿插对话驱动的关键，下面把它们的**生产**和**消费**两端讲透。

#### 两种消息的定义

| | **Steering（转向）** | **Follow-up（跟进）** |
|---|---|---|
| 注入时机 | 当前 assistant 回合结束后、**下一次 LLM 调用之前** | **agent 即将停止时**（没有工具调用、也没有 steering 消息） |
| 语义 | "抢话 / 打断思路"：流式还没结束就能插一句，让模型下一轮立刻看到 | "追加任务"：等 agent 把当前任务跑完再追加新的要求 |
| 消费位置 | 内层循环每轮开头的 `pendingMessages` | 内层循环全部结束、外层循环检查处 |
| 用户感知 | 输入后 agent 的反应几乎无缝衔接 | 输入后 agent 要先把当前这轮收尾再处理 |

#### 生产端：两个队列

`Agent` 类内部维护两个 `PendingMessageQueue`，分别存 steering 和 follow-up 消息：

```ts
class PendingMessageQueue {
	private messages: AgentMessage[] = [];
	public mode: QueueMode; // "one-at-a-time"（默认）| "all"

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	drain(): AgentMessage[] {
		if (this.mode === "all") {
			// 一次全部取出
			const drained = this.messages.slice();
			this.messages = [];
			return drained;
		}

		// 默认：每轮只取一条
		const first = this.messages[0];
		if (!first) return [];
		this.messages = this.messages.slice(1);
		return [first];
	}
}
```

入队 API 就两个：

```ts
/** Queue a message to be injected after the current assistant turn finishes. */
steer(message: AgentMessage): void {
	this.steeringQueue.enqueue(message);
}

/** Queue a message to run only after the agent would otherwise stop. */
followUp(message: AgentMessage): void {
	this.followUpQueue.enqueue(message);
}
```

#### 上层怎么调用 `steer()` / `followUp()`？

在 coding-agent 层，`agent-session.ts` 封装了 `steer()` / `followUp()`：**先做扩展命令检查（`/command` 不能排队）→ 展开 skill 命令（`/skill:name`）和 prompt 模板 → 再入队**：

```ts
async steer(text: string, images?: ImageContent[]): Promise<void> {
	if (text.startsWith("/")) {
		this._throwIfExtensionCommand(text);
	}
	let expandedText = this._expandSkillCommand(text);
	expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
	await this._queueSteer(expandedText, images);
}

private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
	this._steeringMessages.push(text);
	this._emitQueueUpdate();
	const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
	if (images) content.push(...images);
	this.agent.steer({
		role: "user",
		content,
		timestamp: Date.now(),
	});
}
// _queueFollowUp 结构完全一致，只是调 this.agent.followUp(...)
```

**关键分支**在 `prompt()` 的处理逻辑里：当 agent **正在流式**时，用户输入必须带上 `streamingBehavior` 选项决定走哪条队列：

```ts
// If streaming, queue via steer() or followUp() based on option
if (this.isStreaming) {
	if (!options?.streamingBehavior) {
		throw new Error(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);
	}
	if (options.streamingBehavior === "followUp") {
		await this._queueFollowUp(expandedText, currentImages);
	} else {
		await this._queueSteer(expandedText, currentImages);
	}
	preflightResult?.(true);
	return;
}
```

交互式 TUI（interactive-mode.ts）和 RPC 模式都按这个语义路由用户输入；扩展 API 的 `sendUserMessage(content, { deliverAs: "steer" | "followUp" })` 也是同一套出口。

#### 消费端：loop 通过两个 getter 拉取

`Agent.createLoopConfig()` 把两个队列**接**成 loop 需要的两个函数（闭包持有同一个队列实例）：

```ts
getSteeringMessages: async () => {
	if (skipInitialSteeringPoll) {
		skipInitialSteeringPoll = false;
		return [];
	}
	return this.steeringQueue.drain();
},
getFollowUpMessages: async () => this.followUpQueue.drain(),
```

于是 1.2 节 `runLoop` 中的逻辑闭环就串起来了：

1. 每轮内层循环开头：`pendingMessages = (await config.getSteeringMessages?.()) || []` —— **steering 消息被当作 user 消息 push 进上下文**，紧接着的这次 LLM 调用就会看到它；
2. 内层循环跑完（模型不再调工具）：`followUpMessages = (await config.getFollowUpMessages?.()) || []` —— 如果用户在此期间追加了 follow-up，就把它变成 `pendingMessages` 并 `continue` 外层循环，**agent 不会停止，继续新一轮**；
3. 两个队列都空 → `break` → 发 `agent_end`，agent 真正空闲。

> `skipInitialSteeringPoll` 的小细节：`continue()`（从已有上下文续跑）时，第一轮不再重复消费初始 steering，避免消息被二次处理。

**一句话总结**：Steering 和 Follow-up 是同一个"排队→按时机注入"机制的两档优先级 —— steering 插进"当前回合结束但还没调下一次 LLM"的空隙，follow-up 插进"agent 自认为干完了"的边界，从而把一次性 `prompt()` 变成了**可持续穿插对话**的会话。

---

## 2. 插件化架构：一组 `register*` 函数

> 源码：`packages/coding-agent/src/core/extensions/loader.ts`、`types.ts`

PI Agent 的插件系统设计得非常克制：**给插件一个 `pi` 对象，插件用它把自己注册进系统**。所有注册能力集中在 `ExtensionAPI` 上，数一下就知道有多少种：

```ts
export interface ExtensionAPI {
	// 事件订阅（见第 3 节）
	on(event: "...", handler: ExtensionHandler<...>): void;

	// 注册一个可供 LLM 调用的工具
	registerTool(tool: ToolDefinition): void;

	// 注册命令 / 快捷键 / CLI flag
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
	registerShortcut(shortcut: KeyId, options: {...}): void;
	registerFlag(name: string, options: {...}): void;

	// 注册自定义消息 / 自定义条目的渲染器
	registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void;
	registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void;
	registerMarkdownTransformer(transformer: MarkdownTransformer): void;

	// 注册或覆盖一个模型 provider
	registerProvider(provider: Provider): void;
	registerProvider(name: string, config: ProviderConfig): void;
	unregisterProvider(name: string): void;

	// 主动动作（发消息 / 切换模型 / 取状态……）
	sendMessage / sendUserMessage / appendEntry / setModel / ...
	events: EventBus;
}
```

### 2.1 注册函数如何工作（loader.ts 实现）

每个注册函数的核心逻辑都一模一样：**写入到当前插件自己的 `Extension` 对象上**（`extension.tools`、`extension.commands`、`extension.handlers`…），而不是全局状态。这样插件天然可卸载、可 reload。

```ts
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	const api = {
		// 注册函数 —— 写入当前 extension 对象
		on(event: string, handler: HandlerFn): void {
			runtime.assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			runtime.assertActive();
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			runtime.assertActive();
			extension.commands.set(name, { name, sourceInfo: extension.sourceInfo, ...options });
		},

		registerShortcut(shortcut, options) {
			runtime.assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(name, options) {
			runtime.assertActive();
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerProvider(providerOrName, config) {
			runtime.assertActive();
			if (typeof providerOrName === "string") {
				if (!config) throw new Error("Provider config is required when registering by name");
				runtime.registerProvider(providerOrName, config, extension.path);
				return;
			}
			runtime.registerNativeProvider(providerOrName, extension.path);
		},
		// ...
	} as ExtensionAPI;
	return api;
}
```

### 2.2 插件是怎么被加载的

加载流程是一条清晰的管道：**找到入口 → 创建空的 extension 对象 → 给它一把 `api` → 执行插件工厂函数**。插件里每次调用 `pi.registerXxx()` 就往 extension 对象里填一项。

```ts
async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	cacheToken?: ExtensionCacheToken,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		// 1. 用 jiti 动态 import 插件模块（支持 TS 源码）
		const factory = await loadExtensionModule(resolvedPath, cacheToken);
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		// 2. 创建一个空的 Extension 对象（handlers/tools/commands/flags/shortcuts 全是空 Map）
		const extension = createExtension(extensionPath, resolvedPath);

		// 3. 生成注册 API，所有 register 写入 extension
		const api = createExtensionAPI(extension, runtime, cwd, eventBus);

		// 4. 执行插件工厂：插件内部调用 pi.registerTool() / pi.on() / pi.registerCommand() ...
		await factory(api);

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}
```

插件的**发现规则**在 `discoverExtensionsInDir` / `resolveExtensionEntries`：

1. `extensions/*.ts|*.js` 直接加载
2. `extensions/<dir>/index.ts|index.js` 加载 index 文件
3. `extensions/<dir>/package.json` 里的 `"pi": { "extensions": [...] }` 字段声明入口（支持复杂包）

加载顺序：**项目本地 `cwd/.pi/extensions/` → 全局 `~/.pi/extensions/` → 显式配置的路径**。

### 2.3 真实插件示例（llama 扩展）

官方自带的 llama.cpp 集成插件，就是一个"用注册函数组合能力"的教科书：

```ts
export default function llamaExtension(pi: ExtensionAPI): void {
	// 注册一个完整的新模型 provider（支持 llama.cpp 本地推理）
	const provider = createLlamaProvider();
	pi.registerProvider(provider.provider);

	// 注册一个 /llama 命令，提供交互式的模型管理 UI
	pi.registerCommand("llama", {
		description: "Manage llama.cpp router models",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/llama is available in interactive mode", "warning");
				return;
			}
			// ...showLlamaUi 模型列表/下载/加载/卸载...
		},
	});
}
```

一个 TS 文件 + 几个 `register*` 调用，就把一个全新的模型后端 + 一套管理命令接进了系统 —— **这就是插件化架构的威力：核心零改动，能力全部外置**。

### 2.4 `registerTool` 之后：refreshTools 刷新与最新值的获取

这是插件系统里最容易绕晕的一环，值得单独拆开。问题拆成两个：**① `registerTool` 之后如何触达真实的工具表？② LLM 调用时拿到的 tools 为什么一定是最新的？**

#### 完整调用链

```
plugin 调用 pi.registerTool(tool)
   └─► loader.createExtensionAPI().registerTool()
         ├─ extension.tools.set(name, { definition, sourceInfo })   // 先落进插件自己的 Map
         └─ runtime.refreshTools()                                  // 通知"工具集变了"
              └─► runner.bindCore() 已把 refreshTools 替换为真实实现
                    └─► agent-session._refreshToolRegistry()
                          ├─ 合并: 插件工具 + SDK 工具 + 内置工具(bash/read/write/edit/grep/find/ls)
                          ├─ 过滤: allowed / excluded
                          ├─ 包装: wrapRegisteredTools（挂上 tool_call/tool_result 事件）
                          ├─ 重建 _toolRegistry / _toolDefinitions
                          ├─ 新工具自动进 activeToolNames
                          └─ setActiveToolsByName(...)  →  agent.state.tools = 最新工具表
```

#### 第 1 步：registerTool 把定义写进插件的 Map

```ts
registerTool(tool: ToolDefinition): void {
	runtime.assertActive();
	extension.tools.set(tool.name, {
		definition: tool,
		sourceInfo: extension.sourceInfo,
	});
	runtime.refreshTools();
}
```

注意它只往**当前插件自己的 `extension.tools`** 里写，绝不直接碰全局。这样插件可卸载、可 reload，注册是"可追溯的"。

#### 第 2 步：refreshTools 的两副面孔（关键！）

**加载期间**，runner 还没绑定，`refreshTools` 是一个 no-op 桩 —— 因为此时 session 的注册表还没建好，调用真实的刷新函数反而会炸：

```ts
export function createExtensionRuntime(): ExtensionRuntime {
	// ...
	return {
		// ...
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		// ...
	};
}
```

**绑定之后**，`runner.bindCore()` 把真实实现注入到同一个 runtime 对象上。由于所有插件持有的 `api` 引用的是**同一个 runtime 对象**，插件以后在事件回调里调 `registerTool()` 就会走真实逻辑：

```ts
bindCore(actions: ExtensionActions, /* ... */): void {
	// Copy actions into the shared runtime (all extension APIs reference this)
	// ...
	this.runtime.refreshTools = actions.refreshTools;
	// ...
}
```

而 `actions.refreshTools` 在 agent-session 里就是 `() => this._refreshToolRegistry()`（agent-session.ts:2396）。

> 也就是说：**插件在工厂函数里注册工具时，refresh 是"记账"式的；等 runner 绑定后，哪怕插件在任意事件回调里再注册工具，也立即触发真实的注册表重建**。

#### 第 3 步：_refreshToolRegistry 重建注册表

真实实现的第一步，是从 runner 拿到**所有插件注册的工具**（同名工具按"先注册者胜"）：

```ts
/** Get all registered tools from all extensions (first registration per name wins). */
getAllRegisteredTools(): RegisteredTool[] {
	const toolsByName = new Map<string, RegisteredTool>();
	for (const ext of this.extensions) {
		for (const tool of ext.tools.values()) {
			if (!toolsByName.has(tool.definition.name)) {
				toolsByName.set(tool.definition.name, tool);
			}
		}
	}
	return Array.from(toolsByName.values());
}
```

然后与 SDK 自定义工具（`_customTools`）、内置工具（`_baseToolDefinitions`）合并，套用过滤规则并**包装每个工具**，最后重建两个注册表并推导出"当前应激活的工具集合"：

```ts
private _refreshToolRegistry(options?): void {
	// ...
	const registeredTools = this._extensionRunner.getAllRegisteredTools();
	const allCustomTools = [
		...registeredTools,
		...this._customTools.map((definition) => ({
			definition,
			sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
		})),
	].filter((tool) => isAllowedTool(tool.definition.name));
	// ... 内置工具同样过滤后进 _toolDefinitions ...
	for (const tool of allCustomTools) {
		definitionRegistry.set(tool.definition.name, { definition: tool.definition, sourceInfo: tool.sourceInfo });
	}
	this._toolDefinitions = definitionRegistry;

	// 包装：给每个工具套上 tool_call / tool_result 事件发射与权限检查
	const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
	const wrappedBuiltInTools = wrapRegisteredTools(/* 内置工具 */, runner);
	const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
	for (const tool of wrappedExtensionTools as AgentTool[]) {
		toolRegistry.set(tool.name, tool);
	}
	this._toolRegistry = toolRegistry;

	// 新出现的工具名自动补进 active 集合
	// ... nextActiveToolNames 计算 ...
	this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
}
```

#### 第 4 步：setActiveToolsByName 让"最新值"落地

最后一步把注册表里**已激活**的工具整体赋给 `agent.state.tools`，并同步重建 system prompt（让 LLM 的提示词里也带上新工具的 `promptSnippet` / `promptGuidelines`）：

```ts
setActiveToolsByName(toolNames: string[]): void {
	const tools: AgentTool[] = [];
	const validToolNames: string[] = [];
	for (const name of toolNames) {
		const tool = this._toolRegistry.get(name);
		if (tool) {
			tools.push(tool);
			validToolNames.push(name);
		}
	}
	this.agent.state.tools = tools;

	// Rebuild base system prompt with new tool set
	this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
	this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
}
```

#### 为什么下一轮 LLM 一定能拿到最新 tools？

因为 agent-loop **不缓存工具列表**，而是每轮从 `state.tools` 打一个快照：

```ts
private createContextSnapshot(): AgentContext {
	return {
		systemPrompt: this._state.systemPrompt,
		messages: this._state.messages.slice(),
		tools: this._state.tools.slice(),   // ← 每次循环都取最新的数组
	};
}
```

这个快照再一路传进 `streamAssistantResponse` 的 `llmContext.tools`，最终进 provider 请求体。所以链路是：

```
registerTool → refreshTools → _refreshToolRegistry → setActiveToolsByName
  → state.tools 整体替换 → 下一轮 createContextSnapshot() 读到新数组 → LLM 请求体包含新工具
```

**"最新值"的保证靠的不是缓存失效，而是"每轮重建上下文快照"这个设计** —— 工具表是 `state` 上的一份可变数据，任何一次 `refresh` 都会整体替换它，而 loop 每一轮开始时都重新 `slice()`，因此**注册之后下一个 turn 必然生效**。这也解释了为什么"插件在事件回调里临时注册工具"也能立即起效：只要在下一轮循环开始前调用了 `refreshTools`，快照拿到的就是新表。

---

## 3. 时机监听：webpack 式的事件系统

> 源码：`packages/coding-agent/src/core/extensions/runner.ts`、`agent-session.ts`、`extensions/types.ts`

说它"像 webpack"是因为：**事件覆盖了从会话到单次 LLM 请求的全生命周期，而且部分事件是"可返回结果来改变主流程"的中间件**（像 webpack 的 tapable 的 `WaterfallHook` / `SyncBailHook`）。

### 3.1 事件全景

| 时机 | 事件 | 可否改变主流程 |
|---|---|---|
| 会话生命周期 | `session_start` / `session_shutdown` / `session_before_switch` / `session_before_fork` | before 系列可 `cancel` |
| 会话树导航 | `session_before_tree` / `session_tree` | 可 cancel、可覆盖摘要 |
| 上下文压缩 | `session_before_compact` / `session_compact` | 可 cancel、可自定义摘要 |
| Agent 主循环 | `before_agent_start` / `agent_start` / `agent_end` / `agent_settled` | before 可改 systemPrompt |
| 每轮对话 | `turn_start` / `turn_end` | — |
| 消息 | `message_start` / `message_update` / `message_end` | `message_end` 可替换消息 |
| 工具执行 | `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | — |
| 工具调用 | `tool_call`（执行前）/ `tool_result`（执行后） | `tool_call` 可 block、可改参数；`tool_result` 可改结果 |
| Provider | `before_provider_request` / `before_provider_headers` / `after_provider_response` | 可替换 payload、可注入 header |
| 上下文 | `context`（每次 LLM 调用前） | 可修改 messages |
| 用户输入 | `input` / `user_bash` | `input` 可 transform；`user_bash` 可替换执行 |
| 模型 | `model_select` / `thinking_level_select` | — |
| 其他 | `resources_discover` / `project_trust` | 可贡献资源路径、决定是否信任 |

### 3.2 订阅：`pi.on(event, handler)`

插件通过 `pi.on()` 订阅，handler 可**异步**、可返回结果：

```ts
// types.ts
/** Handler function type for events */
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

// 用法示例：修改每次发给 LLM 的上下文
pi.on("context", async (event, ctx) => {
	event.messages.push({ role: "user", content: [...], ... });
	return { messages: event.messages };
});

// 用法示例：在工具执行前拦截（可阻止）
pi.on("tool_call", async (event, ctx) => {
	if (event.toolName === "bash" && event.input.command.includes("rm -rf")) {
		return { block: true, reason: "Forbidden command" };
	}
});

// 用法示例：message_end 后替换最终消息
pi.on("message_end", async (event, ctx) => {
	return { message: { ...event.message, content: [{ type: "text", text: "filtered" }] } };
});
```

### 3.3 分发：runner 的 `emit`

runner 把所有插件按**注册顺序**串行调用同一个事件的 handler，并且对 `session_before_*` 系列做了"只要返回 `cancel: true` 就短路返回"的 bail 语义：

```ts
async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
	const ctx = this.createContext();
	let result: SessionBeforeEventResult | undefined;

	for (const ext of this.extensions) {
		const handlers = ext.handlers.get(event.type);
		if (!handlers || handlers.length === 0) continue;

		for (const handler of handlers) {
			try {
				const handlerResult = await handler(event, ctx);

				if (this.isSessionBeforeEvent(event) && handlerResult) {
					result = handlerResult as SessionBeforeEventResult;
					if (result.cancel) {
						return result as RunnerEmitResult<TEvent>; // 短路！像 webpack 的 bail hook
					}
				}
			} catch (err) {
				// 单个插件抛错不影响其他插件（错误隔离）
				this.emitError({ extensionPath: ext.path, event: event.type, error: message, stack });
			}
		}
	}

	return result as RunnerEmitResult<TEvent>;
}
```

`message_end` 事件更进一步：handler 的返回值**链式替换**当前消息，后一个 handler 看到前一个 handler 改过的消息 —— 这就是标准的 webpack `WaterfallHook` 语义：

```ts
async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
	const ctx = this.createContext();
	let currentMessage = event.message;
	let modified = false;

	for (const ext of this.extensions) {
		const handlers = ext.handlers.get("message_end");
		if (!handlers || handlers.length === 0) continue;

		for (const handler of handlers) {
			try {
				const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
				const handlerResult = (await handler(currentEvent, ctx)) as MessageEndEventResult | undefined;
				if (!handlerResult?.message) continue;

				if (handlerResult.message.role !== currentMessage.role) {
					this.emitError({ ... }); // 角色必须一致
					continue;
				}
				currentMessage = handlerResult.message; // 链式替换
				modified = true;
			} catch (err) { ... }
		}
	}
	// ...
}
```

### 3.4 接线：agent 事件 → 扩展事件

底层 agent-loop 发的是 `AgentEvent`，扩展系统发的是 `ExtensionEvent`，两者在 `agent-session.ts` 的 `_emitExtensionEvent` 里**一对一桥接**：

```ts
private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
	if (event.type === "agent_start") {
		this._turnIndex = 0;
		await this._extensionRunner.emit({ type: "agent_start" });
	} else if (event.type === "turn_start") {
		const extensionEvent: TurnStartEvent = {
			type: "turn_start",
			turnIndex: this._turnIndex,
			timestamp: Date.now(),
		};
		await this._extensionRunner.emit(extensionEvent);
	} else if (event.type === "turn_end") {
		const extensionEvent: TurnEndEvent = {
			type: "turn_end",
			turnIndex: this._turnIndex,
			message: event.message,
			toolResults: event.toolResults,
		};
		await this._extensionRunner.emit(extensionEvent);
		this._turnIndex++;
	} else if (event.type === "message_start") {
		await this._extensionRunner.emit({ type: "message_start", message: event.message });
	} else if (event.type === "message_end") {
		const extensionEvent: MessageEndEvent = { type: "message_end", message: event.message };
		const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
		if (replacement) {
			this._replaceMessageInPlace(event.message, normalized);
		}
	}
	// ... tool_execution_* 同理 ...
}
```

**架构小结**：`agent-loop.ts` 保持纯净（零插件概念）→ `agent-session.ts` 做事件桥接 → `extensions/runner.ts` 做分发与错误隔离 → 插件通过 `pi.on()` 订阅。**每一层都只依赖下一层抽象，可以单独测试。**

---

## 4. 上下文压缩：compaction

> 源码：`packages/coding-agent/src/core/compaction/compaction.ts`

PI Agent 的上下文压缩叫 **compaction**（压实）。核心思想：**用一次 LLM 调用把过长的历史对话压成一个结构化摘要，旧消息被丢弃，新上下文 = 摘要 + 最近保留的消息**。这是纯函数模块，I/O 和 session 重载由 session-manager 负责。

### 4.1 触发判定

```ts
export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;   // 为输出预留的 token，默认 16384
	keepRecentTokens: number; // 保留的最近 token 数，默认 20000
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}
```

即：**当前上下文 token 数 > 模型上下文窗口 - 预留输出 token 数** 时触发。token 数优先取 provider 返回的真实 `usage.totalTokens`，没有则用 `estimateTokens`（`chars/4` 启发式，故意保守高估）。

### 4.2 找裁剪点

保留"最近 N 个 token"，但裁剪点**绝不落在 toolResult 中间**（tool result 必须紧跟其 tool call），所以 `findCutPoint` 从后往前累计 token 预算，再落到最近的合法切割点：

```ts
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		const messageTokens = sessionEntryToContextMessages(entry).reduce(
			(sum, message) => sum + estimateTokens(message),
			0,
		);
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;

		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}
	// ...
}
```

如果裁剪点落在某一轮对话中间（`isSplitTurn`），还会把这一轮的前半段单独做一次"turn prefix 摘要"，保证被保留的后半段有足够上下文（`TURN_PREFIX_SUMMARIZATION_PROMPT`）。

### 4.3 摘要生成的提示词

两次压缩用的是**两套不同的 prompt**：第一次用 `SUMMARIZATION_PROMPT`（从零生成），后续用 `UPDATE_SUMMARIZATION_PROMPT`（增量合并上次摘要）。这是 PI 压缩质量的关键差异点：

```ts
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it
...`;
```

system prompt 也很克制，核心就一句"只输出摘要，不要继续对话"：

```ts
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
```

### 4.4 完整压缩流程 `compact`

`prepareCompaction` 先算出"要摘要什么、从哪开始保留、文件操作统计"，`compact` 再执行 LLM 调用并产出最终摘要：

```ts
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	// ...
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// 1. 摘要被压缩的历史（支持 split turn 时额外摘要 turn 前缀并合并）
	let summary: string;
	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// ... generateSummaryWithUsage(messagesToSummarize, ...previousSummary) 增量更新
		// ... generateTurnPrefixSummary(turnPrefixMessages)
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
	} else {
		// 直接走 generateSummaryWithUsage
		const result = await generateSummaryWithUsage(messagesToSummarize, model, settings.reserveTokens, /* ... */);
		summary = result.text;
	}

	// 2. 追加"读/改过哪些文件"的清单 —— 这是后续继续工作的关键上下文
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		usage: summaryUsage,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}
```

`generateSummaryWithUsage` 里最关键的两点：

1. **把对话序列化成纯文本**并用 `<conversation>...</conversation>` 包起来，避免模型"接着往下续写"而不是"总结"：
```ts
const conversationText = serializeConversation(llmMessages);
let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
if (previousSummary) {
	promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
}
promptText += basePrompt;
```
2. **摘要请求独立路由**：`cacheRetention: "none"` + 独立 `sessionId`，防止摘要请求污染正常对话的缓存；并用 `retryAssistantCall` 包装以支持流中断重试。

另外压缩过程中会**跨消息抽取文件操作**（`read`/`edit` 了哪些文件，来自上一轮 compaction 的 details 和本次消息里的 tool call），保证新会话能立刻知道改过什么。

---

## 5. Skills 加载机制

> 源码：`packages/coding-agent/src/core/skills.ts`、`docs/skills.md`、`system-prompt.ts`、`agent-session.ts`（`_expandSkillCommand`）

Skills 是 PI 的"可插拔能力包"：**一个目录 = 一个 skill**，实现的是 **Agent Skills 标准**（`agentskills.io`）。整个体系的核心设计是 **渐进式披露（progressive disclosure）**：上下文里永远只放最少的东西，其余内容按需"放进来"。

### 5.1 三层结构：Meta 数据 / 内容 / 脚本

一个 skill 目录是**三层结构**，只有 `SKILL.md` 是必需的，其余全部自由发挥：

```
my-skill/
├── SKILL.md              # 第 1 层(meta) + 第 2 层(内容)：front-matter 元数据 + Markdown 指令
├── scripts/              # 第 3 层(脚本)：辅助脚本，模型用 bash 按需执行
│   └── process.sh
├── references/           # 参考文档，按需用 read 加载（不进上下文）
│   └── api-reference.md
└── assets/               # 资源文件，由脚本/指令引用
    └── template.json
```

#### 第 1 层：Meta 数据（front-matter）

```yaml
---
name: my-skill                 # 必填：1-64 字符，小写 a-z / 0-9 / 连字符
description: "... 一句话描述"   # 必填：<=1024 字符，决定模型何时加载它
license: MIT                   # 可选：许可证
compatibility: linux x64       # 可选：<=500 字符，环境要求
metadata: {}                   # 可选：任意键值
allowed-tools: bash read       # 可选：预批准的工具（实验性）
disable-model-invocation: false # 可选：true 则隐藏出系统提示词，只能 /skill:name
---
```

第 1 层是**唯一常驻上下文**的部分 —— 它决定了"这个 skill 是干嘛的、什么时候该用"。模型**完全靠 `description` 做触发匹配**（见 5.7）。

#### 第 2 层：内容（SKILL.md 正文）

````markdown
# My Skill

## Setup
Run once before first use:
```bash
cd /path/to/skill && npm install
```

## Usage
```bash
./scripts/process.sh <input>
```
````

正文是"操作手册"：`Setup`（一次性准备）+ `Usage`（怎么调用脚本）。它用**相对路径**引用第 3 层的脚本/资源，相对基准是 skill 目录。

#### 第 3 层：脚本（scripts/ 等）

放可执行脚本、参考文档、资源文件。**这一层没有专门的 loader** —— 它不会被"加载"，而是由模型按需执行（见 5.6）。

> 下面 5.2~5.5 讲的正是第 1、2 层（`SKILL.md`）如何被扫描、校验、合并、注入；第 3 层（脚本）的执行机制在 5.6。

### 5.2 发现规则

```ts
/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	return loadSkillsFromDirInternal(dir, source, true);
}

function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): LoadSkillsResult {
	// ...
	for (const entry of entries) {
		if (entry.name !== "SKILL.md") continue;   // 只认 SKILL.md
		// ...读取并返回，不再递归（skill 根）...
	}

	for (const entry of entries) {
		// 跳过 dotfiles / node_modules / 被 ignore 规则命中的路径
		if (isDirectory) {
			const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
			// 递归找子目录的 SKILL.md
		}
		if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) continue;
		const result = loadSkillFromFile(fullPath, source);
		// 根目录下直接放 .md 文件也算一个 skill
	}
}
```

注意它遵守 `.gitignore` / `.ignore` / `.fdignore` 规则（`addIgnoreRules`），并且符号链接会被解析跟随。

### 5.3 解析与校验：第 1 层（meta）的解析

skill 的元数据来自 `SKILL.md` 的 front-matter，`name` 可显式声明，缺省时用父目录名：

```ts
export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
}

function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const rawContent = readFileSync(filePath, "utf-8");
	const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
	const skillDir = dirname(filePath);
	const parentDirName = basename(skillDir);

	// 校验 description（必填，最长 1024 字符）
	const descErrors = validateDescription(frontmatter.description);
	// 校验 name（小写 a-z、数字、连字符，最长 64）
	const name = frontmatter.name || parentDirName;
	const nameErrors = validateName(name);

	// 描述完全缺失则跳过该 skill，其余只是 warning 级别
	if (!frontmatter.description || frontmatter.description.trim() === "") {
		return { skill: null, diagnostics };
	}

	return {
		skill: {
			name,
			description: frontmatter.description,
			filePath,
			baseDir: skillDir,
			sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}
```

### 5.4 多来源合并与冲突处理

`loadSkills` 聚合了三个来源：**全局 `~/.pi/skills/`（user）→ 项目 `.pi/skills/`（project）→ 显式 `skillPaths`**。用 `Map<name, Skill>` 去重，同名 skill 记录一条 `collision` 诊断（不会静默覆盖）：

```ts
function addSkills(result: LoadSkillsResult) {
	for (const skill of result.skills) {
		const realPath = canonicalizePath(skill.filePath); // 解析符号链接以检测重复文件
		if (realPathSet.has(realPath)) continue;            // 同一文件通过链接重复加载则跳过

		const existing = skillMap.get(skill.name);
		if (existing) {
			collisionDiagnostics.push({
				type: "collision",
				message: `name "${skill.name}" collision`,
				path: skill.filePath,
				collision: { resourceType: "skill", name: skill.name, winnerPath: existing.filePath, loserPath: skill.filePath },
			});
		} else {
			skillMap.set(skill.name, skill);
			realPathSet.add(realPath);
		}
	}
}
```

### 5.5 注入系统提示词：第 1 层（meta）进场

加载完的 skills 通过 `formatSkillsForPrompt` 序列化成 **Agent Skills 标准格式的 XML**，拼进 system prompt。模型看到 `<available_skills>` 后，遇到匹配任务就会用 `read` 工具去加载具体 skill 文件：

```ts
export function formatSkillsForPrompt(skills: Skill[]): string {
	// disableModelInvocation=true 的 skill 不进提示词，只能通过 /skill:name 显式调用
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
	if (visibleSkills.length === 0) return "";

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");
	return lines.join("\n");
}
```

**设计妙处**：system prompt 里只有"名字 + 一句话描述 + 文件路径"，非常省 token；真正的内容按需用 `read` 加载。这也是 PI 能把系统提示词压到 ~1K token 的原因之一。

### 5.6 脚本是如何"加载"与执行的（第 3 层）

这是最容易误解的地方：**脚本层根本没有"加载"这一步**。它不参与 `loadSkills` 的扫描、不进任何注册表、也不进上下文。它只是一些躺在 skill 目录里的文件，靠 **`baseDir` 锚点 + 相对路径约定** 被模型在运行时按需执行。

回顾 `Skill` 对象（5.3），加载器为每个 skill 记下了它的目录：

```ts
skill: {
	name,
	description: frontmatter.description,
	filePath,             // SKILL.md 的绝对路径
	baseDir: skillDir,    // ← 脚本相对路径的解析锚点
	sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
	disableModelInvocation: frontmatter["disable-model-invocation"] === true,
}
```

#### 执行链路：靠系统提示词里的约定

脚本之所以能被"找到并执行"，靠的是注入系统提示词里那句硬规则（正是 5.5 里 `formatSkillsForPrompt` 开头那几行）：

```
When a skill file references a relative path, resolve it against the skill
directory (parent of SKILL.md / dirname of the path) and use that absolute
path in tool commands.
```

于是完整的执行链路是：

```
1. 模型用 read 工具读取 SKILL.md          → 拿到第 2 层指令
2. SKILL.md 里写着 ./scripts/process.sh    → 相对 skill 目录的路径
3. 模型按约定解析出绝对路径 {baseDir}/scripts/process.sh
4. 模型用 bash 工具执行该绝对路径          → 第 3 层脚本真正被"加载"（= 被运行）
```

**所以"脚本的加载" = "脚本的执行"**，而且时机完全由模型决定：`read` 加载内容、`bash` 执行脚本，两个都是普通工具调用，没有魔法。

> 安全提示（官方文档原文加粗的警告）："Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use." —— 脚本是**模型会直接执行的可执行代码**，加载/安装第三方 skill 前务必人工审查。

### 5.7 两种调用时机

第 3 层脚本什么时候跑、第 2 层内容什么时候进上下文，取决于 skill 是被哪种时机触发的：

#### 时机 A：模型自动触发（progressive disclosure，默认）

```
启动扫描 ──► 只把第 1 层(name+description+location) 注入系统提示词
                 │
                 ▼
        模型根据 description 判断"这个任务匹配某个 skill"
                 │
                 ▼
        read 工具按 location 加载 SKILL.md（第 2 层进场）
                 │
                 ▼
        按正文指令执行 scripts/（第 3 层进场）
```

每一层都在"更晚的时机"才进入上下文，上下文占用最小。但官方文档明确提醒：**"models don't always do this"** —— 模型并不总是自觉去 `read`，所以自动触发是"尽力而为"的。

#### 时机 B：用户手动触发 `/skill:name`（强制注入）

`/skill:name args` 会被 `agent-session.ts` 的 `_expandSkillCommand` **急切地**把 SKILL.md 全文塞进对话（跳过第 1 层的触发判断，直接注入第 2 层）：

```ts
private _expandSkillCommand(text: string): string {
	if (!text.startsWith("/skill:")) return text;

	const spaceIndex = text.indexOf(" ");
	const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

	const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
	if (!skill) return text; // Unknown skill, pass through

	const content = readFileSync(skill.filePath, "utf-8");
	const body = stripFrontmatter(content).trim();       // 剥掉第 1 层，只留第 2 层正文
	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	return args ? `${skillBlock}\n\n${args}` : skillBlock;  // 参数以 User 身份追加
}
```

几个关键点：

- `/skill:name extract` 会把参数 `extract` 拼在 skill 内容后面作为 `User: extract`，等于"加载 skill 并带上本次任务"；
- **`disable-model-invocation: true` 的 skill 只有这一条路**——它不出现在系统提示词里，模型永远不会自己触发，只能由用户（或上层调用方）显式 `/skill:` 调用；
- 这个命令可以通过 `settings.json` 的 `enableSkillCommands` 开关（默认开启）关闭。

#### 两种时机怎么选

| | 时机 A：模型自动触发 | 时机 B：`/skill:name` 强制 |
|---|---|---|
| 谁发起 | 模型根据 description 判断 | 用户 / 上层代码显式指定 |
| 第 1 层（meta） | 是触发依据（常驻） | 被剥掉，不参与 |
| 第 2 层（内容） | `read` 后按需进入 | 立即内联进对话 |
| 可靠性 | 尽力而为（模型可能不 read） | 100% 生效 |
| 适用场景 | 通用、安全、低成本的 skill | 关键任务、有副作用、`disable-model-invocation` 的 skill |

### 5.8 最佳实践：三层如何各司其职

把"三层结构 × 两个调用时机"合起来看，最佳实践的本质是：**让每一层只做它该做的事，并在它该出场的时间出场**。

| 层 | 出场时机 | 职责 | 设计原则 |
|---|---|---|---|
| **第 1 层 Meta** | 常驻上下文（从启动开始） | "检索卡片"：我是谁、何时该用 | `description` 要**具体到触发场景**，它是自动触发的唯一依据 |
| **第 2 层 内容** | 触发后（`read` 或 `/skill:`） | "执行手册"：怎么用 | 保持精简，只写操作步骤；深度内容挪到 `references/` |
| **第 3 层 脚本** | 执行时（模型调 bash） | "干活的人"：真正的原子能力 | 逻辑放脚本，SKILL.md 只负责"告诉模型怎么调" |

#### 具体建议

**① description 决定触发准确率 —— 把"何时该用"写进去**

> Good：`description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.`
>
> Poor：`description: Helps with PDFs.`

模型只在任务匹配时才会去 `read` SKILL.md，所以描述里必须写明触发场景，而不是泛泛的能力描述。

**② 保持 SKILL.md 精简，把重内容后置**

SKILL.md 是"目录"，不是"全书"。几千行的实现细节、API 参考放 `references/`，脚本逻辑放 `scripts/`。这样 `read` 一次只加载一小块，渐进式披露的收益才最大化。

**③ 用相对 skill 目录的路径引用脚本**

````markdown
## Usage
```bash
./scripts/process.sh <input>     # ✓ 相对路径，跨机器可移植
```
````

配合系统提示词里的约定，模型会自动把 `./scripts/...` 解析成 `{baseDir}/scripts/...`。绝对路径会破坏可移植性。

**④ Setup 单独成段，一次性准备写清楚**

把依赖安装、初始化步骤放进 `## Setup`，让模型在首次使用时先执行一次，避免"脚本报错 → 不知道少了哪步"。

**⑤ 需要保证命中时，显式用 `/skill:name`**

不要赌模型"一定会去 read"。关键路径、有副作用、耗时的任务，用 `/skill:name` 强制注入更稳。

**⑥ 敏感能力用 `disable-model-invocation: true`**

危险命令、需要人工确认的 skill，隐藏出系统提示词，只允许显式调用 —— 把"自动触发的风险"关在门外。

**⑦ 一句话总结三层的最佳结合时机**

> **Meta 层负责"被找得到"（常驻、触发判断），内容层负责"被读得到"（触发后、按需加载），脚本层负责"被跑得了"（执行时、bash 调用）** —— 上下文里永远只有检索卡片，执行手册按需进场，真正干活的脚本最后才被拉起。

---

## 6. 对你有什么用：能力盘点与启发

前 5 章把 PI Agent 的实现拆成了 5 大机制，这一章换个视角：**读这篇文章的你，能从 PI Agent 里拿走什么？** 我总结为三个层面——一套通用的方法论（Skills 最佳实践）、一串可以直接复用的扩展点（`register*` 全家桶）、一个 agent 产品化的工程范例（Harness）。

### 6.1 Skills 最佳实践：不绑定 PI 的通用方法论

第 5 章的结论放在任何一个 agent 工具上都成立。因为 **Agent Skills 已经是社区标准**（`agentskills.io`），Claude Code / Cursor / opencode 等工具都遵循"SKILL.md + front-matter + 按需读取"的同一套约定——**你写好的 SKILL.md，换个工具也能用**。

从 PI 的实现里可以提炼 4 条可迁移原则：

| 原则 | PI 里的依据 | 怎么落地 |
|------|------------|---------|
| **meta 越瘦越好** | 常驻上下文只有 name + description（5.5） | description 介绍**功能 + 触发场景**，让模型判断"这是什么、什么时候该用" |
| **正文按需加载** | read 工具的渐进式披露（5.7 时机 A） | SKILL.md 正文是操作手册，不是宣传册 |
| **脚本用相对路径** | baseDir 锚点 + 相对路径约定（5.6） | 引用 `./scripts/xxx`，跨机器可移植 |
| **敏感能力藏起来** | `disable-model-invocation`（5.7 时机 B） | 有副作用/危险的操作只留 `/skill:` 显式入口 |

**落地实验**：把你高频的操作（环境初始化、代码评审 checklist、发布流程）沉淀成 3~5 个 SKILL，装进 `~/.agents/skills/`，立刻体验"目录即能力"——这也是 opencode 这类工具使用 skills 的方式。

### 6.2 register* 全家桶：核心可以任意扩展

把第 2、3 章串起来看，会发现 PI 的"能力"几乎全部来自注册表而不是硬编码：

| 注册入口 | 注册什么 | 消费方 |
|---------|---------|--------|
| `registerTool` | 工具定义（2.4 刷新链路） | LLM 的 tool calling |
| `registerEvent` / `on` | 生命周期回调（3） | 事件系统分发 |
| `registerProvider` | 模型 provider | Agent Loop 的模型调用 |
| `registerPromptTemplate` | 可显式调用的 prompt | `promptFromTemplate()` |
| Skills（resources） | 按需加载的指令集 | `<available_skills>` + `/skill:name` |

**一句话启发**：把"能力清单"从硬编码改成注册表，核心就能永远保持小且稳定——这正是开闭原则（OCP）：**对扩展开放、对修改关闭**。与传统"继承基类、实现接口"的插件体系相比，`register*` 的方向是反的：宿主不假设你要干什么，你交一个回调它就完事，插件零样板、宿主零改动。

### 6.3 Harness：把机制变成产品

第 1~5 章的所有机制，最终在 `packages/agent/src/harness/agent-harness.ts` 的 `AgentHarness` 里被捏成一个"开箱即用的 agent 外壳"。它回答了 agent 产品化的三个问题：

**怎么塞能力？** 构造时传入 `resources`（skills + promptTemplates），运行中可以 `setResources()` 热更新，无需重建会话。

**怎么被外部驱动？** 1.5 的队列机制在 Harness 里变成公开 API：`prompt()` / `steer()` / `followUp()` / `nextTurn()`，外加 `skill(name)` / `promptFromTemplate(name)` 这类显式调用——所以 TUI、RPC、GUI 都只需薄薄一层就能接上它。

**怎么被观测和控制？** 循环的每个阶段都 emit 事件（3）；工具上下文支持"静态对象 或 每轮快照懒求值"两种来源（呼应 2.4 的快照语义）；同时提供 `abort()` / `shutdown()` / `waitForIdle()` 这类面向真实进程的生命周期管理，会话还能用 MemoryRepo / JSONL 持久化。

**启发**：agent 库和 agent 产品之间隔着一层 Harness。如果你的 agent 也把"循环、资源、会话、控制"四层分开，就能同时服务 CLI、GUI、RPC 三种形态，而不是写成只能跑一个终端的 demo。

## 总结

PI Agent 的 5 大机制是层层嵌套、互相成就的：

```
Skills 加载 ──► 注入 system prompt
                     │
                     ▼
               Agent Loop ◄── 时机监听（事件系统）订阅了它的每一步
                     │
                     ▼
           上下文压缩（compaction）── 在循环的 transformContext 钩子处生效
                     │
                     ▼
         插件化架构（register*）── 事件系统、工具、provider 全部由插件注册而来
```

- **Agent Loop** 是一个纯净的双层循环，把"调模型 / 执行工具 / 穿插消息"抽象成状态机；
- **插件化架构** 用一组 `register*` 函数把一切能力外置，核心零改动；
- **时机监听** 像 webpack 一样覆盖全生命周期，before 事件可拦截、waterfall 事件可改写；
- **上下文压缩** 用结构化摘要 + 增量更新 + 文件操作追踪，让 agent 永不撑爆上下文；
- **Skills 加载** 用"目录即能力 + XML 注入 + 按需读取"实现最省 token 的能力扩展。

> 完整源码：`github.com/badlogic/pi-mono`（commit `74caa26`）
