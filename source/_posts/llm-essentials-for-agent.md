---
title: Agent 开发（一）：LLM 是什么？从预测下一个 token 到 OpenAI / Anthropic 协议
date: 2026-10-28 10:00:00
tags: [Agent, LLM, token, OpenAI, Anthropic, 协议]
categories: AI
cover: /img/covers/llm-basics-cover.png
---

<p style="text-align:center"><img src="/img/covers/llm-basics-cover.png" alt="Agent 开发（一）：LLM 是什么"></p>

上一篇 [Agent 开发到底该学什么](https://fengyua5.github.io/2026/10/27/ai-agent-learning-path/) 里，我把学习路线拆成了十块，第二块是「LLM 基础认知」。

这一篇就把这块讲透。目标很朴素：看完之后，你能回答三个问题——

1. 这个需求，LLM 到底能不能做？
2. 它为什么会产生幻觉、为什么会忘记、为什么同样的输入两次结果不一样？
3. 代码里那个 `POST /v1/chat/completions`，每个字段到底在干什么？

前两个问题靠理解模型，第三个问题靠理解协议。**Agent 的所有能力都长在协议上**，所以这一章看着像「科普」，其实是后面所有章节的地基。

<!-- more -->

---

## 1. LLM 的定义：一个函数，一次只吐一个 token

先把玄学去掉。LLM（Large Language Model）在数学上就是一个**参数化的概率函数**：

```text
输入：一段 token 序列  x = [x₁, x₂, ..., xₜ₋₁]
输出：词表 V 上的概率分布  P(xₜ | x₁, ..., xₜ₋₁)

P(xₜ | x_<t) = softmax(W · hₜ)
```

`hₜ` 是模型内部算出来的隐状态（一个几千维的向量），`W` 把它投影到词表维度，softmax 归一化成概率。整句话的概率就是每一步连乘：

```text
P("今天天气不错") = P("今天") × P("天气" | "今天") × P("不错" | "今天天气")
```

**训练目标**就是让训练语料里真实出现的那个 token 的概率尽可能高，也就是最小化交叉熵：

```text
loss = - (1/T) Σ log P(xₜ | x_<t)
```

就这一个目标，没有别的。没有「理解」，没有「推理」，没有「对齐世界知识」这一项——那些都是这个目标在大规模数据上训练出来的**副产品**。

这句话很关键，因为它直接解释了两件事：

- 为什么模型能力强得离谱（要准确预测下一个 token，必须内化语法、事实、逻辑、代码风格）；
- 为什么它一定会胡说（「像真的」和「是真的」在目标函数里没有区别）。

---

## 2. 架构：一次 forward 里到底发生了什么

这是很多人卡住的地方。我用一张图把它摊开：

<p style="text-align:center"><img src="/img/covers/llm-architecture.png" alt="LLM 推理架构：文本 → tokenizer → embedding → Transformer block → LM head → 概率分布 → 下一个 token"></p>

<p style="text-align:center;color:#888;font-size:13px">从左到右是一次 forward；最下面那条虚线是自回归循环——吐出来的 token 拼回输入，再跑一遍。中间的 Transformer Block 实际会堆叠 N 层（8B 模型通常是 32 层）。</p>

逐段拆开看，每一步都只需要一句话就能懂：

| 阶段 | 做什么 | 一句话理解 |
|---|---|---|
| **Tokenizer** | 文本 → token id 序列 | 按 BPE 把字符串切成子词，词表通常 3 万 ~ 25 万 |
| **Embedding** | token id → 向量 | 查表，每个 token 一个 `d_model` 维向量（如 4096） |
| **位置编码** | 注入顺序信息 | 现在主流是 RoPE，旋转 Q/K 向量，让注意力知道「谁在前谁在后」 |
| **Self-Attention** | 让 token 互相看 | 每个位置用 Q 去和所有历史位置的 K 算相似度，加权汇总 V。**这是「从上下文里取信息」的地方** |
| **FFN / MLP** | 逐位置做非线性变换 | 通常是 `d_model → 4×d_model → d_model` 的 SwiGLU。**这是「存知识」的地方** |
| **残差 + Norm** | 稳定深层训练 | `x = x + Attn(Norm(x))`，保证梯度能穿过几十层 |
| **LM Head** | 隐状态 → logits | 一个 `d_model × vocab_size` 的矩阵，常常和 Embedding 共享权重 |
| **Softmax + 采样** | logits → 选一个 token | 按 temperature / top_p 等参数从分布里挑 |

### 2.1 为什么是 decoder-only

Transformer 原始论文是 encoder-decoder，但今天几乎所有大模型都是 **decoder-only**（GPT / Llama / Qwen / DeepSeek / Claude / Gemini 全是这个形态）。三个原因：

1. **训练信号密集**：序列里每个位置都能预测下一个 token，一句话有 T 个监督信号，不需要额外标注；
2. **推理可复用**：自回归生成时，前面算过的 K/V 可以缓存（KV Cache），不用重算；
3. **任务统一**：翻译、摘要、分类、代码，全都变成「给定前缀，续写后续」，不需要为每个任务改结构。

### 2.2 参数里到底存了什么

一个有意思的共识（大量可解释性研究支持）：

- **Attention 层更像「路由/关系」**：决定当前 token 该看哪些位置、怎么组合信息。比如代词解析、指代回指、语法依赖，都体现在注意力模式里。
- **FFN 层更像「键值记忆」**：可以粗略理解成一个巨大的查找表，前半段判断「这是哪个概念」，后半段输出「这个概念对应什么知识」。

所以模型规模主要堆在 FFN 上（占参数量 2/3 左右），而 MoE（混合专家）本质上就是把一个大 FFN 拆成很多专家，每次只激活其中几个——总参数 600B、激活 30B 这种配置就是这么来的。**买模型时看「激活参数」比看「总参数」更接近真实成本和速度。**

### 2.3 一次调用其实是两种完全不同的计算

这一点对做 Agent 特别重要，很多性能问题都源于没意识到它是两段：

| 阶段 | 干什么 | 瓶颈 | 影响 |
|---|---|---|---|
| **Prefill** | 把你的整个 prompt 并行过一遍，建立 KV Cache | **算力密集**（GPU 打满） | 决定**首字延迟 TTFT**；prompt 越长越慢 |
| **Decode** | 一个一个往外吐 token，每吐一个跑一次完整前向 | **显存带宽密集**（GPU 在等数据） | 决定**出字速度 TPOT**；输出越长越慢，且成本线性增长 |

由此得出两条非常实用的结论：

- **输入便宜、输出贵**。所有厂商的定价都是 output 比 input 贵 3~5 倍，因为 decode 没法并行。
- **重复的长 prompt 值得缓存**。你的 system prompt + 工具定义可能几千 token，每轮都重算一次太浪费——这就是 prompt caching 存在的原因（后面协议章节会讲怎么开）。

顺便算一下 KV Cache 有多占显存。以 Llama 3 8B 为例：32 层、8 个 KV head、每 head 128 维，fp16：

```text
每 token 每层：(8 × 128) × 2(K和V) × 2字节 = 4 KB
32 层：4 KB × 32 = 128 KB / token
8K 上下文：128 KB × 8192 ≈ 1 GB
```

**上下文窗口不是免费的**，它是实打实的显存。这也是为什么「把整个代码库塞进上下文」这种做法既慢又贵。

---

## 3. 本质是预测下一个 token，所以它有这些性质

理解了「预测下一个 token」，很多看似奇怪的行为就都能推导出来了。

### 3.1 它是续写器，不是问答器

模型内部没有「问题」和「答案」这两个槽位，只有「这段文本后面最可能接什么」。你问「1+1 等于几？」，它做的其实是**补全一段训练数据里常见的对话文本**。

这解释了一堆现象：

- 为什么 prompt 的措辞影响巨大（你在改变「这段文本属于哪一类」）；
- 为什么给几个示例（few-shot）效果好（你在把分布往目标格式上拽）；
- 为什么「让我们一步步思考」有用（你在诱导它续写出解题过程，而过程会改变后续 token 的条件）。

### 3.2 它没有「对错」的概念，只有「像不像」

交叉熵只惩罚「概率给低了」，不惩罚「说错了」。如果训练语料里「爱因斯坦发明了电话」出现过足够多次，模型就会觉得这句话很正常。**事实性不是目标函数的一部分**，这是幻觉的根。

### 3.3 三个训练阶段塑造了它的「人格」

| 阶段 | 数据 | 学到了什么 | 副作用 |
|---|---|---|---|
| **预训练 Pretrain** | 几万亿 token 网页/代码/书 | 世界知识、语法、推理能力 | 只会续写，不会听指令 |
| **监督微调 SFT** | 几万~几百万条人工标注对话 | 对话格式、指令跟随 | 开始「扮演助手」 |
| **偏好对齐 RLHF / RLVR** | 人类偏好排序 / 可验证奖励 | 有用、无害、有礼 | **迎合（sycophancy）**、过度拒绝 |

RLHF 那一行值得多说一句：标注员天然更喜欢**流畅、自信、有条理**的回答，也更喜欢**同意自己观点**的回答。所以训练出来的模型倾向于「宁可编一个像样的答案，也不要干巴巴地说不知道」。**这不是 bug，是奖励函数教出来的行为。**

（至于 reasoning 模型，本质上也是在这个框架上加了一步：让模型先把「思考过程」当 token 写出来，再做 RL 训练，用可验证的答案去奖励那些能推出正确答案的思考链。**「思考」依然是 token 预测**，只是预测在了更长的序列上。）

### 3.4 采样参数在直接改分布

logits 出来之后，怎么选下一个 token 是**你**能控制的：

| 参数 | 作用 | 典型取值 | 坑 |
|---|---|---|---|
| `temperature` | 把分布变平/变尖：`p_i ∝ p_i^(1/T)` | 代码/抽取 0~0.3；创意 0.8~1.0 | T=0 是贪心解码，**不等于可复现** |
| `top_p` | 只从累积概率前 p 的候选里采样（核采样） | 0.9~0.95 | 和 temperature **只调一个**，同时调很难归因 |
| `top_k` | 只保留概率最高的 k 个 | 20~50 | 小模型上容易过于死板 |
| `frequency_penalty` | 按出现次数惩罚已出现 token | 0~0.5 | 太高会让模型回避关键词 |
| `presence_penalty` | 只要出现过就惩罚 | 0 | 同上 |
| `max_tokens` | 硬性截断 | 按场景 | 截断会得到半句话/半截 JSON |
| `stop` | 命中即停 | 如 `"\n\n"` | 各家字段名不同（`stop` / `stop_sequences`） |
| `seed` | 尽量让采样可复现 | 任意整数 | **只是尽力而为**，后端批处理会引入非确定性 |

一个常见的误区：**temperature=0 不等于结果稳定**。GPU 的浮点累加顺序、batch 里其他请求的组成、服务端模型版本，任何一项变了结果都可能变。要稳定，只能靠**结构化输出 + 校验 + 重试**，不能靠参数。

---

## 4. LLM 的不足（重点：幻觉到底怎么发生的）

这一节是本章最该记住的部分。因为**Agent 工程的大部分设计，都是在给模型的缺陷打补丁**。

### 4.1 幻觉的五条成因

#### ① 目标函数不奖励「真」

前面说过，交叉熵只看「下一个 token 概率高不高」。模型在训练中从没被要求「不确定时闭嘴」。当它被问到训练数据里根本没有的东西时，它不会返回空值，而是返回**一个在语言上最合理的形状**——一个看起来非常像论文引用的字符串、一个语法完美但不存在的 API。

#### ② 长尾知识被压缩成了模糊统计

参数容量是有限的，高频知识（「巴黎是法国首都」）有海量梯度，被记得很牢；低频细节（某篇论文的发表年份、某个库 v2.3.1 的参数名）只有零星样本，最终被压成一个「大概长这样」的模糊记忆。**问得越具体，越容易编。**

一个经典结论（Xu et al., *Hallucination is Inevitable*, 2024）甚至从计算复杂性角度论证：对任意 LLM，总存在它无法正确回答、且无法自己识别出来的输入。**幻觉不可能被彻底消除，只能被工程手段压低。**

#### ③ 自回归会把小错放大成大错

这是最容易被忽略的一条。训练时模型永远以**真实 token** 为条件（teacher forcing），但推理时它以自己的**输出**为条件。一旦某个位置采到了一个错误实体，后面所有 token 都在为这个错误「圆场」：

```text
用户：帮我用 xxx 库的 get_user_by_id 方法查一下
模型：好的，get_user_by_id(id, options) 中 options 支持
      { cache: true } ...   ← 从这里开始编
      （这个方法其实只有一个参数，模型为了自洽，
        把不存在的参数也编圆了）
```

**错误不是均匀分布的，是滚雪球的**。所以幻觉往往在回答的后半段更严重。

#### ④ RLHF 奖励了「自信」

如 3.3 所说，标注者偏好自信的回答。模型学到的是：**表达不确定性会掉分**。于是它用陈述句说出猜测。

#### ⑤ 上下文冲突与「过度顺从」

当你给的上下文和模型记忆冲突时，它有时会坚持记忆里的错误版本；反过来，当你用很强的引导性提问（「为什么 X 是 Y？」）时，它又会顺从你的前提，为错误命题编理由。这两种都是幻觉，方向相反。

### 4.2 幻觉为什么「看起来那么可信」

因为**流畅性和真实性是解耦的**。语言模型在「这个句子读起来像不像人写的」上已经远超人类平均水平，而在「这个事实对不对」上没有内在信号。人类判断可信度靠的是「表达流畅 + 细节丰富 + 语气确定」，这三样恰好都是模型擅长的。**这是 Agent 落地最大的风险来源**。

### 4.3 工程上怎么压：三层防线

先说结论：**光靠 prompt 压不住幻觉**。prompt 只能降低「它想编」的概率，管不了「它其实不知道但很自信」。真正能上生产的做法是三层——

```text
第一层  不让它猜        prompt / 上下文 / 工具 / schema      降低概率
第二层  测出它多确定     logprob / 多次采样 / 验证器          拿到信号
第三层  把分数变成动作   校准 + 阈值 + 弃权/升级              做决策
```

大部分团队只做了第一层，然后靠「人肉 review」补第三层。下面把三层拆开讲。

#### 4.3.1 第一层：不让它有机会瞎猜

按性价比排序：

1. **别让它凭记忆答**：把事实放进上下文（RAG），并要求「只依据给定资料回答，资料里没有就说没有」。
2. **要求引用**：让每个结论指向具体出处（段落 id / URL），然后**用代码去校验引用是否真实存在**。这一步能干掉大部分引用类幻觉。
3. **让代码算，别让它算**：数学、日期、统计、字符串处理，一律走工具。
4. **结构化输出 + schema 校验**：JSON Schema 约束 + 解析失败就重试，比「请返回 JSON」可靠得多。
5. **外部验证器**：代码要跑测试，SQL 要 explain，URL 要 HEAD 一下。**执行本身就是最强的验证。**
6. **降低温度能减少发散，但消不掉幻觉**——它只是让模型少走偏门，不会让它突然知道真相。
7. **建评测集**：没有 eval 的「感觉变好了」都是幻觉（这个词在这儿特别贴切）。

> 这一层的思路是：**幻觉的解法从来不是「让模型更聪明」，而是「不让它有机会瞎猜」。**

但它有个天花板：**再好的 prompt，也没法让模型在「不知道」的时候告诉你「我不知道」**。因为「表达不确定」本身就是一个它没被训练过的动作（见 4.1 的第 ④ 条）。所以必须有第二层。

#### 4.3.2 第二层：把「它有多确定」测出来

先排除一个所有人的第一反应：**让模型自己说置信度**。

```text
请给出答案，并给出你对答案的置信度（0-100）。
```

这个做法在实践中几乎不可用：模型自报的分数**长期系统性偏高**，而且和实际正确率的相关性很弱——简单题它说 90，难题它也说 85。更糟的是它会被措辞带偏（你说「答错要扣分」，分数就整体下调，但排序没变）。**自报置信度可以当一个特征，但不能当概率用。**

真正可用的信号有四种，从便宜到贵：

##### ① logprobs：模型内部最原始的那个数

这是唯一**免费、可直接拿到**的内部信号。OpenAI 兼容协议里，打开 `logprobs: true` 和 `top_logprobs: 5`，就能拿到每个生成 token 的对数概率，以及当时排名前几的候选：

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1-mini",
    "messages": [
      {
        "role": "user",
        "content": "订单 #1234 已拆封，能退款吗？只答 能/不能"
      }
    ],
    "temperature": 0,
    "logprobs": true,
    "top_logprobs": 5,
    "max_completion_tokens": 4
  }'
