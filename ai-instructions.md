# ai-instructions.md · DSH 插件开发经验沉淀

> 来源：2026-11 对「韭菜盒子（dsh-leekbox-astock）」做 a-stock-data 能力接入 + 宿主模型改造的完整过程。
> 用途：给未来的 AI 会话（以及人）在**开发 / 修改 / 调试 DSH 插件**时先读一遍，避免重复踩坑。
> 适用面：本仓库优先；同类 DSH 插件（宿主路由 + 客户端面板 + 工具注册）可直接借鉴。

---

## 0. 一句话原则

**先核对运行事实（版本 / 路由 / 日志），再动手；每次只改一层，改完必须 `node --check` → `build` → `run-tests` → 重启 → 用 HTTP 实测。没有实测过的结论一律标注"未验证"。**

---

## 1. 环境事实（动手前先确认）

| 项 | 值 |
|---|---|
| **源码目录（开发/提交）** | `D:\Github\dsh-leekbox-astock` —— git 工作区，改代码、跑测试、commit、push 都在这里 |
| **安装目录（DSH 加载）** | `D:\DSH\Projects\leekbox-astock` —— DSH 实际加载的那一份拷贝；**不要在这里开发或手改** |
| 发布方式 | `pwsh -File scripts\install-to-dsh.ps1 -RunTests`（源码 → 安装目录，robocopy /MIR），然后**完全重启 DSH** |
| 宿主 profile | `C:\Users\Charl\.dsh\profiles\desktop`（**不是 README 里写的 web profile**） |
| 安装接线 | profile `package.json`：`"dsh-leekbox-astock": "link:D:/DSH/Projects/leekbox-astock"`，并加入 `dsh.profile.bundles`；`node_modules/dsh-leekbox-astock` 是指向安装目录的 **Junction** |
| 宿主入口 | `lib/index.js`（`export { name, inject = ['webServer'], apply }`） |
| 客户端产物 | `lib/client.js` 是**构建产物**，源码在 `src/client/*.js`，由 `build.mjs`（esbuild）打包 |
| 版本位 | `/api/leekbox/health` 的 `version`；发布前同步 `package.json` 与 `CHANGELOG.md` |
| 重启规则 | 改 `lib/**`（宿主代码）→ 同步到安装目录后**完全退出并重开 DSH**；改 `src/client/**` → `node build.mjs` 后同步 + 刷新页面 |

**为什么源码与安装分开**：DSH 通过 profile 里的 Junction 加载安装目录；开发期在源码仓库里改、验证，确认无误后再同步过去。这样既不会因为实验性改动弄坏正在用的插件，也不受 git 工作区状态影响。

> 单向同步是**有意的**：安装目录永远由脚本从源码覆盖（`/MIR` 会删掉安装目录里多出的文件），不要在安装目录里修 bug——改在源码里改，否则下次同步会被覆盖。

**宿主进程的 GUI 端口每次重启都会变**（例如 50872 → 52878 → 61254），验证脚本不要写死端口，从运行时上下文或 `/health` 所在 URL 取。

### 常用命令

```powershell
cd D:\Github\dsh-leekbox-astock
node --check lib/index.js          # 逐个检查改过的宿主文件
node --check lib/chat.js
node build.mjs                     # 改了 src/client/** 才需要
node run-tests.mjs                 # 22 个 suite；known: p1-f10-longhu-test（fixture 过期）
pwsh -File scripts\install-to-dsh.ps1 -RunTests   # 验证通过后发布到安装目录
```

测试约定：`run-tests.mjs` 会逐个跑 `*-test.mjs`；`LEEKBOX_TEST=1` 时上游限流直通（保证用例不互相拖）。新增能力应配一个纯函数/契约级测试，别只靠手测。

---

## 2. DSH 插件骨架（读懂这三层再改）

### 2.1 宿主半（Node，跑在 DSH 进程内）

- 路由是**声明式数组**：`makeRoutes(ctx, deps)` 返回 `[{ kind: "exact", path, handler }]`，
  在 `apply()` 里 `ctx.webServer.register(route)`，返回 dispose。
- 路由守卫：只接受 loopback；写接口额外要求 `Origin` 为本机 + `Content-Type: application/json`。
- 统一失败出口：`fail(res, error)` → 中文 `error` 给浏览器、技术细节进 `reason`（**不要让英文抛给用户**）。
- 软依赖服务一律 `ctx.get('service')` + 判空：`tools`、`llm`、`agentDefaultModel`、`agentPresets`。
  缺失时要降级并给中文提示，**不能让插件加载失败**。
