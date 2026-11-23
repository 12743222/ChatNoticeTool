# ChatNotice AI 配置指南

本文件用于把 ChatNotice 的首次群聊配置交给**本地 AI 助手**完成。AI 必须能访问本机文件并执行命令；只能阅读本指南和 `docs/agent/` 下的文档，不得凭猜测修改配置。

> 软件内已经提供“设置 → 群聊与同步 → 识别群聊”向导，普通人优先使用向导。本指南用于让 AI 代做配置，或在向导失败时排查和手工配置。向导和 AI 都只能标定群聊，不能读取联系人或私聊。

## 给用户的准备

1. 解压便携版到可写目录，例如 `D:\ChatNotice`。
2. 打开并登录自己的 QQ 或微信桌面客户端（必须是本人账号）。
3. 把下面“给 AI 的提示词”连同本文件一起交给本地 AI 助手。
4. 准备本人 DeepSeek API Key（用于自动生成待办；只需在桌面设置里填写，不要发给 AI 聊天）。

## 给 AI 的提示词（可直接复制）

```text
你是 ChatNotice 本地配置助手。工作目录是 <解压后的 ChatNotice 文件夹绝对路径>。
先完整阅读工作目录下的 AI-配置指南.md，以及 docs/agent/configuration.md 和 docs/agent/commands.md。
只使用工作目录内的 runtime\python.exe 和 agent_setup.py，禁止访问联系人、私聊或与本任务无关的文件。

硬性规则：
1. 联系人、私聊、好友列表不在支持范围内，不得尝试读取或配置，只能标定群聊。
2. 任何来源路径、客户端 PID、要启用的群，都必须先向我展示并取得明确确认；未确认不得写配置。
3. 执行 source connect 的内存读取授权前，必须单独征得我的同意；不得自动重试或扩大范围。
4. 不把 state 目录、令牌、API Key、聊天正文、完整群列表输出到聊天窗口；只展示必要的路径、群名和群号。
5. 每次写配置前重新运行 inspect，使用最新的 expected_revision；配置冲突时先重新读取再展示变更。
6. 完成后只做摘要汇报，并告诉我如何在桌面设置里启用自动读取和填写 DeepSeek Key。

现在开始：先检查 runtime\python.exe 和 agent_setup.py 是否存在，运行 inspect，然后一步一步询问我完成来源和群聊标定。
```

## AI 执行步骤

以下命令均在 ChatNotice 根目录执行。便携版 Python 是 `runtime\python.exe`；源码版替换为 `.venv\Scripts\python.exe`。

### 1. 检查环境与配置版本

```powershell
.\runtime\python.exe -B -X utf8 agent_setup.py inspect
```

记录返回的 `revision`。后续所有写入都要使用最新值。

### 2. 确认聊天数据目录

先尝试有界探测：

```powershell
.\runtime\python.exe -B -X utf8 agent_setup.py source candidates --platform qq
.\runtime\python.exe -B -X utf8 agent_setup.py source candidates --platform wechat
```

把候选路径展示给用户确认，不要自动选择。也可以让用户手动提供：

- QQ：`database_dir` 指向 `...\nt_qq\nt_db`，`media_dir` 指向 `...\nt_qq\nt_data`。
- 微信：`database_dir` 指向 `...\db_storage`，`account_dir` 指向该账号根目录。

### 3. 写入来源配置

先写好 UTF-8 的 `source.json`（不要带 BOM），再执行。QQ 示例：

```json
{
  "expected_revision": 0,
  "confirmed": true,
  "platform": "qq",
  "name": "我的QQ",
  "paths": {
    "database_dir": "C:/Users/用户/Documents/Tencent Files/QQ号/nt_qq/nt_db",
    "media_dir": "C:/Users/用户/Documents/Tencent Files/QQ号/nt_qq/nt_data"
  }
}
```

```powershell
.\runtime\python.exe -B -X utf8 agent_setup.py source configure --input source.json
```

微信把 `platform` 改为 `wechat`，`paths` 使用 `database_dir` 和 `account_dir`。

### 4. 检查凭据；需要时由用户授权取钥

```powershell
.\runtime\python.exe -B -X utf8 agent_setup.py source check --source <SOURCE_ID>
```

如果提示凭据缺失：

1. 让用户打开并登录对应客户端。
2. 让用户从任务管理器“详细信息”中找到 QQ/微信主进程 PID（`QQ.exe` / `WeChat.exe` / `Weixin.exe`）。
3. **单独向用户确认**后执行：

```powershell
.\runtime\python.exe -B -X utf8 agent_setup.py source connect --source <SOURCE_ID> --pid <PID> --authorize-memory-read
```

这是一次性授权，只为读取本人客户端解密所需凭据；不会持续监控。不要循环扫描进程，不要尝试其他账号。

### 5. 查询群号并让用户选择

```powershell
.\runtime\python.exe -B -X utf8 agent_setup.py groups list --source <SOURCE_ID> --contains <关键词>
```

把候选群名和群号展示给用户，逐项确认要标定哪些群。不要把全部群默认加入。

### 6. 预览并应用群配置

先运行 `inspect` 获取最新 `revision`，写 `groups.json`：

```json
{
  "expected_revision": <最新revision>,
  "confirmed": true,
  "groups": [
    {
      "source_id": "<SOURCE_ID>",
      "group_id": "<群号>",
      "name": "<群名>",
      "enabled": true
    }
  ]
}
```

把变更列表（新增/启停）展示给用户后执行：

```powershell
.\runtime\python.exe -B -X utf8 agent_setup.py groups apply --input groups.json
```

如果返回 `config_conflict`：重新运行 `inspect`，用新 revision 重新生成并再次展示确认，不要盲目重试。

### 7. 完成后的交接

1. 再次运行 `inspect`，确认来源已保存、群数量正确。
2. 提醒用户：桌面端设置 → AI 进阶设置填写自己的 DeepSeek API Key。
3. 提醒用户：设置里开启“隐私确认”和“自动读取”，再设置时间段与间隔。
4. 说明限制：只处理已标定的启用群；联系人和私聊不支持；QQ 纯图片消息可能保持 pending。

## 常见错误

| 返回 | 处理 |
| --- | --- |
| `config_conflict` | 重新 inspect，使用最新 revision，重新展示变更 |
| `credentials_unavailable` | 确认客户端已登录，按第 4 步由用户授权取钥 |
| `scope_denied` | 群未启用或来源未授权；不要扩大范围，先核对配置 |
| `groups_required` | 先确认并标定至少一个群 |
| `Source ... not found` | source_id 写错；重新运行 inspect 获取准确 ID |

## 隐私边界

- 只读取用户明确标定并启用的群。
- 不读取联系人列表、私聊、朋友圈或其他会话。
- 不修改客户端数据库，不自动发送消息。
- `state/` 内保存待办、令牌和 DPAPI 密钥；AI 不应把它上传、打包或展示。
- 自动读取只把候选消息正文发送给用户自己配置的 DeepSeek；是否启用由用户在桌面设置中决定。