```

返回里多了一块：

```json
{
  "choices": [{
    "message": { "role": "assistant", "content": "能" },
    "logprobs": {
      "content": [{
        "token": "能",
        "logprob": -0.02,
        "top_logprobs": [
          { "token": "能", "logprob": -0.02 },
          { "token": "不", "logprob": -3.91 }
        ]
      }]
    },
    "finish_reason": "stop"
  }]
}
```

`-0.02` 换成概率是 `e^-0.02 ≈ 0.98`，`-3.91` 是 `0.02`。**在两个候选之间做归一化，得到的就是一个干净的二元置信度**——比绝对 logprob 稳得多，因为它抵消了不同 prompt 下整体分布的偏移：

```ts
function binaryConfidence(choice: any): number {
  const first = choice.logprobs.content[0];
  const cands = [first, ...first.top_logprobs];

  const lp = (pred: (t: string) => boolean) =>
    cands.find((c) => pred(c.token.trim()))?.logprob ?? -Infinity;

  const yes = lp((t) => t === "能");
  const no  = lp((t) => t === "不" || t.startsWith("不"));
  const m   = Math.max(yes, no);

  const py = Math.exp(yes - m);
  const pn = Math.exp(no - m);
  return py / (py + pn);          // 0.5 = 完全摇摆，1.0 = 很笃定
}
```

这个模式适用于**所有「短答案」场景**：分类、是否命中、字段抽取、路由决策。它的威力在于把一段开放文本生成，变成了**一个可以打分的单选题**。

但 logprob 有五个坑，不知道就会用错：

| 坑 | 说明 |
|---|---|
| **长答案没意义** | 序列越长，总 logprob 越低。别用 `sum(logprob)` 比大小，用**平均**或**最差的那个 token** |
| **不能跨模型比** | tokenizer 不同，同一句话切出来的 token 数和概率都不同。阈值只能在同一模型、同一 tokenizer 下校准 |
| **不跨温度可比** | logprob 来自实际采样分布，temperature 变了绝对值就变。做阈值判断时固定温度 |
| **不等于正确** | 它是「模型觉得像」，不是「事实为真」。模型可以 0.99 确信一个错误答案（这正是幻觉的定义） |
| **不是每家都给** | Anthropic Messages **不返回 logprobs**；Gemini 有 `responseLogprobs`；推理模型常常不给，或只给最终答案 |

所以 logprob 是**弱信号**：它能告诉你「模型在这个选择上犹不犹豫」，不能告诉你「它对不对」。真正的高风险场景，得往上走。

##### ② 采样一致性：更稳、更贵

同一个问题采样 N 次（`temperature` 0.7 左右），**看答案稳不稳**：

```ts
async function consistentAnswer(
  prompt: string,
  n = 5,
  ask: (temperature: number) => Promise<string>,
) {
  const answers = await Promise.all(
    Array.from({ length: n }, () => ask(0.7))
  );

  // 注意：要按语义归一化，"21 天" 和 "二十一天" 是同一个答案
  const groups = new Map<string, string[]>();
  for (const a of answers) {
    const k = normalize(a);              // 去空格/统一数字/小写
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }

  const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
  return {
    answer: sorted[0][0],
    confidence: sorted[0].length / n,    // 5 次里 4 次一致 → 0.8
    all: answers,
  };
}
```

为什么它比 logprob 靠谱？因为它测的是**整个生成路径的稳定性**，而不是单个 token 的概率。模型如果是在「编」，每次编的细节往往不一样（引用编号、参数名会飘），一致性会明显掉下来。这也是 Self-Consistency 那套方法在工程上最好用的地方。

代价也很直接：**N 倍输出成本 + N 倍延迟**。所以一定要做成「级联」，不要默认开：

```text
小模型先答 → 置信度够 → 直接返回
           → 置信度低 → 大模型 + N 次采样 → 还低 → 人工/拒答
