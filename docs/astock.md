# a-stock-data 能力层（astock）

本 fork 在保留韭菜盒子全部原有功能的前提下，把
[`simonlin1212/a-stock-data`](https://github.com/simonlin1212/a-stock-data) skill 的端点
按「能力分类」接成 **agent 工具**。模型在 DSH 对话里按工具描述路由到层，
再用 `action` 选择具体端点。

## 工具一览

| 工具 | skill 层 | action（端点） | 引擎 |
|---|---|---|---|
| `astock_signal` | §3 信号 | board_fund_flow / industry_comparison / lockup_expiry / dragon_tiger_board / daily_dragon_tiger | Node |
| `astock_capital` | §4 资金筹码 | margin_trading / block_trade / holder_num_change / dividend_history / stock_fund_flow_120d / chip_distribution / etf_shares | Node（CYQ 纯 JS 本地计算） |
| `astock_limitup` | §8 打板 | em_zt_pool / em_zb_pool / em_dt_pool / em_yzt_pool / ths_limit_up_pool / limit_up_sentiment / em_stock_monitor / em_price_anomaly / em_price_anomaly_count | Node |
| `astock_event` | §14 事件驱动 | earnings_forecast / institution_survey / holder_trades / share_buyback / equity_pledge / ipo_calendar | Node |
| `astock_research` | §2 研报 | eastmoney_reports / eastmoney_industry_reports / ths_eps_forecast / sina_research_reports | Node |
| `astock_macro` | §11 宏观利率 | pboc_social_financing / nbs_pmi / chinabond_yield_curve / repo_fixing_rates / lpr_history / macro_calendar | 混合：LPR/PMI/日历 → Node；社融/中债/回购定盘 → Python 边车 |
| `astock_catalog` | 元数据 | 无参数，列出层 → 端点 → 参数 | Node |

## 参数与输出

- `code` 接受 `600519` / `SH600519` / `600519.SH` / `600519.XSHG`；前后缀矛盾或无法识别会**报错**，不会静默换一只票。
- `action` 必填（层内首个端点为缺省）。
- 表格默认截断前 10 行，可传 `limit`（1–50）；返回带 `rows` 总数提示。
- 单位写进响应（元 / 万元 / 万股 / 手 / %），避免二次换算。
- `not_published`（确实没有数据，例如非交易日）与 `upstream_down`（接口坏了）分开。

## 上游治理

- `lib/upstream.js`：按上游族串行队列 + 最小间隔 + 抖动（东财 ≥1000ms，腾讯 ≥350ms，交易所 ≥500ms）。
  测试模式（`LEEKBOX_TEST=1`）下直通，避免测试互相拖累。
- `lib/route-cache.js`：所有能力经 TTL + 单飞 + stale-if-error 缓存。
- Node 内置 fetch 不认 `HTTP(S)_PROXY`：在只能走本地代理的机器上会自动降级到 `curl.exe`（仅 Windows，且测试模式禁用）。
- 东财 `push2/clist` 可能按出口 IP 限流；遇到时能力会返回明确的中文错误，稍后重试或换网络。

## Python 边车

`python/astock_sidecar.py` 只承载 **3 个确实需要 Python 的端点**：

1. `pboc_social_financing`（PBC xls 三级跳，仅 2021 年起）
2. `chinabond_yield_curve`（中债 HTML 表格）
3. `repo_fixing_rates`（中国货币网 CSV）

协议：stdin/stdout 逐行 JSON，`{"id","op","args"}` → `{"id","ok","rows","meta"}`。
首次调用时懒启动，子进程退出后自动重启，插件卸载时 kill。
环境变量 `LEEKBOX_PYTHON` 可指定解释器（默认 `python`）。

## 插件内对话

面板「对话」页通过 `/api/leekbox/chat`（发送）、`/chat/poll`（轮询回复）、`/chat/reset`（新对话）
读写插件自己的对话记录（落盘在 `$DSH_HOME/.leekbox-chat.json`）：

- 模型走**宿主直连链路** `llm.stream`（与「AI 分析」同一份凭据、同一条路径），
  不再创建 `ctx.agents` 会话。原因：实测宿主 agent 路径的 LLM 请求会在 2~10 秒被
  中途 abort（adapter 包成 `TRANSPORT`），而同一进程里直连链路可稳定流式输出。
- 工具调用由插件自己执行：把 `astock_*` 的 7 个工具转成 JSON Schema 交给模型，
  单轮最多 4 步；工具结果截断到 4000 字符再回灌，避免吃爆上下文。
- 对话历史只保留用户/助手文本（不保留工具中间态），落盘上限 80 条 / 模型侧 20 条。
- 没有默认模型、模型不可用、限流、凭据失效都会回明确中文，面板其他功能不受影响。
- 对话页示例里的「全市场龙虎榜」日期按东八区当前时间动态生成（周末回退到最近周五），
  不会停留在写死的某一天。

## AI 模型来源（使用 DSH 已接入的模型）

「AI 个股分析」与面板「对话」都使用 **DSH 自己接入的模型**，插件内不再配置任何
第三方 API（没有地址、协议、密钥输入）：

- 服务端 `lib/host-llm.js` 通过宿主的 `llm` 服务发起补全（provider/model 由
  `lib/model-catalog.js` 从宿主读取），凭据与主窗口对话完全一致。
- `/api/leekbox/analysis/config`：
  - `GET` 返回 `providers`（宿主 `llm.listProviders()`）、`models`（当前选中供应商的
    `llm.listModels()`）、`provider/model`（插件里选的那一对，空 = 跟随 DSH 默认）、
    `effective`（实际生效的 provider/model/effort/source）。
  - `POST { provider?, model? }` 只保存选择：`provider=""` 表示「跟随 DSH 默认」；
    否则要能在 DSH 的供应商/模型列表里找到。
- `/api/leekbox/analysis/models?provider=<id>` 返回该供应商下 DSH 能发现的模型，
  供设置页的模型下拉使用。
- 全局设置里的「模型供应商 / 模型」两个下拉就是 DSH 的模型选择器；要新增模型请先在
  DSH 设置里配置，插件会自动看到。
- effort：优先用宿主选择里的档位，缺省显式用 `low`（DeepSeek account 路由上 `high`
  会断连）；模型不支持该档位时自动去掉 effort 重试一次。
- 配置文件仍是 `$DSH_HOME/.leekbox-analysis.json`，但只保留 `provider/model` 两个
  字段；老配置里的 `baseUrl/apiKey/mode` 一律忽略。

## 已知边界

- `chip_distribution` 是本地推演（OHLC + 换手率），不是券商实测持仓；用前复权价，看形态与相对变化。
- `equity_pledge` 只覆盖沪深（中国结算口径），北交所代码会直接报错。
- 北交所老号段 43/83/87 在东财研报库不再索引，会提示改用 920xxx。
- `sina_research_reports` 对连续请求返回假空页，非测试模式内置 6 秒最小间隔。
- 一期不包含：ETF 期权、iwencai（需 Key）、baostock 估值历史、期货与可转债。
