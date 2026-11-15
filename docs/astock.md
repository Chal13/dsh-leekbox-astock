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

## 已知边界

- `chip_distribution` 是本地推演（OHLC + 换手率），不是券商实测持仓；用前复权价，看形态与相对变化。
- `equity_pledge` 只覆盖沪深（中国结算口径），北交所代码会直接报错。
- 北交所老号段 43/83/87 在东财研报库不再索引，会提示改用 920xxx。
- `sina_research_reports` 对连续请求返回假空页，非测试模式内置 6 秒最小间隔。
- 一期不包含：ETF 期权、iwencai（需 Key）、baostock 估值历史、期货与可转债。