```

##### ③ 验证器：最强的信号

如果答案**可以被机器检查**，那就别猜置信度了，直接验证：

| 答案类型 | 验证方式 |
|---|---|
| 代码 | 跑单测 / 类型检查 / 编译 |
| SQL | `EXPLAIN` + 只读账号试跑 |
| JSON | schema 校验 + 业务约束（金额 ≤ 0 直接拒） |
| 引用 | 检索引擎回查出处是否真的存在、原文是否支持该结论（NLI 蕴含判断） |
| 链接 | `HEAD` 请求，看 404 |
| 数值 | 用代码重算一遍，比对 |
| 工具调用 | 参数 schema 校验 + 权限检查 + 幂等键 |

**验证器给出的不是概率，是布尔值**——这是它最值钱的地方。能验证的部分，压根不需要置信度。

##### ④ 交叉检查

用另一个模型（最好不同家族）做 judge，或让模型自己审自己的输出。有效，但要清醒：

- 同源模型会**犯同样的错**，一致性很高但可能一起错；
- 成本翻倍，延迟翻倍；
- judge 本身也会被 prompt 注入影响——**judge 的输入要当作不可信数据**。

工程上通常用在「最终一道闸」：交叉检查只对高风险动作（转账、删数据、对外发消息）触发。

#### 4.3.3 第三层：把分数变成动作

拿到分数之后，最常见的错误是**拍一个 0.8 当阈值**。这是没意义的，因为分数的绝对含义取决于模型、任务和数据分布。

正确做法是**先校准，再决策**。

**第一步，做一张校准表**：在评测集上跑一遍，把置信度分桶，统计每桶的真实正确率。

| 置信度分桶 | 样本数 | 实际正确率 | 结论 |
|---|---|---|---|
| 0.50 – 0.70 | 210 | 0.52 | 基本等于瞎猜 |
| 0.70 – 0.80 | 340 | 0.63 | 明显过度自信 |
| 0.80 – 0.90 | 520 | 0.71 | 过度自信 |
| 0.90 – 0.95 | 480 | 0.78 | 过度自信 |
| 0.95 – 1.00 | 450 | 0.86 | 仍然过度自信 |

这张表告诉你两件关键的事：

1. **分数是虚高的**，所以「0.9 以上就自动放行」这种规则会漏掉 20% 以上的错误；
2. **真正该用的阈值不在 0.9**，而是让「某桶的实际正确率 ≥ 业务可接受的错误率」的那条线。上表里如果业务要求 95% 正确率，**没有任何一个桶达标**——说明这个任务光靠置信度兜不住，必须加验证器或人工。

（这套东西的学名叫 calibration，衡量指标是 ECE；但工程上你只需要这张表，不需要背公式。）

**第二步，用期望损失定策略**，而不是拍脑袋：

```ts
// 错误的代价 vs 弃权的代价，决定了阈值在哪
const costWrong  = 100;   // 答错：赔 100 元 / 投诉 / 事故
const costAbstain = 3;    // 弃权转人工：3 元

