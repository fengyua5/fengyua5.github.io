---
title: Pi Agent 的 CodeMode：让 Agent 写代码，而不是刷 600 次工具调用
date: 2026-10-27 10:20:00
tags: [pi-agent, codemode, mcp, agent, llm]
categories: AI
cover: /img/covers/codemode-cover.jpg
---

![Pi Agent 的 CodeMode：让 Agent 写代码，而不是刷 600 次工具调用](/img/covers/codemode-cover.jpg)

Pi Agent 1.0 之前，团队的态度很明确：**不要 MCP，不要一堆自定义工具，让 Agent 直接写 shell 和代码**。理由也很硬——工具声明要占上下文，工具返回也要占上下文，一个稍微复杂点的任务，模型读到的 80% 内容都是“中间结果”。

然后 Pi 1.0 把 MCP 内置了。看上去像打脸，其实不是：他们顺手把「用代码调工具」做成了框架的一等能力，叫 **Codemode**。MCP 是附带的，Codemode 才是主角。

我这篇不聊概念，直接拿一个业务场景算账——**200 条待审核的售后退单**，分别用「传统 tool calling」和「Codemode」跑一遍，看上下文里到底进了多少东西。（下面的 MCP server 名和字段名是示例，结构照着真实售后中台抄的。）

<!-- more -->

## 0. 先说结论

| | 传统 tool calling | Codemode |
|---|---|---|
| 进上下文的 token（200 单） | ≈ 180K（原始数据 540KB），中途 compaction | ≈ 3K，一次到位 |
| LLM 往返轮次 | ≈ 270 轮 | 2 轮 |
| 工具调用次数 | 600 次 | 600 次（一样多，但不经过模型） |
| 能排序 / 去重 / 聚合吗 | 靠模型心算，必错 | JS 一行 |
| 同一任务可复现吗 | 每次跑法都不一样 | 脚本可存档、可单测、可 review |

**Codemode 没有让 Agent 多一个能力，它改的是「工具调用长什么样」：从「发一段 JSON function call」变成「写一段程序」。**

这个改动看着小，但在批量场景下是数量级差异。下面拆开讲。

---

## 1. Codemode 到底是什么

一句话：**`codemode` 是一个工具，它的参数不是 JSON，而是一段 JavaScript 源码。**

模型调用它，等于往 Pi 的沙箱里丢一段脚本；脚本里通过 `tools.<name>(args)` 调用其它工具、通过 `models.classify()` / `models.generateImages()` 跑非对话模型；**只有脚本的 `return` / `text()` 输出会回到模型的上下文**。

沙箱的运行位置很关键，Pi 官方博客里把它分得很清楚：

```
Harness（大脑：可信主机）
  ├─ Agent Loop / 上下文 / Session
  └─ Codemode 沙箱（QuickJS + WASM）
       无网络、无文件系统、无 timer、256MB 内存
       唯一出口 = 调更多工具
              │
              │ 工具调用（真实执行）
              ▼
Execution Environment（手脚：bash 所在处）
  └─ 可被 Gondolin 之类方案单独沙箱化
```

所以 Codemode 不是「在服务器上跑代码」，而是「**在 harness 里编排工具调用**」。代码本身不可信，但它能碰的东西只有工具列表——文件、网络、数据库全得经过工具。

### 1.1 脚本能用的全局变量

| 全局 | 作用 |
|---|---|
| `tools.<name>(args)` | 调用任意工具。名字里非法字符变 `_`，MCP 的 `mcp__sentry__find_projects` 就是 `tools.mcp__sentry__find_projects` |
| `text(v)` / `return v` | 把值加到输出。字符串原样，其它走 JSON |
| `image(v)` | 把 base64 图片送回模型，同时落一份临时文件 |
| `console.log(...)` | 输出到 `<console_output>` 块 |
| `store(k, v)` / `load(k)` | **跨脚本**存小 JSON 状态（单值 ≤ 256K 字符，总量 ≤ 1MB） |
| `ALL_TOOLS` | 所有可调用工具的 `{name, description}` |
| `searchTools(q, opts)` | BM25 检索工具，默认返回 8 条 |
| `describeTool(n)` / `describeNamespace(n)` | 按需取某个工具的完整声明 |
| `models` | 分类模型 / 图像模型 |

