# Cloud MySQL + API 部署清单

在**云服务器本机**完成（推荐 API 与 MySQL 同机；MySQL 勿对公网开放）。

## 1. 安装 MySQL 8（Ubuntu/Debian）

```bash
sudo apt update
sudo apt install -y mysql-server
sudo systemctl enable --now mysql
```

## 2. 建库与专用用户

```bash
sudo mysql
```

```sql
CREATE DATABASE bili_pet CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'bili_pet'@'localhost' IDENTIFIED BY '换成强密码';
GRANT ALL PRIVILEGES ON bili_pet.* TO 'bili_pet'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

确认仅本机可连：

```bash
# my.cnf / mysqld.cnf 中应有：
# bind-address = 127.0.0.1
sudo mysql -u bili_pet -p bili_pet
```

导入表结构（在仓库 `cloud-api` 目录）：

```bash
mysql -u bili_pet -p bili_pet < sql/schema.sql
```

## 3. 部署 API

```bash
cd cloud-api
cp .env.example .env
# 编辑 MYSQL_*、JWT_SECRET、PORT
npm install
npm start
# 或: npx pm2 start src/index.js --name bili-pet-api
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

## 4. HTTPS 反代（Nginx 示例）

公网只暴露 443，反代到 `127.0.0.1:8787`。桌面端 `.env` 设置：

```text
CLOUD_API_BASE=https://your-domain.example
```

## 5. 安全要点

- MySQL 只监听 `127.0.0.1`
- `JWT_SECRET` 使用长随机串
- 不要把 `SESSDATA` 打进日志
- 防火墙仅开放 80/443（及 SSH）