// 期望损失最小的做法：p_wrong * costWrong < costAbstain 时才自动放行
const autoThreshold = 1 - costAbstain / costWrong;   // = 0.97

function decide(
  score: number,
  calibrated: (s: number) => number,
) {
  const p = calibrated(score);          // 用校准表把分数映射成真实正确率
  if (p >= autoThreshold) return "auto";
  if (p >= 0.6) return "review";        // 带着候选答案转人工，成本低很多
  return "abstain";                     // 直接说不知道 / 转搜索 / 让用户补充信息
}
```

这个公式很值得记住：**当错误的代价是弃权的 33 倍时，你必须做到 97% 才敢自动放行**。反过来，如果错误代价很低（比如推荐一句文案），0.6 就能放行。**阈值是业务问题，不是模型问题**——这也是为什么直接抄别人的 0.8 一定出事。

**第三步，给模型留一个「合法的不知道」**。这是最便宜、最容易被忽略的一招：如果 schema 里只有正确答案的形状，模型就只能编。把「未知」做成一个合法枚举值，它才有地方表达不确定：

```json
{
  "refund_days": {
    "value": null,
    "reason": "资料中未提及拆封商品的退款期限"
  }
}
```

配合 logprob 用效果更好：比较 `null` 分支和其他分支的概率，**「模型有多想说不知道」本身就是一个置信度信号**。

#### 4.3.4 三层怎么组合

| 场景 | 第一层 | 第二层 | 第三层 |
|---|---|---|---|
| 闲聊、文案 | prompt 约束 | 不需要 | 直接返回 |
| 分类 / 路由 | 短答案 + enum | logprob 二元置信度 | 低于阈值走 fallback 分支 |
| 字段抽取 | schema + `null` 枚举 | 字段级 logprob | 低置信字段标黄，人工补 |
| RAG 问答 | 强制引用 | 引用回查 + 一致性 | 无出处就拒答 |
| 医疗 / 金融 / 法务 | 全部 | 一致性 + 交叉检查 | 强制人工确认，模型只给候选 |
| Agent 执行动作 | 权限 + schema | 参数校验 + 二次确认 | 高风险动作一律 human-in-the-loop |

一句话总结这三层：

> **第一层降低它犯错的概率，第二层估计它犯错的概率，第三层决定这个概率能不能接受。**
> 前两层是模型能力问题，第三层是**产品风险问题**——而绝大多数线上事故，是第三层没做。

### 4.4 其它必须知道的边界

下面这张表的两列「对应章节」，指的是上一篇学习路线里的第几块（比如「四」就是工具调用）。你会发现**几乎每个缺陷都对应一个 Agent 技术**：

| 不足 | 你会看到的症状 | Agent 侧怎么补 | 路线章节 |
|---|---|---|---|
| **幻觉** | 编造 API、引用、数字、链接 | RAG + 引用校验 + 工具验证 + schema + 置信度门槛 | 五、九 |
| **无状态** | 每轮都要重传全部历史，越聊越贵 | 会话存储 + 上下文压缩 + prompt 缓存 | 三、六 |
| **上下文有限** | 长文档被截断；中间段落被忽略（lost in the middle） | 切分检索 + 重排 + 分层摘要 | 三、五 |
| **知识截止** | 不知道今天的新闻、股价、你的内网 | 工具调用 / 搜索 / 数据库 | 四 |
| **不能执行** | 只能告诉你步骤，不能真的点按钮 | function calling + 沙箱 + 权限控制 | 四、八 |
| **tokenizer 粒度** | 数不清 「strawberry 有几个 r」、算错字符数、数字对齐错位 | 交给代码，别让模型数 | 四 |
| **不确定** | 同样输入不同输出，回归测试难做 | 低温度 + 结构化 + 评测集 + 断言 | 九 |
| **指令漂移** | 长对话里逐渐忘掉 system 规则 | 关键指令前置/复述 + 状态机 | 三、六 |
| **成本与延迟** | 长上下文又慢又贵；流式体验割裂 | 缓存 + 小模型路由 + 流式 + 预算控制 | 八、九 |
| **安全** | 提示注入、越权调用工具 | 权限最小化 + 人工确认 + 输出过滤 | 四、八 |

**「无状态」这条值得单独强调**：模型不记得你上一句说了什么。所谓「多轮对话」，是客户端每轮都把**完整历史**重新发一遍。这就是为什么协议里的 `messages` 是一个数组，而不是一个 `session_id`。理解了这点，你就理解了上下文管理和成本优化的全部起点。

---

## 5. 协议：你和模型之间的那一层

模型跑在别人（或你自己的）GPU 上，你唯一的通道是 HTTP。**协议定义的就是：怎么把「我要你续写这段文本」这件事，编码成一个 JSON 请求，再把结果解回来。**

### 5.1 所有协议共享同一个骨架

不管哪家，本质都是这套东西：

```text
POST /v1/xxx
Authorization: <key>

