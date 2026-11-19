# 从 Windows 桥接 Ubuntu 上的 Strata 模型

Ubuntu 负责加载模型和推理。Windows 上的 Strata 桌面 Host 通过 SSH 本地端口转发访问 Ubuntu 的 Strata API。换另一台 Ubuntu 时，只需按新机器的 SSH 地址、Strata 监听端口、调用密钥和模型 ID 配置上游。Windows 本地服务和桌面 Host 的入口可以继续使用。

## 当前配置

| 入口或配置 | 当前值 | 用途 |
| --- | --- | --- |
| Windows 本地 Strata 服务 | `http://127.0.0.1:18907` | 本地服务页面和 API。配对方式下由它验证本地调用密钥、执行限额并记录用量 |
| Windows 桌面 Host | `http://127.0.0.1:47831` | 提供桌面界面，保存桥接设置并代理请求 |
| Windows SSH 转发入口 | `http://127.0.0.1:18081/v1` | 桌面「桥接模式」中填写的服务地址 |
| Ubuntu SSH 转发目标 | `127.0.0.1:18098` | 从 Ubuntu 一侧访问的 Strata 服务端口。Docker 部署时填 Ubuntu 发布的宿主机端口 |
| 已选的上游模型 ID | `qwen3.8-flash-next-unsloth-q8_0` | 当前桌面保存的模型，换机后以目标服务返回的 ID 为准 |

桌面内聊天和助手直接走桌面 Host。已配对的 `18907` 服务先验证本地调用密钥，再把模型请求交给 `47831`。配对由本地服务配置中的 `desktop_bridge_port` 指向桌面 Host，该设置要求本地服务启用 API 密钥认证。API Key 管理使用本地管理员密钥。

桌面 Host 用桥接设置中保存的 **Ubuntu 调用密钥** 请求上游 `GET /v1/models`。启用桥接后，它把推理请求的 `model` 设为所选上游模型，转发 Chat Completions、Responses、Messages 和 Messages 的 token 计数请求。生成结果沿原路径返回，流式生成以 SSE 返回。桥接启用时，桌面跳过本地模型加载。上游请求失败时会返回错误。配对的本地服务在桥接关闭或桌面 Host 未运行且连接被拒绝时，会走原来的本地路由。

桌面 Monitor 经同一条隧道读取 Ubuntu 的 Strata 监控数据。配对服务的 API Key 页面记录的是 Windows 本地密钥的调用和用量。两处记录的范围可能不同。

## 在另一台 Ubuntu 上复测

1. **在 Ubuntu 启动或确认 Strata 服务。** 已有服务可直接使用实际监听端口和该实例的调用密钥。需要新启动时，按 [Terminal 启动指南](TERMINAL_LAUNCH.md) 选择适合这台机器的模型。下面演示使用已有模型文件和端口 `18098`，先把 `UBUNTU_STRATA_KEY` 设置为此实例要使用的密钥，并替换模型路径。

   ```bash
   strata launch --model-path /path/to/model --access local --port 18098 --api-key-env UBUNTU_STRATA_KEY --yes --no-tui
   curl -fsS http://127.0.0.1:18098/health
   curl -fsS -H "Authorization: Bearer $UBUNTU_STRATA_KEY" http://127.0.0.1:18098/v1/models
   ```

   现有服务可只执行两条 `curl`，先把变量设为已有的调用密钥。确认 `/health` 成功，并记下 `/v1/models` 返回的目标模型 `data[].id`。Docker 可参考 [Docker 部署指南](DOCKER.md#use-the-model-from-another-strata-desktop)，将容器 API 发布到 Ubuntu 的回环地址。

2. **在 Windows 新开一个 PowerShell 窗口建立 SSH 隧道。** 替换 `ubuntu-user@new-ubuntu-host` 和最后的 `18098`。下面用 `18082` 与当前隧道并行，保留这个窗口运行。

   ```powershell
   ssh -NT -o ExitOnForwardFailure=yes -L 127.0.0.1:18082:127.0.0.1:18098 ubuntu-user@new-ubuntu-host
   ```

   在另一个 Windows 窗口运行 `curl.exe -fsS http://127.0.0.1:18082/health`。SSH 成功监听本地端口只说明转发入口已建立，`/health` 才会实际访问 Ubuntu 的目标端口。

3. **在桌面切换桥接。** 等当前请求和任务结束。若桌面 Host 开启了局域网共享或公网隧道，先关闭。打开「桥接模式」，输入 `http://127.0.0.1:18082/v1` 和新 Ubuntu 的调用密钥。点击「测试连接」，选择第 1 步确认的模型，再点击「启用桥接」。测试连接通过表示模型列表可读。换地址时要填写目标实例的密钥。HTTP 桥接地址仅支持回环地址，直连远端地址需要 HTTPS。

4. **发送生成请求确认推理。** 在桌面聊天发送一条短消息，确认有完整回复，再查看桌面 Monitor 中的 Ubuntu 请求记录。如果日常调用走配对的 `18907`，也用 **Windows 本地调用密钥** 在该入口调用一次。下面是 PowerShell 7 的非流式验证示例。

   ```powershell
   $localKey = Read-Host 'Windows Strata 调用密钥' -MaskInput
   $headers = @{ Authorization = "Bearer $localKey" }
   $base = 'http://127.0.0.1:18907/v1'
   $models = Invoke-RestMethod "$base/models" -Headers $headers
   $models.data | Select-Object id
   $modelId = Read-Host '输入上面返回的目标模型 ID'
   $body = @{
       model = $modelId
       messages = @(@{ role = 'user'; content = 'Reply with one short sentence.' })
       max_tokens = 64
       stream = $false
   } | ConvertTo-Json -Depth 4
   $response = Invoke-RestMethod "$base/chat/completions" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
   $response | Select-Object model, usage
   $response.choices[0].message
   ```

   核对模型 ID、生成结果，以及该条请求对应的本地 API Key 用量或 Ubuntu 请求记录。若 `18907` 返回的是 Windows 本地模型，检查 `desktop_bridge_port` 是否指向正在运行、且已启用桥接的桌面 Host。只使用桌面聊天时可以跳过 `18907` 的验证。

## 排查顺序

| 现象 | 检查 |
| --- | --- |
| Ubuntu 本机 `/health` 失败 | 检查 Strata 是否已启动、监听端口是否正确。Docker 部署时检查宿主机端口是否已经发布 |
| Ubuntu `/health` 成功，Windows 隧道的 `/health` 失败 | 检查 `ssh -L` 的远端地址和端口，以及 SSH 窗口中是否有转发错误 |
| `/health` 成功，测试连接时报 `401` 或 `403` | 检查桥接对话框中的 Ubuntu 调用密钥和它的 API 权限 |
| 模型列表可读，生成失败 | 检查所选模型是否能在 Ubuntu 上生成，以及 Ubuntu 服务对应的请求日志 |
| 能生成，Monitor 无数据 | 检查上游 Strata 的监控接口。桌面 Host 先读 `/metrics?requests=all`，收到 `401` 或 `403` 时再试 `/api/monitor/metrics?requests=all` |

2026-11-19 在当前 Windows 环境核对了活动 SSH 转发和桌面保存的模型。`18907/health` 和 `47831/api/bridge` 均返回 HTTP 200，桥接状态显示 `connected`。同次检查中，隧道入口 `18081` 的 `/health` 和鉴权后的 `/v1/models` 均被重置。这次未验证真实模型生成，也未确认重置发生在 Ubuntu 的哪一层。复测应以经隧道的实时探测和实际生成结果为准。