注意 `store` / `load`：**它把状态写进 session transcript**，不是写文件。所以“上一段脚本算出来的 200 条明细，下一段脚本接着用”是可以的，而且 fork 分支时天然隔离（每个分支只看到自己路径上写的值）。

### 1.2 脚本不是 JSON，也不带 markdown 围栏

```js
// @options: {"max_output_tokens": 2500, "timeout_ms": 180000}

const r = await tools.bash({
  command: "gh issue list --limit 5 --json number,title",
});
const issues = JSON.parse(r.output);
return issues.map((i) => `#${i.number} ${i.title}`);
```

几个硬规则：

- **options 行必须是第一行**，写在别处会在脚本执行前直接失败
- 脚本被当作一个 async 函数的函数体，所以顶层 `await` / `return` 都合法
- `bash` 返回的是结构化对象 `{ output, truncated, full_output_path, exit_code, wall_time_seconds }`，`output` 上限 **1MiB**，比给模型看的 2000 行 / 50KB 大得多
- 脚本结束（`return` / `exit()` / 超时）时，**还在跑的调用会被取消，没 await 的 Promise 直接丢弃**

### 1.3 工具怎么暴露给模型

这是 Codemode 最容易被忽略的设计。每个 MCP server 有一个 `exposure` 设置：

| exposure | 行为 | 适合 |
|---|---|---|
| `codemode`（默认） | 不进模型上下文，只能从脚本里调 | 大多数 MCP |
| `deferred` | 等 `tool_search` 找到才加载 | 工具非常多的 server |
| `direct` | 像内置工具一样直接声明给模型 | 天天用的那两三个 |
| `hidden` | 完全不可达 | 危险操作 |

同时 `codemode.mode` 控制“其它工具怎么呈现”：

- `on`（默认）：已声明的工具仍然声明，只是描述里附上“如何从脚本调用”
- `only`：已声明的工具全部藏起来，只在 `codemode` 的说明里列出，**模型只能通过脚本调用它们**

`only` 是省 token 最狠的一档。`codemode` 描述里内联的工具声明共享 **3000 tokens 预算**（`codemode.inlineBudget`），超了就得靠 `searchTools()` 现场查。

> 一个容易踩的坑：`store()` 的写入**只在脚本成功时才落盘**，脚本失败就全丢。所以“边跑边存档做断点续跑”这个思路在 Codemode 里不成立，后面售后案例我会专门讲怎么绕。

---

## 2. 场景：200 条待审核的退单

设定一个再常见不过的客服中台需求：

> **每天早上 9 点，把过去 24 小时提交的退单过一遍：能自动通过的自动通过，需要人工的挑出来，附上理由，按金额从大到小排。**

数据散在三个系统里，都用 MCP 接进来了：

| 工具 | 作用 | 单次返回体积 |
|---|---|---|
| `mcp__aftersale__list_refund_requests` | 拉待审核清单 | 200 单 ≈ 60KB |
| `mcp__order__get_order` | 订单详情（商品、金额、支付时间） | ≈ 1.2KB |
| `mcp__logistics__track` | 物流轨迹（含签收时间、异常码） | ≈ 0.9KB |
| `mcp__policy__match_rules` | 命中的售后规则 | ≈ 0.6KB |
| `mcp__payment__refund` | 发起退款 | 极小 |

再加一个分类模型（Jev）把「用户原话」翻成结构化标签。整套判定逻辑大概 30 行 if-else。

听起来就是“写个脚本跑批”的活。但 Agent 的默认形态不是脚本，是**一次一次的工具调用**。

---

## 3. 不用 Codemode：把 200 单拆成 270 轮对话

### 3.1 先老老实实定义工具

Pi 的扩展体系里，一个工具长这样（`pi.registerTool` 那一套）：

```ts
export const getOrder = defineTool({
  name: "get_order",
  description: `查询订单详情。返回商品 SKU、实付金额、支付方式、下单时间、
    发货时间。注意：不含物流轨迹，物流请用 get_logistics；
    不含售后规则，规则请用 match_policy_rules。`,
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => {
    const order = await db.orders.find(orderId);
    if (!order) throw new Error(`order ${orderId} not found`);
    return order;
  },
});

