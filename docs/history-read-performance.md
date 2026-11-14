# 历史读取性能：Corax 0.1.1

## 当前实现

全部 workspace 消费方固定使用正式发布的 `@coraxjs/core@0.1.1`。
依赖通过 pnpm 10.15.1 和共享锁文件安装，不使用本地 SDK link。历史性能修复已在发布包内，
不再使用旧扫描补丁；当前仅有单独的[会话重命名补丁](session-rename.md)。

Corax 内嵌官方 `vercel/workflow@c11fc40013681fef9afe0b315b1d22284579bbe0`
的 SQLite Local World（上游 PR #5235）。原生运行数据位于
`dataDir/corax/.workflow-data/world.db`，使用 Node 内置 `node:sqlite`。

- 尾查询和区间读取使用 SQLite 索引，不再为获取尾位置逐个打开全部 chunk 文件。
- 有限 HTTP 读取由 Corax 共享请求内的固定尾边界，响应头与正文使用同一游标边界。
- 正游标实时订阅不额外查询尾索引，未知或过期会话仍由原生接口拒绝。
- 应用继续使用公开 Corax API、官方 reducer 和有界的进程内显示缓存。
  完整状态同步确认前，尾部预览不提供写入权限。

## 验证与部署

`desktop/scripts/corax-runtime.ts` 在部署及安装器校验时检查正式版本、
SQLite World 来源、许可证和有限历史实现产物，不导入私有 SDK API。
`tests/node/corax-runtime.test.ts` 检查当前安装包以及错误版本/来源的拒绝行为。
`tests/corax/runtime.test.ts` 通过隔离的假模型及本地厂家夹具验证原生 HTTP 会话和应用工具。

Corax 发布前的独立测试以一个进程写入 20,000 个 350 字节 chunk，关闭后另启新进程读取：

| 操作           |  测得耗时 |
| -------------- | --------: |
| 首次尾查询     |   3.92 ms |
| 末尾 512 chunk |   1.74 ms |
| 全部 7 MB 正文 | 179.05 ms |

这是存储层新进程测量，不是受控冷磁盘或完整桌面渲染时间。
生产及 dev 各自的跨进程续聊测试、Linux/Windows CI 和实际桌面试用均已通过。
旧文件布局不做迁移，也不删除开发者数据；新会话使用 SQLite。

## 原问题及已移除方案

0.1.0 的文件实现每次尾查询枚举、排序并检查整个会话的 chunk；正文逐文件读取。
真实会话数千至上万文件的首次尾查询曾耗时 5～13 秒，串行对照还发生过 30 秒超时。
32 路并发只缩短部分扫描，eve 的非 EOF 缓存只改善进程内重复访问，都没有去除首次全量文件 I/O。

旧历史扫描补丁及其 patchedDependencies、helper 契约测试已随正式 0.1.1 接入删除。
不恢复应用侧私有文件访问、持久聊天索引或逐文件扫描来替代原生存储。

dev 分段计时仍位于 `dataDir/corax/logs/desktop-debug.log`，记录有界数值元数据，
可区分 HTTP 头、正文、投影和视图同步耗时，不记录正文或凭证。