{
  "model": "...",            // 用哪个模型
  "messages": [...],        // 对话历史（含 system / user / assistant / tool）
  "temperature": 0.7,       // 采样参数
  "max_tokens": 1024,       // 长度上限
  "tools": [...],           // 可用的工具（可选）
  "stream": true            // 是否流式
}

→ 200 OK
{
  "content": "...",         // 生成的内容
  "tool_calls": [...],      // 想调用的工具（可选）
  "finish_reason": "stop",  // 为什么停
  "usage": { ... }          // 用了多少 token，花多少钱
}
```

**掌握这套骨架，再去看任何一家文档，你只需要对照三个问题：字段叫什么、消息怎么组织、工具调用怎么表达。**

目前生态里最主要的三家：

| 协议 | 端点 | 地位 |
|---|---|---|
| **OpenAI Chat Completions** | `POST /v1/chat/completions` | **事实标准**。DeepSeek、Qwen、Kimi、vLLM、Ollama、OpenRouter 全都兼容它 |
| **OpenAI Responses** | `POST /v1/responses` | OpenAI 的新一代形态，内置工具、状态化、`previous_response_id` 续接 |
| **Anthropic Messages** | `POST /v1/messages` | Claude 专用，块（block）结构更干净，Agent 场景细节最讲究 |
| **Google Gemini** | `POST /v1beta/models/{model}:generateContent` | `contents` + `parts`，`role` 用 `user`/`model`，另一套风格 |

下面重点讲前两个里最常用的 Chat Completions 和 Messages，Gemini 只做对照。

---

## 6. OpenAI Chat Completions 协议

### 6.1 最小调用

```bash
curl https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$MODEL"'",
    "messages": [
      { "role": "system", "content": "你是一个简洁的技术助手。" },
      { "role": "user",   "content": "用一句话解释什么是 token。" }
    ],
    "temperature": 0.2,
    "max_completion_tokens": 200
  }'