pi.registerTool(getOrder);
pi.registerTool(listRefundRequests);
pi.registerTool(getLogistics);
pi.registerTool(matchPolicyRules);
pi.registerTool(createRefund);
// ……一共 12 个
```

12 个工具，平均每个描述 300 tokens ≈ **3.6K tokens 常驻**。这个数字还好，真正的问题在后面。

### 3.2 模型只能一单一单来

你写在 prompt 里的需求是这样的：

```
下面是 200 个待审核退单的 orderId。请逐个处理：
1. 查订单，确认实付金额和发货时间
2. 查物流，确认是否签收、是否有延迟异常
3. 匹配售后规则
4. 判断是否满足七天无理由 / 是否需要二级审批
5. 输出结论
```

模型的实际执行轨迹（这是典型的一段 transcript）：

```
[turn 1]  → get_order × 3            （R…001 / 002 / 003）
[turn 2]  ← 3 份订单 JSON（≈3.6KB）
          → get_logistics × 3
[turn 3]  ← 3 份物流 JSON（≈2.7KB）
          → match_policy_rules × 3
[turn 4]  ← 3 份规则 JSON
          → 复述结论："第 1 单：金额 899，已签收 3 天，
             符合七天无理由，建议自动通过。第 2 单：……"
          → get_order × 3（下一批）
...
```

**注意 turn 4 那个“第 1 单…第 2 单…”**。这就是传统 tool calling 最贵的地方：模型必须把工具结果**复述成自然语言**，才能进入下一步判断。这些复述既是输出 token，又会在下一轮作为输入再读一遍。

而更致命的是：**它没法“记住”已经处理过的前 100 单**。你让它最后“按金额排序”，它只能照着上下文里残留的片段重新数一遍，数到第 60 单左右就开始错。

### 3.3 算一下账

按上面单次返回体积，公式很直白：

```
每单上下文成本 = (订单 1.2KB + 物流 0.9KB + 规则 0.6KB) / 4 ≈ 675 tokens
再加模型的复述 ≈ 225 tokens
→ 每单 ≈ 900 tokens
```

| 单量 | 工具结果进上下文的 token | 会发生什么 |
|---|---|---|
| 20 单 | ≈ 18K | 还行，但已经比需求本身大 30 倍 |
| 50 单 | ≈ 45K | 开始漏单、重复处理 |
| 200 单（只算原始数据） | ≈ 135K | 已占掉 200K 窗口的三分之二 |
| 200 单（含复述） | ≈ **180K** | 逼近窗口上限，触发 compaction |

而且 compaction 一触发，被压掉的恰恰是**明细**——摘要里只会留下“已处理约 120 单，发现若干异常”。等你回头问“第 87 单为什么自动通过了”，它答不上来。

> 这组数字是按上面 KB 数算的，你把 `1.2KB` 换成自己业务的真实返回体积，就能复算出自己的账。结论的形状不会变：**成本正比于「单量 × 单条数据体积」，而这两项都是业务给的，你改不了。**

### 3.4 工程上通常会打三个补丁

**补丁一：合并成大工具。**

```ts
export const getRefundContext = defineTool({
  name: "get_refund_context",
  description: "一次性返回退单关联的订单、物流、规则，减少往返。",
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => {
    const [order, trace, rules] = await Promise.all([
      db.orders.find(orderId),
      logistics.track(orderId),
      policy.match(orderId),
    ]);
    return { order, trace, rules };
  },
});
```

轮次从 3 降到 1，**但 token 一点没少**——2.7KB 该进还是进。你只是把三次灌水改成一次灌水。

**补丁二：让模型自己写 bash + curl。**

问题是 MCP 工具**根本不在 shell 里**。模型写 `curl` 打不到 `mcp__order__get_order`，除非你另建一套 HTTP 网关——那等于自己把 MCP 又实现了一遍。

**补丁三：加一个“批量查询”工具，内部循环。**

```ts
execute: async ({ orderIds }) => Promise.all(orderIds.map(fullContext))
```

好，200 单一次返回 **540KB**。工具调用是省了，上下文直接爆在第一次调用上。

**补丁三其实是正确答案的一半**——它说明「批量这件事必须由代码做」。但它错在：**代码写死在工具里，判定逻辑仍然得由模型来**。Codemode 干的，就是把这一半补全：**让模型自己写那段代码，而且写在能看见全部数据的地方。**

---

## 4. 用 Codemode：一次脚本，200 单

同一套 MCP server，什么都不用改。区别只是模型不再逐个调用工具，而是**写一个程序**。

### 4.1 脚本一：预审

```js
// @options: {"max_output_tokens": 2500, "timeout_ms": 180000}

