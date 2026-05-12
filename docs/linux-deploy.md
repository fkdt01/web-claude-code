# Linux 后端部署

后端按 Linux 环境优先设计：所有配置走环境变量，服务监听 `0.0.0.0:${PORT}`，默认端口为 `8787`。

## Docker 方式

在仓库根目录执行：

```bash
docker build -f apps/server/Dockerfile -t web-claude-code-server .
docker run --rm -p 8787:8787 --env-file .env web-claude-code-server
```

最小 `.env`：

```bash
PORT=8787
WEB_ORIGIN=http://localhost:5173
```

没有模型密钥时，服务仍会启用 mock provider，方便先验证 UI 和编排流程。

## systemd 方式

建议把代码放在 `/opt/web-claude-code`，配置放在 `/etc/web-claude-code/server.env`。

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin webcode
sudo mkdir -p /opt/web-claude-code /etc/web-claude-code
sudo cp deploy/linux-systemd/web-claude-code.service /etc/systemd/system/web-claude-code.service
sudo systemctl daemon-reload
sudo systemctl enable --now web-claude-code
```

`/etc/web-claude-code/server.env` 示例：

```bash
PORT=8787
HOST=0.0.0.0
WEB_ORIGIN=https://your-web-domain.example
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
GEMINI_API_KEY=
```

## 生产建议

- 用 Nginx/Caddy 做 TLS、反向代理和请求体限制。
- 后端服务账号不要拥有宿主机敏感目录权限。
- 后续启用真实 shell 工具时，把每个工作区放进独立容器或 microVM。
- 密钥不要写入仓库；生产环境接 Vault、KMS 或云 Secret Manager。
- 日志需要做 secret scanning 和脱敏后再长期保存。