```

注意几个细节：

- 认证是 `Authorization: Bearer <key>`（Anthropic 是 `x-api-key`）；
- `max_tokens` 已经**被 `max_completion_tokens` 取代**，新模型传 `max_tokens` 会直接 400；
- `system` 在新模型上也可以写成 `developer`，语义更准确（「开发者指令」优先于用户输入）。

### 6.2 请求参数

| 分组 | 参数 | 说明 |
|---|---|---|
| 身份 | `model` | 模型名，例如 `gpt-4.1-mini`、`o4-mini`；兼容端点里就是 `deepseek-chat` 这种 |
| 对话 | `messages` | **核心**。`role` 可为 `system`/`developer`/`user`/`assistant`/`tool` |
| | `messages[].content` | 字符串，或多模态数组 `[{type:"text"},{type:"image_url"}]` |
| | `messages[].tool_calls` | 仅 assistant 用：模型上一轮产生的工具调用 |
| | `messages[].tool_call_id` | 仅 tool 用：回应哪一个工具调用 |
| 采样 | `temperature` | 0 ~ 2，默认 1。**注意不是 0~1** |
| | `top_p` | 核采样，默认 1 |
| | `n` | 一次生成几个候选（多数场景为 1） |
| | `presence_penalty` / `frequency_penalty` | -2 ~ 2 |
| | `seed` | 尽量可复现，仅是「尽力」 |
| | `logprobs` / `top_logprobs` | 要每个 token 的概率，做置信度分析时用得上 |
| 长度 | `max_completion_tokens` | 输出上限（含 reasoning token） |
| | `stop` | 最多 4 个停止串 |
| 输出控制 | `response_format` | `{type:"json_object"}` 或 `{type:"json_schema", json_schema:{...}}` |
| 工具 | `tools` | `[{type:"function", function:{name, description, parameters}}]`，`parameters` 是 JSON Schema |
| | `tool_choice` | `"none"` / `"auto"` / `"required"` / 指定某个函数 |
| | `parallel_tool_calls` | 是否允许一轮返回多个工具调用（默认 true） |
| 流式 | `stream` | 是否 SSE 流式 |
| | `stream_options.include_usage` | **流式下拿 usage 必须显式打开**，否则最后没有用量 |
| 推理 | `reasoning_effort` | 推理模型的思考预算档位（`low`/`medium`/`high` 之类） |
| 其它 | `user` / `safety_identifier` | 终端用户标识，用于风控和滥用追踪 |
| | `store` / `metadata` | 是否让服务端存这次响应、附加元数据 |

### 6.3 返回结构

```json
{
  "id": "chatcmpl-B9vX...",
  "object": "chat.completion",
  "created": 1761600000,
  "model": "gpt-4.1-mini-2025-04-14",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "token 是模型读写文本的最小单位，介于字符和单词之间。",
        "refusal": null,
        "annotations": []
      },
      "logprobs": null,
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 32,
    "completion_tokens": 18,
    "total_tokens": 50,
    "prompt_tokens_details": { "cached_tokens": 0 },
    "completion_tokens_details": { "reasoning_tokens": 0 }
  },
  "system_fingerprint": "fp_44709d6fcb"
}
```

几个字段的实战意义：

- **`finish_reason`**：判断要不要重试的唯一依据，见下表；
- **`usage.prompt_tokens_details.cached_tokens`**：有多少输入命中了缓存。**这是优化成本时最该盯的指标**，命中部分通常只收 10%~25% 的钱；
- **`usage.completion_tokens_details.reasoning_tokens`**：推理模型「想」了多少 token，**它按输出计费**，所以推理模型的账单经常比你预估的高；
- **`system_fingerprint`**：后端配置指纹。**它变了，说明模型行为可能变了**——线上出现莫名回归时先看这个。

`finish_reason` 取值：

| 值 | 含义 | 你该做什么 |
|---|---|---|
| `stop` | 正常结束 | 直接用 |
| `length` | 撞到 `max_completion_tokens` | 提高上限 / 让它分段输出 / 检查是否死循环 |
| `tool_calls` | 模型要调工具 | 执行工具，把结果塞回 `messages` 再来一轮 |
| `content_filter` | 被安全策略拦截 | 换措辞或走兜底话术 |
| `function_call` | 老版函数调用（已废弃） | 迁移到 `tools` |

### 6.4 流式：SSE 长什么样

`stream: true` 之后，服务端返回 `text/event-stream`，一行行 `data: {...}`，最后 `data: [DONE]`：

```text
data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}

data: {"choices":[{"index":0,"delta":{"content":"token"}}]}