// ── 1. 拉清单，输出不进模型上下文
const list = await tools.mcp__aftersale__list_refund_requests({
  status: "pending_review",
  limit: 200,
});
const requests = list.structuredContent?.requests ?? [];

// ── 2. 三路并发补齐（Pi 限 4 并发，其余自动排队）
const enriched = await Promise.all(
  requests.map(async (r) => {
    const [order, track, rules] = await Promise.allSettled([
      tools.mcp__order__get_order({ orderId: r.orderId }),
      tools.mcp__logistics__track({ trackingNo: r.trackingNo }),
      tools.mcp__policy__match_rules({ sku: r.sku, reason: r.reason }),
    ]);

    const pick = (r) =>
      r.status === "fulfilled" ? r.value.structuredContent : null;

    const o = pick(order)?.order ?? null;
    const t = pick(track)?.trace ?? null;
    const p = pick(rules)?.rules ?? [];

    // ★ 只留判定字段，其余 99% 在这里丢掉，
    //   永远不会出现在模型上下文里
    return {
      id: r.id,
      orderId: r.orderId,
      amount: r.amount,
      reason: r.reason,
      description: (r.description ?? "").slice(0, 400),
      paidAt: o?.paidAt ?? null,
      deliveredAt: t?.deliveredAt ?? null,
      signed: t?.signed ?? false,
      delay48h: t?.events?.some((e) => e.code === "DELAY_48H") ?? false,
      ruleIds: p.map((x) => x.id),
      missing: [!o && "order", !t && "logistics", !p.length && "policy"]
        .filter(Boolean),
    };
  }),
);
```

到这里，**540KB（约 135K tokens）的原始数据已经在沙箱里被压成了 200 个 12 字段的对象**。上下文里到现在还是 0。

接着用分类模型处理「用户原话」——这块传统 tool calling 根本做不了，因为它不是工具：

```js
// ── 3. 用分类模型把自然语言翻成结构化标签
//     classify 不会 throw，要自己检查 stopReason
const jev = await models.getModelOfType(
  "classifier",
  "typesafe",
  "jev-latest",
);

const judged = await Promise.all(
  enriched.map((e) =>
    models.classify(jev, {
      state: {
        reason: e.reason,
        description: e.description,
        amount: e.amount,
        signed: e.signed,
      },
      questions: {
        category: {
          type: "choice",
          instructions: "这条退款申请的真实原因属于哪一类？",
          criteria: {
            quality: "质量问题、损坏、无法使用",
            wrong_item: "发错货、少发、与描述不符",
            no_longer_needed: "不想要了、买错了、七天无理由",
            logistics: "物流太慢、丢件、未收到",
            abuse: "疑似恶意：频繁退款、空包、调包",
          },
        },
        risk: {
          type: "score",
          instructions: "这单需要人工介入的程度有多高？",
          criteria: [
            "可自动通过",
            "自动通过但打标",
            "建议人工复核",
            "必须人工介入",
          ],
        },
      },
    }),
  ),
);
```

然后是最爽的部分——**判定逻辑用 JS 写，而不是用提示词求模型遵守**：

```js
// ── 4. 规则引擎：30 行 JS，比提示词可靠一万倍
const DAY = 86_400_000;
const now = Date.now();

const decisions = enriched.map((e, i) => {
  const j = judged[i];
  const ok = j.stopReason === "stop";
  const category = ok ? j.answers.category.choice : "unknown";
  const risk = ok ? j.answers.risk.score : 3; // 分类失败一律转人工
  const reasons = [];

  if (e.missing.length) reasons.push(`数据缺失:${e.missing.join(",")}`);
  if (!e.signed && category === "logistics") {
    reasons.push("物流显示未签收");
  }
  if (category === "no_longer_needed" && e.deliveredAt) {
    const days = (now - Date.parse(e.deliveredAt)) / DAY;
    if (days > 7) reasons.push("超出 7 天无理由窗口");
  }
  if (e.amount > 2000) reasons.push("金额超 2000 需二级审批");
  if (e.delay48h && category === "logistics") {
    reasons.push("物流异常工单未关闭");
  }

  let decision = "auto_approve";
  if (risk >= 3 || reasons.length > 0) decision = "manual";
  if (category === "abuse" && risk >= 2) decision = "reject_suggest";

  return { ...e, category, risk, reasons, decision };
});

