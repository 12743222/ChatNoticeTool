# ChatNotice 自动读取设计

- 日期：2026-11-19
- 状态：待实现
- 范围：桌面端内置自动读取、DeepSeek 生成待办、设置界面与开机自启

## 1. 目标

用户自行设定每天允许读取的时间段和在时间段内的读取间隔。ChatNotice 在桌面端运行期间按设定执行有界读取，只有发现新消息或内容变化时才调用 DeepSeek 生成待办，并把明确可执行的事项直接写入待办库。

默认值：

- 时间段：08:00–22:00
- 间隔：60 分钟
- 模型：DeepSeek `deepseek-flash`
- 每日模型调用上限：14 次
- 自动读取默认关闭，需要用户配置 Key 后手动开启
- 开机自启默认开启，可用开关关闭

## 2. 非目标

- 不做实时监控、推送或后台常驻服务。
- 不读取未授权群，不扩大来源范围，不访问聊天数据库之外的内容。
- 不自动发送消息、不修改原始聊天数据库。
- 不把完整数据库、联系人列表或本地路径发送给模型。
- 手机端不运行第二套调度器，只同步电脑端生成的待办。
- 现有 `config.json` 的 `policy.background_monitoring` 保持 false；本功能不是持续监控，而是用户显式开启、有时间窗和次数上限的周期读取。启用状态由 `state/automation.json` 独立控制。

## 3. 已确认的用户选择

| 项目 | 选择 |
| --- | --- |
| 生成方式 | 自动调用模型生成 |
| 模型接口 | 只接 DeepSeek |
| 时间窗 | 单个每日时间段 |
| 创建时间窗默认值 | 08:00–22:00 |
| 读取间隔 | 60 分钟 |
| 运行条件 | 桌面端运行 + 开机自启 |
| 待办落地 | 直接写入待办 |
| 调度方案 | 桌面端内置调度器 |

## 4. 架构

新增组件：

| 文件 | 职责 |
| --- | --- |
| `desktop/automation.py` | 读取/校验自动读取配置、DPAPI 密钥、运行状态和锁 |
| `desktop/deepseek.py` | DeepSeek `deepseek-flash` 客户端，文字和图片请求，超时与重试 |
| `desktop/scheduler.py` | 定时器、时间窗/间隔判断、调用 read/write、候选筛选和状态记录 |
| `desktop/server.py` | 自动读取设置与手动运行的 HTTP 接口 |
| `desktop/ui/` | 顶部齿轮按钮、自动读取设置弹窗和状态展示 |
| `desktop_app.py` | 启动/停止调度器；开机自启注册表维护 |

不改动：

- `agent_cli.py` 的 `read/write` 协议。
- `agent_service.py` 不引入模型、网络或调度器。
- 现有待办库和处理库表结构。
- 手机端 `mobile/www` 的数据流。

调度器使用项目 Python 以子进程调用 `agent_cli.py`，不直接导入内部服务。这样保持 CLI 作为稳定边界，并隔离读取/写入崩溃。

## 5. 运行流程

### 5.1 调度触发

调度器每 30 秒检查一次，以下条件全部满足才执行：

1. 自动读取开关已开启；
2. 当前本地时间在允许时间段内；
3. 距上次尝试时间不少于读取间隔；
4. 没有正在运行的自动或手动读取；
5. 当天模型调用次数未达到上限；
6. 桌面端进程仍在运行。

时间窗规则：

- 开始时间包含，结束时间不包含。
- `start < end` 为当天时间段。
- `start > end` 视为跨午夜时间段，例如 22:00–06:00。
- `start == end` 视为无效配置，保存时拒绝。
- 间隔从“上次尝试”计算，失败尝试也算，避免连续重试。
- 应用刚启动且当前在时间窗内时，30 秒后执行一次，除非上次尝试仍在间隔内。

### 5.2 单轮步骤

1. 获取 `state/automation.lock`；获取失败则本轮跳过。
2. 调用本地 `agent_cli.py read --limit 50`；有未完成游标时使用 `read --batch B --cursor C`。
3. 一轮最多读取 3 页或 150 条消息；仍有 `next_cursor` 时保存到配置，下一轮继续。
4. 筛选候选消息：
   - `changed_since_batch == true`；或
   - `analysis_state == pending`、`task_ids` 为空，且正文非空或已有准备好的图片。
