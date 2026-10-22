# Zen 直连模式（`OPENCODE_ZEN_DIRECT`）

> 这个模式给「自己拥有工具循环」的客户端用 —— DSH、Cline、Roo Code、Continue 之类。
> 它把客户端声明的工具**原样作为原生 function schema** 发给 OpenCode Zen 免费通道，
> 于是模型返回标准 `tool_calls`，客户端自己执行工具、自己回传结果。

## 1. 为什么原版接进 DSH 用不了工具

原版的链路是：

```
客户端(DSH) → opencode2api → 本地 opencode serve 进程 → OpenCode Zen
```

`opencode serve` 的工具表是**固定注册**的（bash / read / edit / task / webfetch …），
请求里塞进来的客户端工具 schema 没有任何入口能注册进去。所以原版只能：

1. 把客户端工具转成一段 system prompt 里的 `<function_calls>` **文本契约**；
2. 用 `plugin/opencode2api-tool-lock.js` 在**执行时**掐掉所有原生工具。

于是一个像 DSH 这样的 agent 宿主看到的是：

- 自己那 20 多个工具从来没以 function schema 出现，模型只能靠"照着文本契约拼 XML"；
- 模型真正能看见的、带 JSON Schema 的工具是 opencode 自带的 bash / read / edit …，
  于是它**几乎总是**去调这些原生工具；
- 调用一落地就被 tool-lock 拦掉，模型收到
  `Tool "bash" is disabled by opencode2api. Do not call it again.`
  —— 这就是你在 DSH 会话里看到的那句话。模型随后往往直接放弃用工具。

原版做出这个设计，是因为它认定「免费层要求工具列表和官方客户端完全一致」
（见 `plugin/opencode2api-tool-lock.js` 顶部注释）。这个结论**过严**了。

## 2. 免费通道真正的要求（2026-10-22 实测）

用 `Authorization: Bearer public` + 与官方 CLI 一致的 header 打
`https://opencode.ai/zen/v1/chat/completions`：

| 请求形态 | 结果 |
| --- | --- |
| `stream:true`，tools 里同时有 `bash` 和 `read`（带非空 schema），再额外加 `web_search` 等自有工具 | **200**，正常返回 `tool_calls` |
| 同上，但 `stream:false` | **403** `FreeTierError` |
| tools 只有自有工具（没有 bash/read） | **403** `FreeTierError` |
| 完全不带 tools | **403** `FreeTierError` |

也就是说，闸门检查的是**形态**：流式 + 「agent 形状」的工具数组（`bash` + `read`），
而不是「必须和官方客户端一模一样」。**额外工具是放行的** —— 这正是原生工具能工作的原因。

另外两个细节：

- session header 里的 `ses_*` 必须是**规范形状**：`ses_` + 12 位 hex（毫秒时钟按位取反，
  低 12 位是每毫秒计数器，必须在 `[0,63]`）+ 14 位 base62。随手生成的随机串会 403。
- 免费模型 = id 以 `-free` 结尾的，外加 `big-pickle`。其余（`claude-opus-4-5` 等）匿名访问返回 401。

## 3. 这个模式做了什么

`src/zen-direct.js` 直接对 Zen 说 OpenAI 协议，跳过 opencode 进程：

- **保留客户端工具**：`tools` 原样转发，不做任何改名 / 命名空间化 / 文本契约；
- **只补齐闸门**：客户端没带 `bash` / `read`（或它们的 `parameters.properties` 是空的）时，
  才把这两个官方 schema 追加在末尾。已经带了就完全不碰；
- **请求一律流式**：上游强制 `stream:true`（免费层要求）。客户端要 `stream:false` 时，
  本地把 SSE 折叠成一个完整的 `chat.completion`（含 `tool_calls` / `usage`）再返回；
- **伪装 header**：`opencode/1.18.31` UA + 全套 `x-opencode-*` / `x-session-affinity` correlation header，
  session id 按「首条 user 消息」稳定派生，同一个会话复用同一个 id；
- **错误可读**：`403 FreeTierError` 会被翻译成 `type: "free_tier_gate"` 并带上上游原文，
  429 / 5xx 在响应头发出前自动退避重试（默认 3 次）。

