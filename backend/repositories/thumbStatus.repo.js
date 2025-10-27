/**
 * repositories/thumbStatus.repo.js
 * ThumbStatus表数据访问层
 * 职责：封装thumb_status表的所有数据库操作
 */
const { dbGet, dbAll, dbRun, runPreparedBatch } = require('../db/multi-db');
const { runPreparedBatchWithRetry, writeThumbStatusWithRetry } = require('../db/sqlite-retry');
const logger = require('../config/logger');

const UPSERT_SQL = `INSERT INTO thumb_status(path, mtime, status, last_checked)
                    VALUES(?, ?, ?, strftime('%s','now')*1000)
                    ON CONFLICT(path) DO UPDATE SET
                      mtime=excluded.mtime,
                      status=excluded.status,
                      last_checked=excluded.last_checked`;

class ThumbStatusRepository {
    /**
     * 通过path获取缩略图状态
     * @param {string} path - 文件路径
     * @returns {Promise<Object|null>}
     */
    async getByPath(path) {
        try {
            const row = await dbGet('main', 'SELECT * FROM thumb_status WHERE path = ?', [String(path || '')]);
            return row || null;
        } catch (error) {
            logger.warn(`[ThumbStatusRepo] 获取thumb_status失败 (path=${path}):`, error.message);
            return null;
        }
    }

    /**
     * 批量获取缩略图状态
     * @param {Array<string>} paths - 文件路径数组
     * @returns {Promise<Array>}
     */
    async getByPaths(paths) {
        if (!Array.isArray(paths) || paths.length === 0) return [];
        
        try {
            const placeholders = paths.map(() => '?').join(',');
            const rows = await dbAll('main', `SELECT * FROM thumb_status WHERE path IN (${placeholders})`, paths);
            return rows || [];
        } catch (error) {
            logger.warn(`[ThumbStatusRepo] 批量获取thumb_status失败:`, error.message);
            return [];
        }
    }

    /**
     * 获取指定状态的缩略图记录
     * @param {string|Array<string>} status - 状态或状态数组
     * @param {number} limit - 限制数量
     * @returns {Promise<Array>}
     */
    async getByStatus(status, limit = null) {
        try {
            let sql, params;
            
            if (Array.isArray(status)) {
                const placeholders = status.map(() => '?').join(',');
                sql = `SELECT * FROM thumb_status WHERE status IN (${placeholders})`;
                params = status;
            } else {
                sql = 'SELECT * FROM thumb_status WHERE status = ?';
                params = [status];
            }

            if (limit) {
                sql += ' ORDER BY last_checked ASC LIMIT ?';
                params.push(limit);
            }

            const rows = await dbAll('main', sql, params);
            return rows || [];
        } catch (error) {
            logger.warn(`[ThumbStatusRepo] 获取thumb_status失败 (status=${status}):`, error.message);
            return [];
        }
    }

    /**
     * 批量upsert缩略图状态
     * @param {Array<[string, number, string]>} rows - [path, mtime, status]
     * @param {Object} options - 选项
     * @param {boolean} options.manageTransaction - 是否管理事务
     * @param {number} options.chunkSize - 分块大小
     * @param {Object} redis - Redis实例
     * @returns {Promise<void>}
     */
    async upsertBatch(rows, options = {}, redis = null) {
        if (!Array.isArray(rows) || rows.length === 0) return;
        
        const opts = {
            manageTransaction: Boolean(options.manageTransaction),
            chunkSize: Math.max(1, Number(options.chunkSize || 400)),
        };

        try {
            await runPreparedBatchWithRetry(runPreparedBatch, 'main', UPSERT_SQL, rows, opts, redis);
            logger.debug(`[ThumbStatusRepo] 批量upsert完成: ${rows.length}条`);
        } catch (error) {
            logger.error(`[ThumbStatusRepo] 批量upsert失败:`, error.message);
            throw error;
        }
    }

    /**
     * 单条upsert缩略图状态（用于批量失败时的回退）
     * @param {string} path - 文件路径
     * @param {number} mtime - 修改时间
     * @param {string} status - 状态
     * @param {Object} redis - Redis实例
     * @returns {Promise<void>}
     */
    async upsertSingle(path, mtime, status, redis = null) {
        try {
            await writeThumbStatusWithRetry(dbRun, {
                path: String(path || '').trim(),
                mtime: Number(mtime) || Date.now(),
                status: String(status || 'pending'),
            }, redis);
        } catch (error) {
            logger.warn(`[ThumbStatusRepo] upsert失败 (path=${path}):`, error.message);
            throw error;
        }
    }

    /**
     * 更新缩略图状态
     * @param {string} path - 文件路径
     * @param {string} status - 新状态
     * @returns {Promise<boolean>}
     */
    async updateStatus(path, status) {
        try {
            await dbRun('main', 
                'UPDATE thumb_status SET status = ?, last_checked = strftime("%s","now")*1000 WHERE path = ?',
                [status, path]
            );
            return true;
        } catch (error) {
            logger.warn(`[ThumbStatusRepo] 更新status失败 (path=${path}):`, error.message);
            return false;
        }
    }