// ── 5. 全量结果存进 transcript，下一段脚本还能用
store("refund_audit_20261027", decisions);

// ── 6. 只把摘要交给模型（这才是进上下文的东西）
const countBy = (k) =>
  decisions.reduce((m, d) => ((m[d[k]] = (m[d[k]] ?? 0) + 1), m), {});

return {
  total: decisions.length,
  byDecision: countBy("decision"),
  byCategory: countBy("category"),
  amountAtRisk: decisions
    .filter((d) => d.decision !== "auto_approve")
    .reduce((s, d) => s + d.amount, 0),
  top10: decisions
    .filter((d) => d.decision !== "auto_approve")
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)
    .map(
      (d) =>
        `${d.id} ¥${d.amount} ` +
        `[${d.category}/r${d.risk}] ` +
        `${d.reasons[0] ?? "低置信度"}`,
    ),
};
```

模型最终看到的，大概就是这几百个 token：

```
Script completed in 41.2s

==> text 1/1 <==
{
  "total": 200,
  "byDecision": {
    "auto_approve": 148, "manual": 46, "reject_suggest": 6
  },
  "byCategory": {
    "quality": 71, "no_longer_needed": 58, "logistics": 39,
    "wrong_item": 26, "abuse": 6
  },
  "amountAtRisk": 386420,
  "top10": [
    "R20261026087 ¥8999 [abuse/r3] 疑似恶意：30 天内第 4 次退款",
    "R20261026112 ¥6280 [quality/r2] 金额超 2000 需二级审批",
    "R20261026034 ¥4999 [logistics/r3] 物流异常工单未关闭",
    ...
  ]
}
```

它现在可以真的“看一眼并做决定”——因为它看到的是**结论**，不是 200 份原始 JSON。

### 4.2 脚本二：执行退款，以及一个必须知道的坑

模型看完摘要，说“自动通过那 148 单吧”，然后写第二段脚本：

```js
const decisions = load("refund_audit_20261027");
if (!decisions) throw new Error("预审还没跑，先跑上一段脚本");

const BATCH = 50;
const cursor = load("refund_cursor") ?? 0;
const approved = decisions.filter((d) => d.decision === "auto_approve");
const slice = approved.slice(cursor * BATCH, (cursor + 1) * BATCH);

const results = await Promise.allSettled(
  slice.map((d) =>
    tools.mcp__payment__refund({
      orderId: d.orderId,
      amount: d.amount,
      idempotencyKey: `refund:${d.id}`, // ★ 服务端幂等键，重跑不会重复退
      note: `codemode auto-approved, run 20261027`,
    }),
  ),
);

store("refund_cursor", cursor + 1);

const succeeded = results.filter(
  (r) => r.status === "fulfilled" && !r.value.isError,
);

return {
  batch: cursor,
  attempted: results.length,
  ok: succeeded.length,
  failed: results
    .map((r, i) => ({ r, d: slice[i] }))
    .filter(({ r }) => r.status === "rejected" || r.value.isError)
    .map(({ r, d }) => d.id),
};
```

**这里藏着一个我在文档里抠出来的坑：`store()` 只在脚本成功时落盘。**

所以你很容易写出这种“看起来能断点续跑”的代码：

```js
for (const d of approved) {
  await tools.mcp__payment__refund({ ... });
  store("done", [...done, d.id]);   // ❌ 中途失败，这条写入根本不存在
}
```

第 87 单抛错 → 脚本失败 → `store` 全部回滚 → 你以为的断点没存上，但**前 86 单的退款已经真实发生了**。工具调用不会回滚。

所以正确的做法只有两条，缺一不可：

1. **批次就是最小可重试单元**。一批 50 单，成功才 `store("refund_cursor")`。失败就重跑这一批。
2. **真正的防重靠服务端 `idempotencyKey`**，不靠脚本里的状态。

这条也顺便回答了「Codemode 适不适合做资金操作」：**适合，前提是你把幂等做在服务端。**

---

## 5. 两者的差别不只是省 token

把上面两条路并排放一下：

### 5.1 上下文

```
传统 tool calling
  ########################### 180K tokens ###########################
  └─ 其中 99.5% 是模型永远不需要"理解"的字段：商品标题、地址、物流站点编号……

Codemode
  # 3K
  └─ 工具声明 + 一段脚本 + 一份摘要