5. 旧 pending 且已有 `task_ids` 的消息（例如未下载 PDF 关联的旧任务）不送模型，保持 pending。
6. 没有候选消息：记录 `read_count`，本轮结束，不调用模型。
7. 从候选中取最多 20 条消息、8 张图片组成一次模型请求。其余候选保持 pending，下一轮再处理。
8. 调用 DeepSeek，解析并校验返回 JSON；失败时修复重试一次。
9. 调用 `agent_cli.py write --input -` 写入待办和每条消息的处理结果。
10. 记录本轮结果：读取数、候选数、创建数、跳过数、模型调用数、错误摘要。
11. 释放锁。

### 5.3 分页与积压

- 读取游标只表示消息已接收，不表示已分析。
- 未被模型处理的消息保持 pending，下一轮会再次出现在 read 结果中。
- 默认最多 14 次模型调用/天，每次最多 20 条消息，因此单日最多自动处理 280 条候选消息。
- 积压超过上限时按轮次消化，不阻塞桌面端其他功能。

### 5.4 并发

- 自动读取和“立即读取一次”共用 `state/automation.lock`。
- 锁存在时新的运行直接跳过，并记录“已有读取在进行”。
- 锁文件带持有者时间戳；超过 10 分钟视为异常残留，仅在用户手动点击“立即读取”时提示处理，不自动删除。

## 6. 配置与密钥

### 6.1 非敏感配置

`state/automation.json`：

```json
{
  "schema_version": 1,
  "enabled": false,
  "window_start": "08:00",
  "window_end": "22:00",
  "interval_minutes": 60,
  "model": "deepseek-flash",
  "daily_model_call_limit": 14,
  "auto_start": true,
  "pending_batch": null,
  "pending_cursor": null,
  "model_calls_date": null,
  "model_calls_count": 0,
  "last_attempt_at": null,
  "last_success_at": null,
  "last_result": null,
  "recent_runs": []
}
```

- `recent_runs` 最多保留 20 条，只记录时间、状态、数量、错误代码，不记录消息正文、群名或路径。
- 配置写入使用临时文件 + 原子替换。
- 首次读取时若文件不存在，使用默认值，不自动创建，直到用户保存设置或调度器首次运行需要记录状态。
- 保存时校验时间格式、间隔范围（5–1440 分钟）和每日上限范围（1–96 次）。

### 6.2 API Key

- 保存位置：`state/model-secrets.dpapi`。
- 内容：`{"deepseek_api_key":"..."}`。
- 使用现有 Windows DPAPI `protect_secret` / `unprotect_secret`，绑定当前 Windows 用户。
- 写入使用临时文件 + 原子替换。
- 读取只发生在构造 DeepSeek 请求时；不写日志、不返回前端、不进入 `automation.json`。
- 支持 `clear_api_key` 显式删除。
- 读取失败或 DPAPI 不可用时，保存操作失败并提示，不降级为明文保存。

### 6.3 重试队列

`state/automation-pending.json` 保存已经生成但尚未成功写入的待办操作：

```json
{
  "<message_key>": {
    "batch_id": "B",
    "operation_id": "auto:...:1",
    "content_hash": "H",
    "fields": {
      "title": "事项标题",
      "note": "说明",
      "due": null,
      "due_label": "",
      "optional": false
    }
  }
}
```

- 只保存生成后的字段和校验值，不保存消息原文、群名或附件路径。
- 写入成功后按 message_key 清理。
- 重试必须复用完全相同的 operation_id 和 fields。
- 用户手动清空重试队列时，相关消息保持 pending，下一轮重新生成。

## 7. 桌面设置界面

顶部操作区新增齿轮按钮，打开“自动读取”弹窗。

字段：

- 总开关
- 允许时间段：开始时间、结束时间
- 读取间隔：15/30/60/120 分钟，默认 60
- DeepSeek API Key：密码输入；已保存时显示“已保存”，提供“更换”和“清除”
- 每日模型调用上限：默认 14
- 开机自启开关
- 保存按钮

状态区：

- 下次预计运行时间
- 上次运行时间与结果
- 今日模型调用次数 / 上限
- 最近错误（脱敏）
- “立即读取一次”按钮

行为：

- 首次开启总开关时显示一次隐私提示：消息正文和已准备图片会发送给 DeepSeek；用户确认后才启用。
- 首次点击“立即读取一次”也要求同一份隐私确认，避免未开启总开关就发送消息。
- 保存 API Key 不会自动启用自动读取。
- 修改时间窗或间隔后，重新计算下次运行时间。
- 立即读取忽略总开关、时间窗和间隔，但要求已保存 API Key，并计入每日调用上限。
- 手机端只显示待办，不提供自动读取设置。

