# NOTICE — 上游归属与派生说明

`dsh-leekbox-astock`（**韭菜盒子 astock fork**）是
[`SuCriss/dsh-leekbox`](https://github.com/SuCriss/dsh-leekbox)（**韭菜盒子 LeekBox**）的衍生作品（fork）。

## 上游

- 项目：`dsh-leekbox` — A股看盘助手 / A-share market dashboard for DeepSeek Harness (DSH)
- 作者：**SuCriss**
- 许可：**MIT**
- 钉定 commit：`1d47fb1bf8f0593b76a57fbfec77516ffe5f79fa`（2026-10-28，tag `v0.19.5`）

上游的 `LICENSE`（MIT，Copyright (c) 2026 SuCriss）**原样保留**在仓库根目录。

上游全部功能 —— 大盘指数、行情列表、全市场搜索、自选分组与持仓盈亏、价格预警、
选股器、快讯聚合、AI 个股分析、K 线 / 分时图、CSV/JSON 导入导出 —— 均完整保留。
`/api/leekbox/*` 既有路由与 `.leekbox-*.json` 数据文件的语义**未改动**。

## 本 fork 新增

（随实施进度更新）

- **a-stock-data 能力层**（规划中）：按 skill 的 15 层端点分类注册 agent 工具，
  含全局按域串行限流器、能力注册表与数据契约。详见 `docs/astock.md`。

## 相对上游的改动点

1. **`package.json`** — 包名改为 `dsh-leekbox-astock`、版本 `0.20.0-astock.0`；
   修复上游文件里的非法 UTF-8 字节（描述字段曾被有损转换，Node 24 的 ESM 解析器
   会因此报 `ERR_INVALID_PACKAGE_CONFIG`）；`files` 增加 `python/` 与 `NOTICE.md`；
   `check` 增加 `lib/identity.js`、`run-tests.mjs`。
2. **`run-tests.mjs`（新增）** — 逐套件执行并汇总。上游用 `&&` 串联 21 个套件，
   首个失败会**静默跳过**其余套件；已知的上游日期脆弱测试
   `p1-f10-longhu-test.mjs`（fixture 钉在 2026-10-09）单独标注为 known，不计入失败。
3. **`cordis.patch.yml`** — 注册行 id 改为 `leekbox-astock`，避免与已安装的官方副本冲突。
4. **`build.mjs`** — 产物 banner 与 `__ModuleLoader__.load({ id })` 改为 `dsh-leekbox-astock`。
5. **`lib/index.js`** — 插件名、`/health` 的 plugin 字段、单实例哨兵改为 astock 命名；
   路由表与既有实现未改。
6. **`lib/identity.js`（新增）** — 记录"哪些标识符绝不改名"及其原因。
7. **`client-bundle-test.mjs`** — 两处 id 断言随重命名同步。

## 许可

本衍生作品同样以 **MIT** 分发，并保留上游版权声明。
「韭菜盒子 LeekBox」的命名与品牌归 SuCriss 所有；本仓库以 `dsh-leekbox-astock`
名义分发，仅在描述中如实说明其派生自上游。