```

省下来的不只是钱，是**注意力**。上下文里塞满 200 单原始 JSON 的模型，跟只看 10 行摘要的模型，判断质量不是一个级别。

### 5.2 可复现性

传统方式：同一个任务跑两次，模型可能第一次按订单号顺序查、第二次按金额顺序查，中途插一句“我觉得应该先看金额大的”，然后你就没法解释为什么昨天自动通过了 148 单、今天只通过了 132 单。

Codemode：那段脚本就是**业务规则的源码**。可以存进 git、可以做 code review、可以写单测、可以回滚。这可能是 Codemode 被低估最多的一点——**它把 Agent 的行为从“提示词艺术”变成了“可以 diff 的代码”**。

### 5.3 失败处理

| | 传统 | Codemode |
|---|---|---|
| 单个调用失败 | 模型看到 error 文本，自己决定重试还是跳过（每次不一样） | `Promise.allSettled`，失败项进 `failed` 数组，规则固定 |
| 整体失败 | 上下文里留下半截状态，模型可能重复调用已成功的工具 | 脚本原子性差，但**批次边界清晰**，靠幂等键重跑 |
| 调试 | 翻 transcript，看模型当时“想”了什么 | 脚本本身可以拷出来在 Node 里跑（把 `tools` 打桩） |

最后一行值得展开：Codemode 脚本是一段**不依赖模型的纯文本**。你可以把它粘到一个 `.mjs` 文件里，用 mock 的 `tools` 对象跑一遍，验证“这 200 单里到底应该有 148 还是 132 单被通过”。**传统 tool calling 没有这个物件可以测。**

### 5.4 三个优点，一个代价

把上面这些收敛成一张表：

| | 传统 tool calling | Codemode |
|---|---|---|
| **① LLM 调用次数** | 每批次一次往返，200 单 ≈ 270 次 | 1~2 次 |
| **② 执行速度** | 串行：查一单 → 等模型 → 再查一单 | 脚本内并行，600 次调用压到几十秒 |
| **③ 稳定性** | 每一步都靠模型重新决策，同样输入未必同样输出 | 代码执行，同样的输入必然同样的输出 |
| **✗ 失败位置** | 崩在**调用之前**（参数校验、权限拦截），影响面是单次调用 | 崩在**运行之中**，前面的写操作已经生效，沙箱内状态全丢 |

三个优点本质上是同一件事的三个投影：**把“让模型做”换成“让代码做”**。

- **少调用**：模型不再参与每一次工具往返，它只写一次脚本、看一次结果。
- **快**：模型是串行的瓶颈——一次往返少则几百毫秒、多则几秒。200 单串行就是几分钟到十几分钟；脚本里 `Promise.all` 一并发，受限于工具侧并发上限（Pi 是 4），时间从“轮次 × 延迟”变成“数据量 ÷ 并发数”。
- **稳**：模型每一步都在重新推理，温度、上下文顺序、前一步的复述方式都会影响下一步；代码没有这些变量。同一个脚本跑两遍，结果一定一样——这是能上生产的前提。

而那个代价，恰好是前三个优点的副作用：

> **传统模式下错误发生在「调用 tool 之前」，CodeMode 下错误发生在「运行的途中」。**

区别不在“有没有错”，在**错的时候已经发生了多少不可撤销的事**。

传统模式：模型发一个 `create_refund`，参数不合法 → harness 在真正执行前就拦下来（`validateToolArguments` + `beforeToolCall`），或者工具自己校验后立刻报错。**影响面是这一次调用**，模型看到 error 文本，改个参数重发，上下文里还留着之前所有的中间结果。

Codemode：脚本跑到第 87 单，`refund()` 抛错 → 整个脚本失败。但**前 86 单的退款已经打到用户账上了**，而且沙箱里的 `enriched`、`judged`、`decisions` 全部随进程结束而蒸发，你没法“从第 87 单继续”，只能整段重跑。更隐蔽的是：`store()` 的写入也一并回滚了，你以为存下的断点根本不存在。

这就是“崩溃时机后移”的真实代价——**回滚点从「一次调用」变成了「一整段脚本」**。

工程上的解法有三条，配合使用：

**① 把粒度切小，让崩溃点变“便宜”。** 一个脚本别干 200 单，干 50 单。失败就重跑这一批，最坏情况浪费 50 次调用，而不是 200 次。

**② 先 dry-run，再动手。**

```js
const DRY_RUN = true;  // ★ 第一次跑：只算，不写

