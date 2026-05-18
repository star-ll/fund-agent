# 部署指南

两种方式二选一：**Docker（推荐）** 或 **PM2 手动部署**。

---

## 方式一：Docker 部署（推荐）

### 前置条件

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable docker && systemctl start docker
```

### 1. 拉取代码

```bash
git clone <your-repo> /projects/ai-fund
cd /projects/ai-fund
```

### 2. 配置环境变量

```bash
cp .env.example .env
vim .env   # 填入生产环境的真实配置
```

### 3. 启动所有服务

```bash
docker compose up -d --build
```

MySQL 和 Redis 会自动启动，`schema.sql` 会在首次启动时自动执行。

### 4. 验证

```bash
docker compose ps
curl http://localhost:3000/health
```

### 5. 配置 Nginx + SSL（让 Discord 能访问）

同方式二的第 5 步。

### 更新部署

```bash
git pull
docker compose up -d --build
```

---

## 方式二：PM2 手动部署

### 前置条件

服务器上需要安装：Node.js 20+、Python 3.11+、uv、MySQL 8+、Redis、Nginx、PM2

```bash
# Node.js（以 Ubuntu 为例）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt install -y nodejs

# uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# PM2
npm install -g pm2
```

### 1. 拉取代码

```bash
git clone <your-repo> /path
cd /path
```

### 2. 配置环境变量

```bash
cp .env.example .env
vi .env   # 填入生产环境的真实配置
```

### 3. 初始化数据库

```bash
mysql -u root -p < schema.sql
```

### 4. 安装依赖并构建

```bash
npm ci
npm run build
cd server && uv sync && cd ..
```

### 5. 配置 Nginx + SSL

写入 Nginx 配置 `/etc/nginx/sites-available/yujin123.cn`：

```nginx
server {
    listen 80;
    server_name yujin123.cn;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name yujin123.cn;

    ssl_certificate     /etc/nginx/yujin123.cn/yujin123.cn.pem;
    ssl_certificate_key /etc/nginx/yujin123.cn/yujin123.cn.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location /interactions {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 10s;
    }

    location /health {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

```bash
nginx -t && systemctl reload nginx
```

### 6. 启动服务

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # 按提示执行输出的命令，设置开机自启
```

### 7. 验证

```bash
pm2 status
curl https://yujin123.cn/health
```

### 更新部署

```bash
cd /projects/fund-agent
git pull
npm ci && npm run build
pm2 restart ai-fund-webhook

# Python 服务有改动时
cd server && uv sync && cd ..
pm2 restart ai-fund-server
```

---

## Discord 配置

### 1. 创建应用

[Discord Developer Portal](https://discord.com/developers/applications) → New Application

### 2. 获取凭据

- **General Information** → 复制 `Public Key` → 填入 `DISCORD_PUBLIC_KEY`
- **General Information** → 复制 `Application ID` → 填入 `DISCORD_APP_ID`
- **Bot** → Reset Token → 填入 `DISCORD_BOT_TOKEN`

### 3. 配置 Interactions Endpoint

**General Information** → Interactions Endpoint URL 填：

```
https://yujin123.cn/interactions
```

点 Save，Discord 会自动发 PING 验证，通过后生效。

### 4. 注册 Slash Command（一次性）

```bash
# 确保 .env 已配置 DISCORD_APP_ID 和 DISCORD_BOT_TOKEN
# 国内服务器需要设置代理
HTTPS_PROXY=http://127.0.0.1:7890 npx ts-node scripts/register-discord-commands.ts
```

### 5. 邀请 Bot 到频道

Developer Portal → OAuth2 → URL Generator → 勾选 `bot` 和 `applications.commands` → 生成链接 → 访问链接邀请到目标服务器。

使用方式：在频道输入 `/ask 帮我分析000001基金`