- 插件自用状态落 `$DSH_HOME/.leekbox-*.json`（自选、预警、分析配置、对话记录），原子写：写 `.tmp` 再 `renameSync`。

### 2.2 客户端半（React，跑在 Web 面板里）

- `src/client/*.js` → `build.mjs` → `lib/client.js`（带 `GENERATED FILE` 头 + `ModuleLoader` 包装，react 是 external）。
- `client-bundle-test.mjs` 会检查：产物是否为最新构建、17 个模块导入/导出配对是否完整。
  **改了 `src/client/**` 不 rebuild 会直接挂这条测试。**
- 面板协议：客户端只认 `/api/leekbox/*` 的返回值。改服务端返回结构前，先搜 `src/client/` 里谁在读这些字段。

### 2.3 工具与模型（agent 能力）

- `ctx.get('tools').register(def)`：`{ name, description, parameters, execute(args) }`。
  这里的 `parameters` 是**插件自定义的参数表**（`{action: {type, required, description, enum}}`），
  **不是** JSON Schema；给 `llm.stream` 用要先转换（见 §4.2 `toToolSchema`）。
- `ctx.get('llm').stream({ provider, model, system, messages, tools, maxTokens, reasoningEffort, signal })`
  返回 `AsyncIterable`，关键 chunk：
  - `{ type: 'text-delta', text }`
  - `{ type: 'tool-call-delta', id, name?, argumentsDelta }`
  - `{ type: 'block-end', block: { type: 'tool-call', id, name, arguments } }`
  - `{ type: 'finish', reason: { kind: 'error' | 'stop' | 'tool-calls' | ..., failure? } }`
- `ctx.get('agentDefaultModel').currentSelection()` → `{ provider, model, reasoningEffort? }`。
  **这是唯一可信的模型来源**；不要自己发明 `maxTokens` / `reasoningEffort`。
- 消息形状（`llm.stream` 的 `messages`）：
  - user：`{ role: 'user', content: [{ type: 'text', text }] }`
  - assistant：`{ role: 'assistant', id, source: { kind: 'model', provider, model }, content: [text 块, { type:'tool-call', id, name, arguments }] }`
  - tool 结果：`{ role: 'tool', id, source: { kind: 'tool', callId }, toolCallId, content: [{ type:'text', text }], isError }`
  - 工具调用与结果必须**紧邻配对**，历史里不能留下未应答的 tool-call（adapter 会报 `INVALID_REQUEST`）。

---

## 3. 本项目已验证的架构（可直接复用）

```
lib/index.js           路由 + 守卫 + 统一错误出口
lib/capabilities.js    能力注册表：id/layer/label/source/params/ttl/load（唯一事实来源）
lib/astock/<layer>.js  各层 fetcher（signal/capital/limitup/event/research/macro）
lib/astock-tools.js    把注册表转成 agent 工具（参数表 + Markdown 截断输出 + catalog）
lib/upstream.js        按上游族串行限流（东财 ≥1s+抖动，腾讯 ≥350ms，交易所 ≥500ms）
lib/contract.js        统一响应契约（not_published / upstream_down / invalid_param）与 HTTP 映射
lib/route-cache.js     TTL + 单飞 + stale-if-error；配合 calendar 的时段感知 TTL
lib/calendar.js        交易日历（指数日 K 反推）+ 交易时段
lib/host-llm.js        宿主模型直连（分析与对话用）：llm.stream + 选中路由 + 中文错误
lib/model-catalog.js   DSH 模型目录桥：llm.listProviders()/listModels() + agentDefaultModel 默认选择
lib/chat.js            面板对话：直连 llm.stream + 插件侧工具循环 + 落盘记录
python/astock_sidecar.py  只承载确实需要 Python 的 3 个端点（社融/中债/回购定盘）
```

**注册表是核心**：加端点 = `capabilities.js` 加一条声明 + layer 文件写 fetcher；工具层、`/capabilities`、`/metrics` 自动跟随，不会漂移。

---

## 4. 本次关键决策与理由（照抄前先看理由）

### 4.1 「AI 分析」用宿主模型，不再要用户填 API Key