// ……拿到 decisions 之后
if (DRY_RUN) {
  store("refund_plan", decisions);   // 只落计划，不落写操作
  const wouldApprove = decisions.filter(
    (d) => d.decision === "auto_approve",
  );
  return { dryRun: true, wouldApprove: wouldApprove.length };
}

// 确认无误后，把 DRY_RUN 改成 false 再跑一次
// 第二次只读 store 里的计划，不重新拉数据、不重新分类
```

一段脚本负责**算**，另一段负责**写**，中间由人（或另一个断言脚本）看一眼。这是把“代码执行的确定性”和“写操作不可回滚”这两件事解耦的最省事办法。

**③ 幂等键兜底。** 前面 4.2 讲过，这条不是可选项——只要你允许“整段重跑”，就必须保证重跑不会重复退款。

---

## 6. 什么时候别用 Codemode

写了这么多好处，但它是真有边界的，而且边界很硬。

**① 小模型写不出正确脚本。** Codemode 把“填参数”升级成“写程序”，对模型能力的要求直接上了一档。一次调用、一个工具的任务（“帮我读一下这个文件”），用 Codemode 纯属浪费——多一层抽象，多一次生成 JS 的机会出错。

**② 沙箱限制会咬人。** 没有 timer，所以**写不了带退避的重试**；256MB 内存，累计大数组会 `InternalError: out of memory`，得边算边聚合；不能起子脚本；一个 pi 进程最多两个 codemode worker 活着，多会话并发会排队。

**③ 大输出会静默截断。** `max_output_tokens` 默认 10000，超了保留头尾、全文写临时文件。你要是 `return` 一大坨 JSON，模型看到的是掐头去尾的东西——**这种错特别难发现**，因为脚本显示 `Script completed`。

**④ 失败不回滚。** 前面说过，这里再强调一次：脚本里已经发出去的写操作，脚本失败也照样生效。

**⑤ 它不是给你调试用的。** 报错只有一段 `Script error: ...` 文本，没有栈帧、没有断点。复杂脚本要靠 `console.log` + 分段跑。

**⑥ MCP 生态还没跟上。** 官方博客自己也承认这点：很多 MCP server 不返回 `structuredContent`，或者“探测时返回 5 条精简结果、批量时返回 200 条全量结果”，导致你的 `slice(0, 400)` 逻辑在两种形态下表现不一致。

---

## 7. 落地清单

如果你打算在自家 Agent 里上这套（Pi 的 Codemode，或者自己实现一个同构的东西），按这个顺序改：

1. **先给工具补 `outputSchema`。** 没有结构化返回，脚本里只能靠正则扒字符串，等于白搭。
2. **让返回稳定。** 无论 5 条还是 500 条，字段形状必须一致。这条比性能重要。
3. **把工具按 exposure 分层。** 天天用的两三个 `direct`，长尾全部 `codemode`，一个 server 塞 40 个工具的设成 `deferred`。
4. **`codemode.mode` 先别急着上 `only`。** 用 `on` 跑一周，看模型是不是真的会用 `searchTools()` 找工具，再决定要不要全藏。
5. **给所有写操作加服务端幂等键。** 这是 Codemode 做资金/库存类操作的前置条件，没有就别上。
6. **脚本进 git。** 让模型把关键脚本写到仓库里，而不是留在 transcript 里。下一次跑同样的任务，直接复用，不用重新生成。
7. **留一条不用 Codemode 的路。** 单条数据的问答、需要模型“看图判断”的场景，还是老老实实直接调工具。

---

## 8. 最后

Pi 从“No MCP”到“内置 MCP”，看起来是路线摇摆，实际上是他们想清楚了一件事：

**工具的数量会一直涨，上下文的窗口不会。**

面对这个矛盾，传统 tool calling 的解法是“少装工具”——所以 Pi 之前才那么反感 MCP。Codemode 给了另一条路：**工具随便装，因为它们不进上下文；数据随便大，因为它在沙箱里就被过滤掉了。**

回到那个售后场景：600 次工具调用一次都没少，只是**模型不再需要围观这 600 次调用**。

这才是 Codemode 真正卖的东西——不是省 token，是**让模型只做判断，不做搬运**。