### 和原版的行为差异

| | 原版（opencode 后端） | Zen 直连 |
| --- | --- | --- |
| 客户端工具 | 文本契约 `<function_calls>` | 原生 function schema |
| 模型返回 | 代理解析文本后合成 `tool_calls` | Zen 原生 `tool_calls` |
| 工具在哪执行 | 容器内（或被 tool-lock 掐死） | **客户端本地**（DSH 自己的沙箱） |
| 需要 opencode 进程 | 需要 | 不需要（省一份内存） |
| `/v1/messages`（Anthropic） | 支持 | 不支持（走原版） |
| 会话亲和 / prompt cache | 代理自建 session | 由 Zen 侧 session header 决定 |

## 4. 开启方式

```env
OPENCODE_ZEN_DIRECT=true
```

放在 `.env` / `config.json`（`"ZEN_DIRECT": true`）/ 环境变量都行。启动日志会打印：

```
[Proxy] Zen-direct lane enabled -> https://opencode.ai/zen/v1 (native tool calls, no OpenCode backend)
```

### 可选配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `OPENCODE_ZEN_BASE_URL` | `https://opencode.ai/zen/v1` | 上游地址（自建反代 / 出口 IP 轮换时改这里） |
| `OPENCODE_ZEN_API_KEY` | `public` | 免费通道用不到；换成付费 key 才会走付费模型 |
| `OPENCODE_ZEN_DIRECT_RETRIES` | `3` | 429 / 5xx 的退避重试次数 |

### Docker

镜像里已经包含 `src/zen-direct.js`（`COPY . .`），所以：

```bash
# .env 里加 OPENCODE_ZEN_DIRECT=true，然后重建镜像
docker compose build && docker compose up -d
```

如果不想重建（用官方镜像 + 挂载补丁文件）：

```yaml
services:
  opencode2api:
    volumes:
      - ./src/zen-direct.js:/home/node/project/src/zen-direct.js:ro
      - ./src/proxy.js:/home/node/project/src/proxy.js:ro
    environment:
      - OPENCODE_ZEN_DIRECT=true
```

## 5. 验证

```bash
# 1) 模型列表只剩免费通道
curl -s http://127.0.0.1:10000/v1/models -H "Authorization: Bearer $API_KEY" | head -c 400

# 2) 原生工具调用
curl -s http://127.0.0.1:10000/v1/chat/completions -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' -d '{
  "model": "opencode/deepseek-v4.1-flash-free",
  "stream": false,
  "messages": [{"role":"user","content":"用 bash 执行 ls -la"}],
  "tools": [
    {"type":"function","function":{"name":"bash","description":"run","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}},
    {"type":"function","function":{"name":"read","description":"read","parameters":{"type":"object","properties":{"file_path":{"type":"string"}}}}}
  ]}' | python3 -m json.tool
# finish_reason 应为 "tool_calls"，message.tool_calls[0].function.name 为 bash
```

单元测试：

```bash
npx jest tests/unit/zen-direct.test.js --runInBand
```

## 6. 已知限制

- 直连模式下 `/v1/messages`（Anthropic 协议）仍走后端，而后端不启动 → 该端点不可用。
  需要它就把 `OPENCODE_ZEN_DIRECT` 关掉，或另开一个实例。
- 免费通道是**按出口 IP 限额**的：容器在同一个 egress IP 上并发太多会 429。
  多出口轮换请改 `OPENCODE_ZEN_BASE_URL` 指到自己的反代。
- 注入的 `bash` / `read` 桩用的是官方 schema。若客户端**完全没有**声明任何工具，
  请求会带 `tool_choice:"none"`，模型不会去调它们；若客户端声明了别的工具但没 bash/read，
  极小概率模型会去调这两个桩 —— agent 宿主（DSH 等）自己就带 bash/read，不会走到这条路径。
- 这是非官方通道的逆向用法，上游随时可能再收紧（历史上已经加过 session 形状、
  时间戳反查、工具形态三道闸）。失败了看 `/health/details` 的 `zen_direct` 字段和错误体里的 `upstream` 原文。