- `lib/host-llm.js` 走 `ctx.get('llm').stream`，凭据与主窗口一致；插件不保存、不转发密钥。
- 设置页不自己维护服务商/密钥，而是**从宿主读**模型目录（`lib/model-catalog.js`）：
  `llm.listProviders()` 出供应商、`llm.listModels(provider)` 出模型；选「跟随 DSH 默认」
  则清空选择。配置文件 `$DSH_HOME/.leekbox-analysis.json` 只存 `{provider, model}`。
- 结论：面板里凡是"让用户填第三方 Key"的功能，都应优先考虑直连宿主模型；
  模型列表不要写死在插件里（DSH 里新增供应商后插件应自动可见）。

### 4.2 「面板对话」直连宿主 LLM + 插件自己执行工具（**不要**用 `ctx.agents`）

实测（2026-11）：

- 用 `ctx.agents` 创建会话时，LLM 请求**确实发出并返回 200**，SSE 已开始（最多读到 204KB），
  随后在 **2~10 秒被宿主侧 abort**（abort 栈只有 undici 内部帧），adapter 把 AbortError 包装成
  `DeepSeek Messages transport failed`（TRANSPORT）。
- 同一进程里**直连 `llm.stream` 可连续流 100+ 秒不中断**（分析页）。
- 已排除：effort（high/low/off 全挂）、工具集（是正常会话的严格子集、schema 逐字一致）、网络/代理。

**因此面板对话采用**：直连 `llm.stream` + 插件侧工具循环（单轮最多 4 步、工具结果截断 4000 字符回灌、
历史只留用户/助手文本、`setTimeout` 把 turn 甩出 HTTP 请求上下文）。
工具 schema 转换：

```js
function toToolSchema(def) {
  const properties = {}; const required = [];
  for (const [k, p] of Object.entries(def.parameters ?? {})) {
    properties[k] = { type: p?.type ?? "string", ...(p?.description ? { description: p.description } : {}), ...(p?.enum ? { enum: p.enum } : {}) };
    if (p?.required === true) required.push(k);
  }
  return { name: def.name, description: def.description, parameters: { type: "object", properties, ...(required.length ? { required } : {}) } };
}
```

> 如果未来 DSH 修好了 agent 路径，可以回到 agent 方案（能复用宿主 preset/工具限制），
> 但**先按 §6 的对照实验验证**，不要因为"官方推荐"就换回去。

### 4.3 不要钉死调参

- 曾经写过 `reasoningEffort: "low"` + `maxTokens: 32000`：换到自定义 OpenAI 兼容路由（如 `unicom-yj`）
  会被网关回 `404 status code (no body)`。
- 正确做法：从 `currentSelection()` 取 provider/model/effort 原样透传；`maxTokens` 交给模型目录。
- 失败自愈可以做，但**先修根因**，别用重试掩盖。

### 4.4 上游治理

- 东财必须串行 + ≥1s + 抖动（skill 有实测：4.5 万次/小时 → IP 级封 20 小时）；
  腾讯不封 IP 但仍限速；交易所/官方源避免高频整包下载。
- 东财 `push2/clist` 网关会按出口 IP 做**连接级封锁**（三台镜像全 RST，curl 也 000）。
  遇到时：文案写「可能已按出口 IP 限流，请稍后重试或更换网络/代理节点」，**不要静默返回空**。
- 多镜像回退必须**串行**，不能并发扇出（原 emrank 的多 host 并发是隐患）。

### 4.5 契约

- 统一 `{ capability, layer, source, sourceUrl, fetchedAt, unit, rows }`；单位必须写（元/手/股/%）。
- 「确实没有」（`not_published`，如非交易日、未发布）与「接口坏了」（`upstream_down`）必须分开。
- 参数非法 → 400，**不要静默换默认值**（龙虎榜日期、代码格式尤其）。
- 工具输出默认截断 10 行 + 总数，`limit` 最大 50：不截断会一次吃掉几千 token。

---

## 5. 坑位清单（每条都有实测依据）

