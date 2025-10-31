# SQLite使用情况扫描报告

## 扫描时间
2025-10-27

## 扫描结果概览

### 完全迁移的文件（已使用MariaDB）
✅ **所有核心服务文件已迁移**:
- `backend/db/multi-db.js` - 使用 mysql2
- `backend/db/migrations.js` - 使用MariaDB语法
- `backend/db/database-retry.js` - MariaDB重试逻辑
- `backend/services/viewedCache.service.js` - 使用Redis和MariaDB
- `backend/services/orchestrator.js` - 纯业务逻辑
- `backend/services/queryOptimizer.service.js` - 使用MariaDB
- `backend/workers/*.js` - 所有worker文件使用MariaDB接口
- `backend/controllers/*.js` - 所有控制器使用MariaDB
- `backend/services/indexer.service.js` - 使用MariaDB
- `backend/services/thumbnail.service.js` - 使用MariaDB

### 需要保留的SQLite（功能隔离）
📁 **下载服务独立数据库**:
- `backend/services/download/HistoryTracker.js`
  - 使用: `better-sqlite3`
  - 数据库: `/app/data/downloads/downloads.db`
  - 用途: 下载历史记录、去重功能
  - 理由: 独立的辅助功能，不影响主应用

### 已删除的SQLite相关文件
🗑️ **不再需要的文件**:
- `backend/db/sqlite-retry.js` - 已替换为 `database-retry.js`
- `backend/db/migrate-to-multi-db.js` - SQLite迁移脚本
- `backend/db/database-retry.js` - 旧的SQLite重试逻辑

## 语法差异修复总结

### 1. 数据库连接
```javascript
// 旧 (SQLite)
const Database = require('better-sqlite3');
const db = new Database('path/to/file.db');

// 新 (MariaDB)
const mysql = require('mysql2/promise');
const pool = mysql.createPool({...});
```

### 2. 全文搜索
```sql
-- 旧 (SQLite FTS5)
SELECT * FROM items_fts WHERE name MATCH ?
ORDER BY rank

-- 新 (MariaDB FULLTEXT)
SELECT *, MATCH(name) AGAINST(? IN BOOLEAN MODE) as relevance 
FROM items 
WHERE MATCH(name) AGAINST(? IN BOOLEAN MODE)
ORDER BY relevance DESC
```

### 3. 字符串连接
```sql
-- 旧 (SQLite)
path LIKE i.path || '/%'

-- 新 (MariaDB)
path LIKE CONCAT(i.path, '/%')
```

### 4. 表创建
```sql
-- 旧 (SQLite)
CREATE TABLE IF NOT EXISTS table (
    id INTEGER PRIMARY KEY,
    key TEXT
);

-- 新 (MariaDB)
CREATE TABLE IF NOT EXISTS table (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    `key` VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## 依赖关系分析

### MariaDB依赖链
```
multi-db.js (mysql2)
  ├─ migrations.js
  ├─ services/*.js
  ├─ workers/*.js
  └─ controllers/*.js
```

### 独立SQLite（保留）
```
download/HistoryTracker.js (better-sqlite3)
  └─ /app/data/downloads/downloads.db
```

## 配置变更

### 环境变量
**新增MariaDB配置**:
```env
MARIADB_HOST=localhost
MARIADB_PORT=3306
MARIADB_USER=photonix
MARIADB_PASSWORD=***
DB_MAIN=photonix_main
DB_SETTINGS=photonix_settings
DB_HISTORY=photonix_history
DB_INDEX=photonix_index
```

**移除SQLite配置**:
```env
# 不再需要
DB_FILE=/path/to/gallery.db
SETTINGS_DB_FILE=...
HISTORY_DB_FILE=...
INDEX_DB_FILE=...
```

## 功能对比

| 功能 | SQLite方案 | MariaDB方案 | 状态 |
|-----|-----------|-------------|-----|
| 数据存储 | 单文件数据库 | 多数据库架构 | ✅ 已迁移 |
| 全文搜索 | FTS5虚拟表 | FULLTEXT索引 | ✅ 已迁移 |
| 事务支持 | 基本事务 | 完整ACID | ✅ 已迁移 |
| 并发性能 | 有限 | 优秀 | ✅ 已迁移 |
| 备份恢复 | 文件复制 | 标准DB工具 | ✅ 已迁移 |
| 索引优化 | 基础索引 | 高级优化 | ✅ 已迁移 |

## 性能预期

### 搜索性能
- **MariaDB FULLTEXT**: 更稳定的全文搜索性能
- **索引优化**: 更好的查询优化器
- **并发查询**: 支持更多并发搜索请求

### 数据存储
- **文件大小**: 更好的空间管理
- **备份**: 标准数据库备份工具
- **复制**: 支持主从复制（如需要）

## 完整性检查

### ✅ 已完成的迁移
- [x] 数据库连接层迁移
- [x] 所有表创建脚本迁移
- [x] 全文搜索功能迁移
- [x] Worker文件迁移
- [x] 控制器迁移
- [x] 服务层迁移
- [x] 健康检查适配
- [x] 指标统计适配

### ⚠️ 需要注意
- [ ] 确认下载服务的SQLite不影响主应用
- [ ] 验证搜索性能是否满足需求
- [ ] 检查所有FULLTEXT索引已创建

## 相关文件
- `SQLITE_TO_MARIADB_MIGRATION.md` - 详细迁移说明
- `resolve_merge_conflicts.md` - 冲突解决记录
- `backend/config/index.js` - 配置更新
- `backend/db/multi-db.js` - MariaDB连接实现