## 8. DeepSeek 调用契约

### 8.1 模型与输入

- 模型：`deepseek-flash`。
- 接口：Chat Completions。
- 输入只包含候选消息：群名、消息时间、正文、附件文件名、已准备图片的 data URL。
- 不发送数据库路径、账号 ID、其他群消息、联系人列表或完整配置。
- 单次最多 20 条消息、8 张图片；单张图片不超过 8MB，单次请求图片总量不超过 32MB。
- 图片读取失败、超过大小限制或未准备时不发送该图片，并在该消息结果中标记 pending。
- 请求设置超时（连接 10 秒、总请求 120 秒）和有限输出长度。

### 8.2 输出格式

模型只返回 JSON：

```json
{
  "todos": [
    {
      "message_keys": ["K"],
      "title": "事项标题",
      "note": "要求和已知说明",
      "due": "2026-11-19T14:00",
      "due_label": "今天下午",
      "optional": false
    }
  ],
  "results": [
    {
      "message_key": "K",
      "status": "done",
      "text_state": "analyzed",
      "attachment_state": "not_applicable",
      "reason": ""
    }
  ]
}
```

- `due` 只能是 `YYYY-MM-DD`、`YYYY-MM-DDTHH:MM` 或 `null`。
- 不确定日期必须留空，禁止编造。
- 广告、代看、招生、刷单、闲聊和纯资讯必须 `skipped` 并给出简短原因。
- 需要更多信息才能判断的消息使用 `pending`。
- 每条候选消息都必须有结果；缺失的由调度器补为 pending，原因“模型未返回结果”。

### 8.3 调度器到 write 的映射

- `operation_id` 由调度器生成：`auto:<message_key前16位>:<序号>`。
- `action` 固定为 `create`。
- `message_keys` 来自模型返回；只允许候选批次中的 key。
- `fields` 只允许 `title/note/due/due_label/optional`。
- `content_hash` 由 read 结果填充，不使用模型提供的值。
- 结果状态只允许 `done/skipped/pending`；阶段状态只允许文档约定的枚举。
- 若某条消息有 todo 但结果不是 done，该 todo 被拒绝，消息改为 pending。

生成的操作在调用 `write` 前先写入 `state/automation-pending.json`，内容只包括 operation_id、字段、content_hash 和 batch_id，不保存消息原文。写入成功后清理对应条目；写入失败或进程中断时，下一轮复用完全相同的 operation_id 和字段，避免因同 ID 参数变化被拒绝。用户手动修改过的待办由 `write` 的 create 语义保护，不被重试覆盖。

### 8.4 校验与修复

1. 去除 Markdown 代码围栏后解析 JSON。
2. 校验字段、消息 key、状态和日期格式。
3. 校验失败时，把错误摘要和原输出发回模型修复一次。
4. 第二次仍失败：本轮不写待办，记录错误，消息保持 pending，下一轮重试。
5. 不把模型输出直接写入数据库。

## 9. 成本控制

- 本地 `read`：0 模型 token。
- 只有候选消息大于 0 时才调用 DeepSeek。
- 单次模型请求最多 20 条消息、8 张图片。
- 每日模型调用上限默认 14 次；达到后当天只读取，不调用模型。
- 根据 2026-11-19 的实际批次估算：13 条消息约 2.06 万字节，正文和 JSON 约 5.3k–7k tokens；1 张 1072×1078 图片按 DeepSeek 当前图片计费上限约 384 输入 tokens；加上模型推理和输出，单次约 1 万 tokens。
- 默认时间窗 08:00–22:00、间隔 60 分钟，每天最多 14 次检查；只有新消息才调用模型。极端情况下每天最多约 14 万 tokens，普通使用远低于此。
- 设置页显示“今日模型调用次数”，便于用户自行控制。

## 10. 错误处理

| 情况 | 行为 |
| --- | --- |
| 未配置 API Key | 本地读取继续，跳过模型，状态提示“未配置 API Key” |
| API Key 无效/401 | 暂停模型调用，提示更换 Key；本地读取继续 |
| 网络超时/5xx | 本轮重试一次（5 秒、15 秒退避），仍失败则下一轮 |
| 429 限流 | 读取 Retry-After，若超过本轮时间则下一轮 |
| 模型输出非法 JSON | 修复一次；仍失败则保留 pending |
| write 部分失败 | 记录失败操作，消息保持 pending，下一轮用同一 operation_id 重试 |
| read 失败 | 不调用模型，记录脱敏错误，下一轮重试 |
| 锁被占用 | 本轮跳过；不强制删除锁 |
| 每日模型上限达到 | 只读取，不调用模型，状态区提示 |
| 注册表写入失败 | 开机自启保持关闭并提示，不影响自动读取 |