| # | 坑 | 现象 | 正确处理 |
|---|---|---|---|
| 1 | `ctx.agents` 请求被中途 abort | `/messages` 200 后 2~10s 断，报 TRANSPORT | 见 §4.2，改直连 |
| 2 | 钉 `maxTokens:32000` | 自定义路由 404 no body | 不钉，透传模型目录 |
| 3 | effort 猜测 | high/low/off 全挂，误判为 effort | 用对照实验排除（同进程直连） |
| 4 | push2 clist 封锁 | 三镜像 RST / curl 000 | 明确文案 + 换出口 IP |
| 5 | 工具 schema 混用 | 插件参数表直接喂 `llm.stream` 会 400 | 转 JSON Schema |
| 6 | 会话日志读不出 | `.zstd` 是**多帧**，`zstdDecompressSync` 只解第一帧 | 按 magic `28 b5 2f fd` 切帧逐段解压 |
| 7 | PowerShell 写 UTF-8 | 中文变乱码、package.json 带 BOM 报 `ERR_INVALID_PACKAGE_CONFIG` | 用编辑/写文件工具改文本；**不要** `Set-Content` 改 JSON |
| 8 | 客户端产物过期 | 界面改了没生效 / CI diff 失败 | 每次改 `src/client/**` 后 `node build.mjs` |
| 9 | profile 搞错 | 改了 web profile 却无效果 | 实际是 **desktop** profile（`link:` 安装） |
| 10 | 写死日期 | 示例/提示永远停在某天 | 动态计算（东八区，周末回退最近周五），渲染时重算 |
| 11 | 测试 fixture 过期 | `p1-f10-longhu` known failure | 日期型 fixture 要相对今天生成 |
| 12 | `note` 打印两次 | 工具输出重复一行 | 标量附加字段循环里排除 `note`；空单位过滤 |
| 13 | 北交所老号段 | 43/83/87 返回僵尸价且 200 | 归一化到 920xxx，行情带 `isStale` |
| 14 | 科创板成交量单位 | 别人当"手"，实际是"股" | 单位写进响应，别二次换算 |
| 15 | mootdx 行情失效 | 2026-09 起 K 线/盘口/逐笔全空 | 别照抄旧 skill 的 mootdx 用法 |

---

## 6. 调试方法论（照着走，别瞎猜）

1. **先读 `/health`**：版本、服务注册状态（`astock.registered`）、缓存、模型来源。
2. **对照实验**：同一个进程里"坏路径 vs 好路径"（本次：agent vs 直连 `llm.stream`），
   先证明是链路问题还是参数问题，再改代码。
3. **二分参数**：只改一个变量（effort / maxTokens / 工具集），一次一个。
4. **抓真实请求**：在宿主进程里临时包一层 `globalThis.fetch`（marker 文件开关），记录
   URL、状态码、body 错误、abort 栈；**诊断完必须删掉**（本次 `lib/debug-fetch.js` 已删除）。
5. **读会话事件**：`$DSH_HOME/sessions/<cwd-slug>/<session-id>/session.v4.jsonl.zstd`，
   里面有 `request/header`（config + tools）、`assistant/attempt`（failure）、`turn/end`。
   多帧 zstd 要逐帧解（见 §5-6）。
6. **看模型实际请求**：`request/header.config` 里 `reasoningEffort/maxTokens` 是最直接的证据。
7. **改完**：`node --check` →（如改客户端）`build` → `run-tests` → 重启 → HTTP 实测 → 再报告。

> 判定纪律：没有 HTTP 实测/命令输出的结论，写"未验证"；不要用"应该/大概"代替证据。

---

## 7. 修改工作流 checklist

- [ ] 读相关文件与调用关系（`lib/index.js` 路由、`src/client/**` 消费者、`*-test.mjs`）
- [ ] 只改当前任务需要的内容；不顺手格式化/重构无关文件
- [ ] 新能力：注册表加声明 + fetcher + 契约 + 至少一个测试
- [ ] 错误文案统一中文；技术细节进 `reason`
- [ ] 有界：输出截断、参数上限、历史条数上限、超时（`AbortSignal.timeout`）
- [ ] `node --check` 所有改过的文件
- [ ] 改客户端 → `node build.mjs`
- [ ] `node run-tests.mjs`（22 suites；known 不算失败）
- [ ] 版本号 + `CHANGELOG.md`（Adds/Fixed 分开写，写清实测依据）
- [ ] `pwsh -File scripts\install-to-dsh.ps1 -RunTests` 同步到安装目录
- [ ] 重启 DSH（宿主代码）→ 用 HTTP 脚本实测 → 再向用户汇报
- [ ] 删掉临时诊断代码/日志/marker

---

## 8. 验证脚本模板

