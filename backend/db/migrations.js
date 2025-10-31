const { 
    runAsync, 
    dbAll, 
    hasColumn, 
    hasTable 
} = require('./multi-db');
const logger = require('../config/logger');

// 主数据库迁移（图片/视频索引）
const initializeMainDB = async () => {
    try {
        logger.info('[MAIN MIGRATION] 开始主数据库迁移...');
        // 创建 migrations 记录表
        logger.info('创建migrations表...');
        const createMigrationsTableSQL = `CREATE TABLE IF NOT EXISTS migrations (
            \`key\` VARCHAR(255) PRIMARY KEY, 
            applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
        
        logger.debug('migrations表SQL:', createMigrationsTableSQL);
        await runAsync('main', createMigrationsTableSQL);
        logger.info('migrations表创建成功');

        const mainMigrations = [
            {
                key: 'create_items_table',
                sql: `CREATE TABLE IF NOT EXISTS items (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(500) NOT NULL,
                    path VARCHAR(768) NOT NULL UNIQUE,
                    type VARCHAR(50) NOT NULL,
                    cover_path VARCHAR(768),
                    last_viewed_at TIMESTAMP NULL,
                    mtime BIGINT,
                    width INT,
                    height INT,
                    status VARCHAR(50) DEFAULT 'active' NOT NULL,
                    processing_state VARCHAR(50) DEFAULT 'completed' NOT NULL,
                    INDEX idx_items_type_id (type, id),
                    INDEX idx_items_mtime (mtime),
                    INDEX idx_items_filename (name),
                    INDEX idx_items_path_type (path(255), type),
                    INDEX idx_items_type_mtime (type, mtime),
                    INDEX idx_items_path (path(255)),
                    INDEX idx_items_type_path (type, path(255)),
                    INDEX idx_items_type_mtime_desc (type, mtime DESC),
                    INDEX idx_items_mtime_type (mtime DESC, type),
                    INDEX idx_items_width_height (width, height)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
            },
            {
                key: 'add_items_fulltext_index',
                check: async () => {
                    try {
                        const indexes = await dbAll('main', `
                            SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS 
                            WHERE TABLE_SCHEMA = 'photonix_main' 
                            AND TABLE_NAME = 'items' 
                            AND INDEX_NAME = 'idx_items_name_fulltext'
                        `);
                        return indexes.length === 0;
                    } catch (e) {
                        return true; // 如果检查失败，尝试创建
                    }
                },
                sql: `ALTER TABLE items ADD FULLTEXT INDEX idx_items_name_fulltext (name)`
            },
            {
                key: 'create_thumb_status_table',
                sql: `CREATE TABLE IF NOT EXISTS thumb_status (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    path VARCHAR(768) NOT NULL UNIQUE,
                    mtime BIGINT NOT NULL DEFAULT 0,
                    status VARCHAR(50) NOT NULL DEFAULT 'pending',
                    last_checked BIGINT DEFAULT 0,
                    INDEX idx_thumb_status_status (status),
                    INDEX idx_thumb_status_mtime (mtime),
                    INDEX idx_thumb_status_status_last_checked (status, last_checked),
                    INDEX idx_thumb_status_status_mtime (status, mtime DESC),
                    INDEX idx_thumb_status_path (path)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
            },
            {
                key: 'create_processed_videos_table',
                sql: `CREATE TABLE IF NOT EXISTS processed_videos (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    path VARCHAR(768) NOT NULL UNIQUE,
                    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
                check: async () => !(await hasTable('main', 'processed_videos'))
            },
            {
                key: 'create_album_covers_table',
                sql: `CREATE TABLE IF NOT EXISTS album_covers (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    album_path VARCHAR(768) NOT NULL UNIQUE,
                    cover_path VARCHAR(768) NOT NULL,
                    width INT NOT NULL,
                    height INT NOT NULL,
                    mtime BIGINT NOT NULL,
                    INDEX idx_album_covers_album_path (album_path)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
                check: async () => !(await hasTable('main', 'album_covers'))
            }
        ];

        await executeMigrations('main', mainMigrations);
        logger.info('主数据库迁移完成');
    } catch (error) {
        logger.error('主数据库迁移失败:', error.message || error.toString());
        throw error;
    }
};

// 设置数据库迁移
const initializeSettingsDB = async () => {
    try {
        logger.debug('[SETTINGS MIGRATION] 开始设置数据库迁移...');
        await runAsync('settings', `CREATE TABLE IF NOT EXISTS migrations (
            \`key\` VARCHAR(255) PRIMARY KEY, 
            applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        const settingsMigrations = [
            {
                key: 'create_settings_table',
                sql: `CREATE TABLE IF NOT EXISTS settings (
                    \`key\` VARCHAR(255) PRIMARY KEY NOT NULL, 
                    value TEXT
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
            },
            {
                key: 'initialize_default_settings',
                sql: `INSERT IGNORE INTO settings (\`key\`, value) VALUES
                    ('AI_ENABLED', 'false'),
                    ('PASSWORD_ENABLED', 'false'),
                    ('PASSWORD_HASH', ''),
                    ('ALLOW_PUBLIC_ACCESS', 'true')`
            }
        ];
        await executeMigrations('settings', settingsMigrations);
        logger.info('设置数据库迁移完成');
    } catch (error) {
        logger.error('设置数据库迁移失败:', error.message);
        throw error;
    }
};

// 历史记录数据库迁移
const initializeHistoryDB = async () => {
    try {
        logger.debug('[HISTORY MIGRATION] 开始历史记录数据库迁移...');
        await runAsync('history', `CREATE TABLE IF NOT EXISTS migrations (
            \`key\` VARCHAR(255) PRIMARY KEY, 
            applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        const historyMigrations = [
            {
                key: 'create_view_history_table',
                sql: `CREATE TABLE IF NOT EXISTS view_history (
                    user_id VARCHAR(255) NOT NULL, 
                    item_path VARCHAR(500) NOT NULL, 
                    viewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, 
                    PRIMARY KEY (user_id, item_path),
                    INDEX idx_view_history_user_id (user_id),
                    INDEX idx_view_history_viewed_at (viewed_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
            }
        ];

        await executeMigrations('history', historyMigrations);
        logger.info('历史记录数据库迁移完成');
    } catch (error) {
        logger.error('历史记录数据库迁移失败:', error.message);
        throw error;
    }
};

// 索引数据库迁移
const initializeIndexDB = async () => {
    try {
        logger.debug('[INDEX MIGRATION] 开始索引数据库迁移...');
        await runAsync('index', `CREATE TABLE IF NOT EXISTS migrations (
            \`key\` VARCHAR(255) PRIMARY KEY, 
            applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        const indexMigrations = [
            {
                key: 'create_index_status_table',
                sql: `CREATE TABLE IF NOT EXISTS index_status (
                    id INT AUTO_INCREMENT PRIMARY KEY, 
                    status VARCHAR(50) NOT NULL, 
                    progress DECIMAL(5,2) DEFAULT 0, 
                    total_files INT DEFAULT 0, 
                    processed_files INT DEFAULT 0, 
                    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
            },
            {
                key: 'create_index_progress_table',
                sql: `CREATE TABLE IF NOT EXISTS index_progress (
                    \`key\` VARCHAR(255) PRIMARY KEY,
                    value TEXT
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
            },
            {
                key: 'create_index_queue_table',
                sql: `CREATE TABLE IF NOT EXISTS index_queue (
                    id INT AUTO_INCREMENT PRIMARY KEY, 
                    file_path VARCHAR(768) NOT NULL UNIQUE, 
                    priority INT DEFAULT 0, 
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, 
                    processed_at TIMESTAMP NULL,
                    INDEX idx_index_queue_priority (priority DESC, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
            }
        ];

        await executeMigrations('index', indexMigrations);
        logger.info('索引数据库迁移完成');
    } catch (error) {
        logger.error('索引数据库迁移失败:', error.message);
        throw error;
    }
};

// 执行迁移的通用函数
const executeMigrations = async (dbType, migrations) => {
    const dbTypeUpper = dbType.toUpperCase();
    const migrationsToRun = [];

    // 先检查哪些迁移需要执行
    for (const migration of migrations) {
        const done = await dbAll(dbType, "SELECT 1 FROM migrations WHERE `key` = ?", [migration.key]);
        const needRun = migration.check ? await migration.check() : true;

        if (!done.length && needRun) {
            migrationsToRun.push(migration.key);
        }
    }

    // 如果有迁移需要执行，记录开始信息
    if (migrationsToRun.length > 0) {
        logger.debug(`[${dbTypeUpper} MIGRATION] 开始执行 ${migrationsToRun.length} 个迁移步骤: ${migrationsToRun.join(', ')}`);

        // 执行所有需要的迁移
        for (const migration of migrations) {
            if (migrationsToRun.includes(migration.key)) {
                try {
                    await runAsync(dbType, migration.sql);
                    await runAsync(dbType, "INSERT INTO migrations (`key`, applied_at) VALUES (?, NOW())", [migration.key]);
                } catch (error) {
                    logger.error(`[${dbTypeUpper} MIGRATION] 迁移失败: ${migration.key} - ${error.message}`);
                    throw error;
                }
            }
        }

        logger.debug(`[${dbTypeUpper} MIGRATION] 所有迁移步骤执行完成`);
    } else {
        logger.debug(`[${dbTypeUpper} MIGRATION] 无需执行新的迁移步骤`);
    }
};

// 初始化所有数据库
const initializeAllDBs = async () => {
    try {
        logger.debug('开始初始化所有数据库...');
        // 顺序初始化以避免原生库在高并发下的潜在竞态
        await initializeMainDB();
        await initializeSettingsDB();
        await initializeHistoryDB();
        await initializeIndexDB();
        logger.info('所有数据库初始化完成');
    } catch (error) {
        logger.error('数据库初始化失败:', error.message || error.toString());
        throw error;
    }
};

module.exports = {
    initializeAllDBs,
    initializeMainDB,
    initializeSettingsDB,
    initializeHistoryDB,
    initializeIndexDB,
    // 额外导出：核心表兜底确保（可在服务启动序列中调用，幂等）
    ensureCoreTables: async () => {
        try {
            // 主表兜底创建（幂等）
            await runAsync('main', `CREATE TABLE IF NOT EXISTS items (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(500) NOT NULL,
                path VARCHAR(768) NOT NULL UNIQUE,
                type VARCHAR(50) NOT NULL,
                cover_path VARCHAR(768),
                last_viewed_at TIMESTAMP NULL,
                mtime BIGINT,
                width INT,
                height INT,
                status VARCHAR(50) DEFAULT 'active' NOT NULL,
                processing_state VARCHAR(50) DEFAULT 'completed' NOT NULL,
                FULLTEXT idx_items_name_fulltext (name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
            
            await runAsync('main', `CREATE TABLE IF NOT EXISTS album_covers (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                album_path VARCHAR(768) NOT NULL UNIQUE,
                cover_path VARCHAR(768) NOT NULL,
                width INT NOT NULL,
                height INT NOT NULL,
                mtime BIGINT NOT NULL,
                INDEX idx_album_covers_album_path (album_path)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        } catch (e) {
            logger.warn('[MIGRATIONS] ensureCoreTables 兜底创建失败（可忽略，迁移已处理）：', e && e.message);
        }
    }
};