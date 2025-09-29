# MariaDB 数据库部署说明

## 概要

Photonix项目使用MariaDB作为数据库后端，提供高性能的数据存储和检索服务。

### 数据库架构
项目采用4个独立数据库的架构：
- `photonix_main`: 主数据库（媒体文件索引）
- `photonix_settings`: 设置数据库
- `photonix_history`: 历史记录数据库  
- `photonix_index`: 索引状态数据库

### 技术特性
- **依赖包**: `mysql2` 连接驱动
- **全文搜索**: MariaDB FULLTEXT索引
- **连接管理**: 连接池（每数据库10个连接）
- **数据类型**: MariaDB标准SQL类型

## 部署步骤

### 步骤1: 更新依赖
```bash
cd backend
npm install  # 安装mysql2依赖
```

### 步骤2: 配置环境变量
复制并配置环境文件：
```bash
cp env.example .env
```

编辑 `.env` 文件，确保包含MariaDB配置：
```env
# MariaDB配置
MARIADB_HOST=mariadb
MARIADB_PORT=3306
MARIADB_USER=photonix
MARIADB_PASSWORD=photonix123456
MARIADB_ROOT_PASSWORD=photonix123456
```

### 步骤3: 启动服务
```bash
# 构建并启动所有服务（包含MariaDB）
docker compose up -d --build

# 查看服务状态
docker compose ps

# 查看日志
docker compose logs -f app
docker compose logs -f mariadb
```

## 服务端口

| 服务 | 容器端口 | 宿主机端口 | 说明 |
|------|----------|------------|------|
| app | 13001 | 12080 | 主应用服务 |
| mariadb | 3306 | 3306 | MariaDB数据库 |
| redis | 6379 | 6379 | Redis缓存 |

## 验证部署

### 1. 健康检查
访问 http://localhost:12080/health 确认服务正常

### 2. 数据库连接验证
```bash
# 连接到MariaDB检查数据库
docker exec -it Photonix-mariadb mariadb -u photonix -p

# 查看数据库
SHOW DATABASES;

# 检查表结构
USE photonix_main;
SHOW TABLES;
DESCRIBE items;
```

### 3. 功能测试
- 访问主页面确认正常加载
- 测试图片浏览功能
- 测试搜索功能（使用MariaDB FULLTEXT）
- 测试设置保存功能

## 性能优化

### 1. MariaDB配置优化
已在docker-compose.yml中配置基础优化：
- `innodb-buffer-pool-size=256M`
- `max-connections=200`
- 字符集：`utf8mb4_unicode_ci`

### 2. 索引优化
- 所有表已配置适当的索引
- items表启用FULLTEXT索引支持搜索
- 路径字段使用VARCHAR(1000)支持长路径

### 3. 连接池配置
- 每个数据库连接池：10个连接
- 查询超时：30秒
- 连接超时：60秒

## 故障排除

### 常见问题

1. **MariaDB连接失败**
   ```bash
   # 检查MariaDB容器状态
   docker compose logs mariadb
   
   # 检查网络连通性
   docker exec -it Photonix ping mariadb
   ```

2. **数据库权限问题**
   ```sql
   -- 手动授权（如需要）
   GRANT ALL PRIVILEGES ON photonix_*.* TO 'photonix'@'%';
   FLUSH PRIVILEGES;
   ```

### 日志查看
```bash
# 应用日志
docker compose logs -f app

# 数据库日志  
docker compose logs -f mariadb

# 所有服务日志
docker compose logs -f
```

## 性能特性

### MariaDB优势
| 特性 | 描述 |
|------|------|
| 并发性 | 行级锁，高并发支持 |
| 网络访问 | 原生网络协议支持 |
| 全文搜索 | FULLTEXT索引 |
| 事务隔离 | 完整ACID支持 |
| 扩展性 | 支持分库分表 |
| 备份 | 在线备份支持 |

### 预期性能
- **并发处理**: 优异的多用户并发性能
- **搜索性能**: FULLTEXT索引提供快速搜索  
- **写入性能**: 行级锁定提升写入效率
- **连接稳定性**: 连接池确保稳定性

## 后续维护

### 1. 数据备份
```bash
# 备份所有数据库
docker exec Photonix-mariadb mariadb-dump -u root -p --all-databases > backup.sql

# 恢复
docker exec -i Photonix-mariadb mariadb -u root -p < backup.sql
```

### 2. 性能监控
- 使用 `/api/metrics` 端点监控性能
- 观察数据库连接池使用情况
- 定期检查慢查询日志

### 3. 容量规划
- MariaDB数据目录：`mariadb_data` 卷
- 建议定期清理日志和临时文件
- 根据使用情况调整连接池大小

Photonix现在运行在高性能的MariaDB之上，提供卓越的性能和可扩展性！