```js
// verify.mjs —— 端口取当前 GUI，别写死
const BASE = process.env.DSH_BASE ?? "http://127.0.0.1:61254";
const H = { origin: BASE, "content-type": "application/json" };
const j = async (p, init) => {
  const r = await fetch(BASE + p, { ...init, signal: AbortSignal.timeout(60000) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; }
};
console.log(await j("/api/leekbox/health"));                     // 版本/工具/模型来源
console.log(await j("/api/leekbox/cap?id=margin_trading&code=600519")); // 单能力
// 对话：POST /api/leekbox/chat → GET /api/leekbox/chat/poll?since=-1
// 分析：POST /api/leekbox/analysis/analyze { code:"600519" } → 看 modelSource
```

要点：`/chat` 是**异步**的（返回后轮询），`/analysis/analyze` 是同步长请求（给足超时）；
写接口要带 `origin` + `content-type: application/json`。

---

## 9. 禁止事项

1. ❌ 直接改 **安装目录**（`D:\DSH\Projects\leekbox-astock`）或 profile `node_modules` 里的成品包——改源码仓库，再跑 `scripts\install-to-dsh.ps1` 覆盖过去。
2. ❌ 在 `lib/**` 里留临时诊断代码/日志到发布版本（要么删除，要么用 marker 文件严格门控并写进文档）。
3. ❌ 用 PowerShell `Set-Content` 改含中文的 JSON/JS（编码 + BOM 双坑）；用编辑工具。
4. ❌ 只跑 `node --check` 就宣称"功能验证通过"；构建产物也要 `test` 里的产物一致性检查。
5. ❌ 未重启就宣布宿主侧修改生效（宿主插件不热重载）。
6. ❌ 静默失败：拿不到数据就返回空、参数非法就换默认值、错误吞掉只打日志——本项目明确禁止。
7. ❌ 在插件里保存第三方 API Key（现在默认走宿主模型，不需要）。

---

## 10. 可复用模板（新插件的骨架）

```js
// lib/index.js
export const name = "my-plugin";
export const inject = ["webServer"];
export function apply(ctx, config) {
  const hostLlm = createHostLlm(ctx);          // 宿主模型直连（可选）
  const routes = makeRoutes(ctx, { hostLlm });
  ctx.effect(() => routes.map((r) => ctx.webServer.register(r)), "my-plugin: routes");
  const tools = astockTools();
  const reg = ctx.get?.("tools");
  if (reg?.register) ctx.effect(() => tools.map((t) => reg.register(t)), "my-plugin: tools");
}
```

```js
// 能力一层的写法：注册表声明 + fetcher + 契约
{ id: "margin_trading", layer: "capital", label: "融资融券",
  source: "eastmoney-datacenter",
  params: { code: { type: "string", required: true, hint: "600519 / SH600519" }, pageSize: { type: "number", default: 30 } },
  ttlMs: () => sessionTtl(60 * 60_000), staleIfError: 24 * 60 * 60_000,
  load: capital.marginTrading }
```

```js
// 直连模型的最小用法（无需 agent）
const sel = ctx.get("agentDefaultModel").currentSelection();
for await (const chunk of ctx.get("llm").stream({
  provider: sel.provider, model: sel.model, system, messages,
  tools: defs.map(toToolSchema), maxTokens: 4096,
  signal: AbortSignal.timeout(180_000),
})) { if (chunk.type === "text-delta") out += chunk.text; }
```

---

## 11. 数据源红线（来自 a-stock-data skill，务必遵守）

- 行情/K 线优先**腾讯**（不封 IP，K 线单入口约 600 次后限流，三入口轮换）；
- 东财**只用于独有数据**，串行 + ≥1s + 抖动；被封时查 skill 的「备用源速查」；
- 官方源（交易所/中债/统计局等）避免高频整包下载；
- 不搬 Python 依赖进 Node（`mootdx` 行情已失效、`baostock` 不支持北交所）；
- 端点新增前先确认真实可用（`/cap` 实测 + 契约测试），不要照抄文档。

---

## 12. 维护这份文件

- 每次完成一轮"有踩坑"的修改，**更新 §5 坑位表与 §4 决策**（新的证据、新结论、被推翻的旧结论要标明）。
- 版本相关事实（端口、版本号、known 测试）不要写进正文表格，统一放 §1 并保持简短。
- 本文件面向"未来的 AI 会话"：写结论、写证据、写为什么，不要写过程流水账。
