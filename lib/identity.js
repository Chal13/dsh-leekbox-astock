// 韭菜盒子 astock fork — 项目身份常量
//
// 本仓库 fork 自 `dsh-leekbox`（韭菜盒子 LeekBox，SuCriss，MIT）。为了让 fork
// 能与官方包在同一台机器上共存/对照，品牌相关标识符全部改名；但**用户数据契约
// 与 HTTP 路由前缀刻意保留原值**——改它们会让已有自选/预警/分析配置失联，或
// 让客户端 bundle、文档、用户脚本全部失效。
//
// | 内部标识符        | 保留值                        | 为什么保留 |
// |-------------------|-------------------------------|-----------|
// | HTTP 路由前缀     | `/api/leekbox/*`              | 客户端 bundle、文档、测试、用户自建脚本都按此路径调用；属接口契约而非用户可见文案 |
// | 持久化文件名前缀  | `$DSH_HOME/.leekbox-*.json`   | 改名会读不到用户已有持仓/自选/预警/分析配置，等同数据丢失，绝不可动 |
// | CSS 类名前缀      | `lkb_` / `lkb-`               | 纯内部样式钩子，只有本插件自己的 DOM 使用 |
// | 样式元素 id       | `dsh-leekbox-style`           | 注入 <style> 时的去重标记，内部实现细节 |
// | 侧边栏行标记      | `data-dsh-leekbox-entry`      | 客户端 DOM 钩子，仅本插件使用 |
//
// 已随 fork 改名同步更新的标识符（用户可见或带品牌含义）：
//   包名 `dsh-leekbox` → `dsh-leekbox-astock`；
//   cordis 行 id `leekbox` → `leekbox-astock`；
//   客户端 bundle id（`__ModuleLoader__.load({ id })`）与单实例哨兵同上；
//   `/health` 里回带的 plugin 名称。

/** cordis 插件名 / 命名空间 key，同时是 Loader 行 `name` 与包名。 */
export const PLUGIN_NAME = "dsh-leekbox-astock";

/** API 前缀。历史原因保留 `leekbox`，见文件头表格 —— 勿改。 */
export const API_PREFIX = "/api/leekbox";

/** 单实例哨兵 key（`globalThis[Symbol.for(...)]`）。 */
export const MOUNT_SYMBOL = "dsh-leekbox-astock.mounted";

/** 持久化文件名前缀。与上游共用，保证 fork 后历史数据可继续读取。 */
export const DATA_FILE_PREFIX = ".leekbox-";

/** 侧边栏入口的 DOM 标记属性（保留上游值）。 */
export const ENTRY_ROW_ATTRIBUTE = "data-dsh-leekbox-entry";