所有错误日志不包含消息正文或 API Key；只记录错误代码、HTTP 状态和简短原因。

## 11. 开机自启

- 使用 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。
- 值名：`ChatNotice`。
- 值：`"<项目>\.venv\Scripts\pythonw.exe" -B -X utf8 "<项目>\desktop_app.py"`。
- 保存设置时根据开关添加或删除。
- 应用启动时若开关开启，检查并修复路径；若开关关闭，不创建。
- 不写入系统级注册表，不需要管理员权限。
- 清理工具可识别并移除该启动项，但不删除用户待办或配置。

## 12. HTTP 接口

沿用现有 `/api` 访问控制：本机信任，局域网请求需要 `X-Api-Token`。自动读取相关接口额外要求：

- 仅接受本机客户端，局域网 token 不能修改设置或触发手动运行；
- 状态变更请求校验 `Origin` 为同源或缺失，阻止任意网页通过本机地址触发付费模型调用；
- CORS 不为自动读取接口放宽到任意来源。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/automation` | 返回配置（不含 Key）、`api_key_set`、今日调用次数、下次运行时间、最近结果 |
| PUT | `/api/automation` | 保存配置；可选 `api_key`、`clear_api_key`、`confirmed` |
| POST | `/api/automation/run` | 立即读取一次；返回本轮结果或“已有读取在进行” |

PUT 校验失败返回 400；Key 缺失或无效不影响其他字段保存。响应永远不包含 API Key 原文。

## 13. 测试

合成测试，不读取真实聊天库，不调用真实 DeepSeek：

- 时间窗：普通时间段、跨午夜、开始等于结束、边界秒。
- 间隔：首次进入时间窗、上次失败、手动读取、重启后恢复。
- 每日上限：跨午夜重置、达到上限后只读取。
- 候选筛选：新消息、内容变化、旧 pending 有 task、旧 pending 无 task、纯图片未准备。
- 模型响应：合法 JSON、代码围栏、缺字段、非法日期、未知消息 key、部分结果缺失。
- write 映射：operation_id 稳定性、失败重试、部分失败。
- 密钥：Windows DPAPI 保存/读取/清除；非 Windows 跳过。
- 开机自启：注册表读写用 mock，不修改真实系统项。
- 手动接口：本地请求成功、远程无 token 拒绝、重复运行跳过。
- 手动验收：用 1 分钟测试间隔和假模型服务，验证无新消息不调用、有新消息生成待办、关闭开关后停止。

## 14. 文档与发布

- README 增加“自动读取”入口和默认值。
- 新增 `docs/agent/automation.md`：设置、隐私、token 估算、失败处理、如何关闭。
- ARCHITECTURE 增加调度器组件和数据流。
- CHANGELOG 记录“可选自动读取”，强调默认关闭。
- SECURITY/README 更新边界说明：这是用户在明确时间窗内启用的有界周期读取，不是实时监控；只有用户确认并配置 Key 后才会把候选消息发送给 DeepSeek。
- 发布包不包含 `state/automation.json`、`state/model-secrets.dpapi` 或任何真实消息。

## 15. 风险与取舍

- 模型误判可能创建不准确待办；通过严格提示词、只发送候选消息、直接可删除和每日上限降低影响。
- 桌面端退出后不读取；用户已选择开机自启并保留托盘。
- 60 分钟间隔意味着待办最多延迟约 1 小时；用户可在设置中改为 15/30 分钟。
- DeepSeek 服务故障时只保留本地 pending，不阻塞其他功能。
- 图片识别效果取决于图片清晰度和模型能力；未准备成功的图片不会送模型，保持 pending。

## 16. 未决问题

无。实现前若 DeepSeek 模型名或图片接口变更，以官方文档为准调整 `desktop/deepseek.py` 和默认模型名。

## 参考

- [Vision | DeepSeek API Docs](https://api-docs.deepseek.com/guides/vision/)
- [DeepSeek V4.1 Flash Review](https://www.glbgpt.com/hub/deepseek-v4-1-flash-review/)
- [DeepSeek V4.1 Flash Vision API 指南](https://apifox.com/apiskills/deepseek-v4-1-flash-vision-api-cn/)