data: {"choices":[{"index":0,"delta":{"content":" 是"}}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":32,"completion_tokens":18}}

data: [DONE]
```

（为了排版，省掉了每个 chunk 都重复的 `object`、`created`、`model`、`system_fingerprint`，以及中间的 `finish_reason: null`。）

**流式解析的三个坑**（自己手写解析器时一定会踩）：

1. **`delta` 是增量，不是全量**。要自己拼接。第一块通常只有 `role` 没有 `content`。
2. **`tool_calls` 也是增量**，而且按 `index` 分片：`id` 和 `name` 只出现在第一片，`arguments` 是**一段一段的 JSON 字符串**，得按 `index` 聚合后再 `JSON.parse`。
3. **最后一个 chunk 的 `choices` 是空数组**，只有 `usage`（且必须开 `include_usage`）。别在这时候崩掉。

---

## 7. Anthropic Messages 协议

Anthropic 的协议和 OpenAI 是**两套设计哲学**，不是简单改名。它最明显的特征是：**一切都由 content block 组成**。

### 7.1 最小调用

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "'"$CLAUDE_MODEL"'",
    "max_tokens": 1024,
    "system": "你是一个简洁的技术助手。",
    "messages": [
      { "role": "user", "content": "用一句话解释什么是 token。" }
    ]
  }'
```

三个立刻能看到的差异：

- `x-api-key` + **`anthropic-version` 请求头**（版本是显式协商的，不是路径里带 `v1` 就完事）；
- **`system` 是顶层参数**，不是 `messages` 里的一条；
- **`max_tokens` 是必填的**（OpenAI 可选）。

### 7.2 请求参数

| 分组 | 参数 | 说明 |
|---|---|---|
| 身份 | `model` | 如 `claude-sonnet-4-5` |
| 对话 | `messages` | **只能 `user` / `assistant`，且必须交替**；首条必须是 `user` |
| | `system` | 顶层，字符串或 block 数组（可分段加 `cache_control`） |
| | `messages[].content` | 字符串，或 block 数组：`text` / `image` / `tool_use` / `tool_result` / `document` |
| 采样 | `temperature` | **0 ~ 1**，默认 1（不要和 `top_p` 同时调） |
| | `top_p` | 默认按温度采，建议只用一种 |
| | `top_k` | Anthropic 支持，OpenAI 没有 |
| 长度 | `max_tokens` | **必填** |
| | `stop_sequences` | 停止串数组 |
| 工具 | `tools` | `[{name, description, input_schema}]` —— 注意是 `input_schema`，直接写 schema，没有 `function` 包裹 |
| | `tool_choice` | `{type:"auto"}` / `{type:"any"}` / `{type:"tool", name:"..."}` / `{type:"none"}` |
| | `disable_parallel_tool_use` | 想要「一次只调一个工具」时打开 |
| 扩展思考 | `thinking` | `{type:"enabled", budget_tokens: 4000}`，`budget_tokens` 必须小于 `max_tokens` |
| 流式 | `stream` | SSE，但事件类型是**语义化**的（见 7.4） |
| 缓存 | `cache_control` | 显式标记哪段内容要缓存（`{"type":"ephemeral"}`） |
| 其它 | `metadata.user_id` | 终端用户标识 |

### 7.3 返回结构

```json
{
  "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-5",
  "content": [
    { "type": "text", "text": "token 是模型读写文本的最小单位，介于字符和单词之间。" }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 24,
    "output_tokens": 18,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

关键差异：

- **`content` 永远是数组**，即使只有一段文字。多模态、工具调用、思考过程都是数组里的不同 `type`；
- **`stop_reason` 是另一套枚举**，见下表；
- **`usage` 把缓存拆成两个数**：`cache_creation_input_tokens`（写缓存，**加价**）和 `cache_read_input_tokens`（读缓存，**打折**）。做成本核算时这两个必须分开统计。

`stop_reason` 取值：

| 值 | 含义 | 对应 OpenAI |
|---|---|---|
| `end_turn` | 正常说完 | `stop` |
| `max_tokens` | 撞上限 | `length` |
| `stop_sequence` | 命中 `stop_sequences` | `stop`（因为 `stop` 命中） |
| `tool_use` | 要调工具 | `tool_calls` |
| `refusal` | 拒答 | `content_filter` |
| `pause_turn` | 长任务中间暂停（服务端工具场景） | 无对应 |

### 7.4 流式：事件是有语义的

Anthropic 的 SSE 带 `event:` 字段，客户端可以按事件类型分发，而不是靠「猜 delta 里有没有某个 key」：

```text
event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":24}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,
       "delta":{"type":"text_delta","text":"token"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}

event: message_stop
data: {"type":"message_stop"}
```

（同样省掉了重复字段；`content_block_delta` 那一行在真实报文里是一整行，这里为了排版折了行。）

这套设计对 Agent 更友好，因为**工具调用的参数是流式 JSON**（`input_json_delta`），你能实时显示「正在生成参数…」，也能提前校验。另外会有 `ping` 事件保活，断线时还能通过 `error` 事件拿到结构化错误。

---

## 8. 两家协议逐项对照（最容易踩坑的地方）

这张表建议收藏，写兼容层时对着看。

| 维度 | OpenAI Chat Completions | Anthropic Messages |
|---|---|---|
| **认证** | `Authorization: Bearer` | `x-api-key` + `anthropic-version` |
| **system** | `messages` 里的一条（role=`system`/`developer`） | **顶层 `system` 参数** |
| **角色限制** | 任意顺序，可连续多条 | 只能 user/assistant，**必须交替**，首条必须是 user |
| **max_tokens** | 可选（`max_completion_tokens`） | **必填** |
| **temperature 范围** | 0 ~ 2 | 0 ~ 1 |
| **content 形态** | 字符串或多模态数组 | **永远是 block 数组** |
| **工具定义** | `{type:"function", function:{name, parameters}}` | `{name, description, input_schema}` |
| **工具调用表达** | `message.tool_calls[]`，`arguments` 是 JSON **字符串** | `content[]` 里的 `tool_use` block，`input` 是**对象** |
| **工具结果回传** | 新增一条 `role:"tool"` 消息 + `tool_call_id` | 新增一条 `role:"user"` 消息，内含 `tool_result` block |
| **并行工具** | `parallel_tool_calls: true` | 默认允许，可用 `disable_parallel_tool_use` 关闭 |
| **结构化输出** | `response_format`（json_schema 强约束） | 没有完全等价的字段，常见做法是用工具强制或 assistant prefill |
| **停止原因** | `finish_reason` | `stop_reason`，枚举名完全不同 |
| **流式** | `data: {chunk}` + `[DONE]` | 语义化 `event:` + `data:` |
| **usage 字段** | `prompt_tokens` / `completion_tokens` | `input_tokens` / `output_tokens` |
| **缓存** | 自动前缀缓存，只报 `cached_tokens` | 显式 `cache_control`，报 read/write 两个数 |
| **图片** | `{type:"image_url", image_url:{url}}` | `{type:"image", source:{type:"base64",...}}` |
| **思考过程** | `reasoning_tokens`（内容不返回） | `thinking` block（可返回，带签名） |

我把最容易翻车的三处单独拎出来：

**① 工具参数：字符串 vs 对象。** OpenAI 给你 `arguments: "{\"city\":\"杭州\"}"`，得自己 `JSON.parse`；Anthropic 直接给你 `input: { city: "杭州" }`。**而且 OpenAI 的 arguments 在流式下是碎片拼起来的，经常出现半截 JSON**，解析失败是常态，要兜住。

**② 工具结果的角色。** OpenAI 用独立的 `role: "tool"`；Anthropic 用 `role: "user"` 包一个 `tool_result` block。搞错这个，多轮工具会直接 400，报错信息还很不直观。

**③ 角色交替。** Anthropic 要求严格交替，连续两条 user 消息会被拒（或需要合并）。而 OpenAI 完全不管。做抽象层时，**在内部就把连续同角色消息合并**，能省掉一半兼容问题。

---

## 9. 一次工具调用的完整往返

光看字段没感觉，走一遍真实流程。假设模型要查天气。

### OpenAI：两轮请求

**第一轮**，模型不回答，而是要调工具：

```json
{
  "id": "chatcmpl-A1",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"杭州\"}" }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

你把工具结果追加进历史，**带上助手那条 tool_calls，再发一次**：

```json
{
  "model": "gpt-4.1-mini",
  "messages": [
    { "role": "user", "content": "杭州今天多少度？" },
    { "role": "assistant", "content": null,
      "tool_calls": [ /* 上面那段，原样回传 */ ] },
    { "role": "tool", "tool_call_id": "call_abc123",
      "content": "{\"temp_c\":21,\"desc\":\"多云\"}" }
  ]
}
```

> 注意：`tool_calls` 必须**原样回传**，不能只传 `tool` 消息。少了它，模型就不知道自己在回应哪个调用。

### Anthropic：也是两轮，但形状不同

**第一轮**返回 `stop_reason: "tool_use"`，`content` 里有 `tool_use` block：

```json
{
  "id": "msg_A1",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "我查一下杭州的天气。" },
    {
      "type": "tool_use",
      "id": "toolu_01A",
      "name": "get_weather",
      "input": { "city": "杭州" }
    }
  ],
  "stop_reason": "tool_use",
  "usage": { "input_tokens": 380, "output_tokens": 56 }
}
```

**第二轮**：把助手那条完整塞回去（含 `tool_use`），再补一条 user 消息，里面是 `tool_result`：

```json
{
  "model": "claude-sonnet-4-5",
  "max_tokens": 1024,
  "tools": [ /* 同上 */ ],
  "messages": [
    { "role": "user", "content": "杭州今天多少度？" },
    { "role": "assistant",
      "content": [ /* 上面那条完整 content，含 tool_use */ ] },
    {
      "role": "user",
      "content": [{
        "type": "tool_result",
        "tool_use_id": "toolu_01A",
        "content": "{\"temp_c\":21,\"desc\":\"多云\"}",
        "is_error": false
      }]
    }
  ]
}
```

两边对比下来，你就能看出**协议层其实只有三个动作**：请求 → 判断 `stop_reason` → 追加结果再请求。整个 Agent Loop 就是这三步的循环。

---

## 10. 写一层自己的抽象

如果业务要同时接 OpenAI、Claude、DeepSeek、Qwen（后两个走 OpenAI 兼容端点），**不要在业务代码里到处写 `if (provider === "openai")`**。正确做法是定义一套内部消息模型，再写两个 adapter。

### 10.1 内部消息模型

```ts
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; base64: string };

type ToolCall = { id: string; name: string; args: unknown };

type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: ContentPart[] }
  | { role: "assistant"; content: ContentPart[]; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };

interface LLMRequest {
  model: string;
  messages: Message[];
  tools?: { name: string; description: string; schema: object }[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

interface LLMResponse {
  content: ContentPart[];
  toolCalls: ToolCall[];
  stopReason: "end" | "max_tokens" | "tool_use" | "refusal" | "pause";
  usage: {
    input: number; output: number;
    cacheRead: number; cacheWrite: number;
  };
}
```

### 10.2 两个 adapter 的映射规则

```ts
// 把内部 block 数组拍平成纯文本（OpenAI 的 content 只接字符串）
const textOf = (parts: ContentPart[]) =>
  parts.filter((p) => p.type === "text").map((p) => p.text).join("");

function toOpenAI(req: LLMRequest) {
  return {
    model: req.model,
    messages: req.messages.flatMap((m) => {
      switch (m.role) {
        case "system": return [{ role: "system", content: m.content }];
        case "user":   return [{ role: "user", content: toOpenAIParts(m.content) }];
        case "assistant": return [{
          role: "assistant",
          content: textOf(m.content) || null,
          ...(m.toolCalls?.length && {
            tool_calls: m.toolCalls.map(t => ({
              id: t.id, type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.args) }
            }))
          })
        }];
        case "tool": return [{
          role: "tool",
          tool_call_id: m.toolCallId,
          content: m.content
        }];
      }
    }),
    max_completion_tokens: req.maxTokens,
    temperature: req.temperature,
    tools: req.tools?.map(t => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.schema }
    })),
  };
}

function toAnthropic(req: LLMRequest) {
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 1024,
    system: req.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n"),
    messages: mergeConsecutive(
      req.messages.filter(m => m.role !== "system").map((m) => {
        if (m.role === "user") return { role: "user", content: m.content };
        if (m.role === "assistant") return {
          role: "assistant",
          content: [
            ...m.content,
            ...(m.toolCalls ?? []).map(t => ({
              type: "tool_use", id: t.id, name: t.name, input: t.args
            }))
          ]
        };
        // tool 结果在 Anthropic 里是 user 消息里的 block
        return {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]
        };
      })
    ),
    temperature: req.temperature,
    tools: req.tools?.map(t => ({
      name: t.name, description: t.description, input_schema: t.schema
    })),
  };
}
```

这段代码不长，但它把两家协议的所有差异（system 位置、tool 角色、字符串 vs 对象、字段名、必填项）**收敛到了一个地方**。以后加 Gemini、加国产模型、加自建 vLLM，都只改这个文件。

### 10.3 一层不够，要三层

真正上生产，这层 adapter 外面还得套两层：

```text
业务逻辑（Agent Loop / 工具注册 / 状态机）
        ↓
内部 IR（统一 Message / ToolCall / Usage）
        ↓
Provider Adapter（OpenAI / Anthropic / Gemini / vLLM）
        ↓
可靠性层：超时 · 重试（带抖动）· 限流 · 用量统计 · trace · 降级路由
        ↓
HTTP
```

**可靠性层是最容易被跳过、也最容易出事的一层**。至少要处理：

| 场景 | 处理方式 |
|---|---|
| `429` 限流 | 读 `retry-after`，指数退避 + 抖动，别所有请求同时重试 |
| `529` / `503` 过载 | 切备用模型或备用区域 |
| `400 invalid_request_error` | **不要重试**，是请求本身错了（日志里打出原始 request） |
| 流式中断 | 要么整段重来，要么把已收到的内容作为 assistant 前缀续写 |
| 超时 | 用 `AbortSignal` 显式取消，别让连接挂着烧钱 |
| 成本失控 | 按 `usage` 累计，超预算熔断 |

---

## 11. 小结

如果这篇你只记五句话，我希望是这五句：

1. **LLM 是一个 `P(next token | context)` 函数**。对话、翻译、写代码、推理，都是这一个函数的涌现行为。
2. **它的架构是 tokenizer → embedding → N×Transformer → LM head → 采样**，其中 attention 负责「取信息」，FFN 负责「存知识」，prefill 决定首字延迟，decode 决定出字速度和成本。
3. **幻觉不是 bug 而是目标函数的必然**：它优化的是「像」，不是「真」。所以工程解法分三层——不让它猜（prompt/上下文/工具）、测出它有多确定（logprob/一致性/验证器）、把分数变成弃权或升级的决策（校准 + 阈值）。
4. **协议只有三件事**：把历史编码成 `messages`、看 `finish_reason`/`stop_reason`、决定要不要再来一轮。Agent 的循环就建立在这三步上。
5. **OpenAI 和 Anthropic 的差异集中在 system 位置、工具调用表达、角色约束上**。写一层统一抽象，比在业务里做分支便宜得多。

下一篇进入第三块：**提示词工程**——上下文窗口是有限的，怎么把正确的信息、用正确的形式、放进这有限的窗口里。

---

## 参考资料

- Vaswani et al., *Attention Is All You Need*, 2017 — https://arxiv.org/abs/1706.03762
- Ouyang et al., *Training language models to follow instructions with human feedback*, 2022 — https://arxiv.org/abs/2203.02155
- Xu et al., *Hallucination is Inevitable: An Innate Limitation of Large Language Models*, 2024 — https://arxiv.org/abs/2401.11817
- Liu et al., *Lost in the Middle: How Language Models Use Long Contexts*, 2023 — https://arxiv.org/abs/2307.03172
- Wang et al., *Self-Consistency Improves Chain of Thought Reasoning in Language Models*, 2022 — https://arxiv.org/abs/2203.11171
- Guo et al., *On Calibration of Modern Neural Networks*, 2017 — https://arxiv.org/abs/1706.04599
- OpenAI API Reference — https://platform.openai.com/docs/api-reference/chat
- Anthropic Messages API — https://docs.anthropic.com/en/api/messages
- Gemini API — https://ai.google.dev/api/generate-content