    /**
     * 删除缩略图状态记录
     * @param {string} path - 文件路径
     * @returns {Promise<boolean>}
     */
    async deleteByPath(path) {
        try {
            await dbRun('main', 'DELETE FROM thumb_status WHERE path = ?', [String(path || '')]);
            return true;
        } catch (error) {
            logger.warn(`[ThumbStatusRepo] 删除thumb_status失败 (path=${path}):`, error.message);
            return false;
        }
    }

    /**
     * 批量删除缩略图状态记录
     * @param {Array<string>} paths - 文件路径数组
     * @param {boolean} includeSubpaths - 是否包含子路径（LIKE匹配）
     * @returns {Promise<number>}
     */
    async deleteBatch(paths, includeSubpaths = false) {
        if (!Array.isArray(paths) || paths.length === 0) return 0;

        try {
            const placeholders = paths.map(() => '?').join(',');
            let sql = `DELETE FROM thumb_status WHERE path IN (${placeholders})`;
            let params = [...paths];

            if (includeSubpaths) {
                const likeConditions = paths.map(() => `path LIKE ?`).join(' OR ');
                const likeParams = paths.map(p => `${p}/%`);
                sql = `DELETE FROM thumb_status WHERE path IN (${placeholders}) OR ${likeConditions}`;
                params = [...paths, ...likeParams];
            }

            await dbRun('main', sql, params);
            logger.debug(`[ThumbStatusRepo] 批量删除thumb_status完成: ${paths.length}个路径`);
            return paths.length;
        } catch (error) {
            logger.error(`[ThumbStatusRepo] 批量删除thumb_status失败:`, error.message);
            throw error;
        }
    }

    /**
     * 删除目录下的所有缩略图状态记录
     * @param {string} dirPath - 目录路径
     * @returns {Promise<boolean>}
     */
    async deleteByDirectory(dirPath) {
        try {
            await dbRun('main', 
                `DELETE FROM thumb_status WHERE path LIKE ? || '/%'`, 
                [dirPath]
            );
            logger.debug(`[ThumbStatusRepo] 已删除目录下的thumb_status: ${dirPath}`);
            return true;
        } catch (error) {
            logger.warn(`[ThumbStatusRepo] 删除目录thumb_status失败 (dirPath=${dirPath}):`, error.message);
            return false;
        }
    }

    /**
     * 统计缩略图状态数量
     * @param {string|null} status - 状态筛选（null表示全部）
     * @returns {Promise<number>}
     */
    async count(status = null) {
        try {
            let sql, params;
            if (status) {
                // 使用status索引优化COUNT查询
                sql = 'SELECT COUNT(1) as count FROM thumb_status INDEXED BY idx_thumb_status_status WHERE status = ?';
                params = [status];
            } else {
                // 使用专门的COUNT优化索引
                sql = 'SELECT COUNT(1) as count FROM thumb_status INDEXED BY idx_thumb_status_count_optimization';
                params = [];
            }
            const row = await dbGet('main', sql, params);
            return row ? Number(row.count) || 0 : 0;
        } catch (error) {
            logger.warn(`[ThumbStatusRepo] 统计thumb_status失败:`, error.message);
            return 0;
        }
    }

    /**
     * 获取状态分组统计
     * @returns {Promise<Object>} { 'exists': 100, 'missing': 50, ... }
     */
    async getStatusStats() {
        try {
            // 使用status索引优化GROUP BY查询
            const rows = await dbAll('main', 'SELECT status, COUNT(1) as count FROM thumb_status INDEXED BY idx_thumb_status_status GROUP BY status');
            const stats = {};
            (rows || []).forEach(row => {
                stats[row.status] = Number(row.count) || 0;
            });
            return stats;
        } catch (error) {
            logger.warn(`[ThumbStatusRepo] 获取状态统计失败:`, error.message);
            return {};
        }
    }

    /**
     * 获取所有缩略图状态记录（支持指定字段）
     * @param {Array<string>|null} fields - 要查询的字段数组，null表示所有字段
     * @param {number|null} limit - 限制数量
     * @returns {Promise<Array>}
     */
    async getAll(fields = null, limit = null) {
        try {
            const selectFields = Array.isArray(fields) && fields.length > 0 
                ? fields.join(', ') 
                : '*';
            
            let sql = `SELECT ${selectFields} FROM thumb_status`;
            const params = [];

            if (limit) {
                sql += ' LIMIT ?';
                params.push(limit);
            }

            const rows = await dbAll('main', sql, params);
            return rows || [];
        } catch (error) {
            logger.warn(`[ThumbStatusRepo] 获取所有thumb_status失败:`, error.message);
            return [];
        }
    }
}

module.exports = ThumbStatusRepository;
