# 多数据库架构说明（MariaDB部署）

## 概述

本项目采用多 MariaDB 数据库架构，以提高并发性能、减少锁冲突，并实现更好的数据分离。

在单容器部署（All-in-One）中，所有数据库都运行在独立的MariaDB容器中，通过网络连接进行访问。

## 数据库分布

### 1. 主数据库 (`photonix_main`)
- **用途**: 存储图片和视频的索引信息
- **表结构**:
  - `items`: 媒体文件索引
  - `album_covers`: 相册封面缓存（路径/尺寸/mtime）
  - `thumb_status`: 缩略图状态跟踪（exists/pending/failed/last_checked）
  - `processed_videos`: 已处理视频记录
  - `migrations`: 数据库迁移记录

### 2. 设置数据库 (`photonix_settings`)
- **用途**: 存储应用配置设置
- **表结构**:
  - `settings`: 键值对配置存储
  - `migrations`: 数据库迁移记录

### 3. 历史记录数据库 (`photonix_history`)
- **用途**: 存储用户浏览历史
- **表结构**:
  - `view_history`: 用户查看历史记录
  - `migrations`: 数据库迁移记录

### 4. 索引数据库 (`photonix_index`)
- **用途**: 存储索引处理状态和队列
- **表结构**:
  - `index_status`: 索引处理状态
  - `index_queue`: 索引处理队列
  - `migrations`: 数据库迁移记录

## 架构优势

### 1. 并发性能提升
- 不同功能模块使用独立数据库，避免锁冲突
- 设置更新不再阻塞索引重建
- 历史记录更新不影响搜索功能

### 2. 数据隔离
- 配置数据与业务数据分离
- 历史记录独立存储，便于清理和维护
- 索引状态独立管理

### 3. 扩展性
- 每个数据库可以独立优化
- 便于未来功能扩展
- 支持分布式部署和读写分离

### 4. 维护性
- 数据库规模更小，备份更快
- 问题定位更精确
- 数据迁移更灵活

## 技术实现

### 连接池管理
- 使用 `multi-db.js` 统一管理所有数据库连接池
- 每个数据库维护独立的连接池（10个连接）
- 支持连接健康检查和自动重连

### 启动流程（见 `backend/server.js`）：
1) MariaDB容器启动和健康检查
2) `initializeConnections()` 建立四库连接池
3) `initializeAllDBs()` 执行数据库迁移
4) `ensureCoreTables()` 兜底创建关键表
5) 启动Workers、搭建监听与索引/缩略图处理

### 迁移系统
- 每个数据库独立的迁移记录
- 支持版本控制和增量迁移
- 自动执行未完成的迁移
- 表结构使用MariaDB标准SQL语法

### Worker架构
- 每个Worker使用对应的数据库
- 避免跨数据库事务
- 提高并发处理能力

## MariaDB配置

### 连接配置
```javascript
const poolConfig = {
    host: MARIADB_HOST,
    port: MARIADB_PORT,
    user: MARIADB_USER,
    password: MARIADB_PASSWORD,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    acquireTimeout: 60000,
    timeout: 60000,
    charset: 'utf8mb4'
};
```

### 数据库特性
- **字符集**: utf8mb4_unicode_ci（完整Unicode支持）
- **存储引擎**: InnoDB（支持事务和外键）
- **全文搜索**: FULLTEXT索引支持内容搜索
- **连接池**: 每数据库10个连接，支持并发访问

## 环境变量

### MariaDB连接配置
```bash
# MariaDB服务器配置
MARIADB_HOST=mariadb          # Docker Compose内使用服务名
MARIADB_PORT=3306
MARIADB_USER=photonix
MARIADB_PASSWORD=photonix123456
MARIADB_ROOT_PASSWORD=photonix123456

# 查询超时配置
MARIADB_QUERY_TIMEOUT=30000

# 连接健康检查
DB_HEALTH_CHECK_INTERVAL=60000
DB_RECONNECT_ATTEMPTS=3
```

## 性能优化

### 1. 索引策略
- 主键：AUTO_INCREMENT BIGINT
- 路径字段：VARCHAR(1000) + 索引
- 全文搜索：FULLTEXT索引
- 复合索引：根据查询模式优化

### 2. 连接池优化
- 连接复用减少连接开销
- 超时配置防止连接泄漏
- 健康检查确保连接可用

### 3. 查询优化
- 预编译语句防止SQL注入
- 批量操作减少网络开销
- 事务管理确保数据一致性

## 监控和维护

### 连接状态监控
- 定期健康检查（每分钟）
- 自动重连机制（最多3次）
- 连接池状态日志

### 性能监控
- 查询执行时间跟踪
- 连接池使用率监控
- 死锁和超时检测

### 备份策略
- 每个数据库独立备份
- 支持在线备份（mariadb-dump）
- 可结合外部备份系统

## 故障处理

### 常见问题
1. **连接超时**: 检查网络连通性和MariaDB服务状态
2. **权限问题**: 确认用户权限和数据库访问权限
3. **锁等待**: 优化查询和事务设计

### 恢复步骤
1. 停止应用服务
2. 检查MariaDB服务状态
3. 修复网络或权限问题
4. 重启服务并验证连接

## 未来规划

### 短期优化
- 实现读写分离
- 添加连接池监控
- 优化查询性能

### 长期规划
- 支持多主复制
- 实现分布式数据库架构
- 添加数据加密和压缩

## 注意事项

1. **首次启动**: MariaDB容器需要时间初始化，注意健康检查配置
2. **备份**: 建议定期备份所有数据库
3. **权限**: 确保应用对MariaDB有适当的访问权限
4. **资源**: MariaDB相比单文件数据库需要更多的内存和CPU资源
5. **网络**: 确保应用容器能够访问MariaDB容器