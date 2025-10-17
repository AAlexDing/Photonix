/**
 * @file HistoryTracker.js
 * @description 历史记录追踪器，负责去重和历史管理
 */

const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

class HistoryTracker {
  constructor(config, paths) {
    this.config = config;
    this.paths = paths;
    this.db = null;
  }

  /**
   * 初始化数据库
   */
  async initializeDatabase() {
    if (this.db) {
      try {
        this.db.close();
      } catch (error) {
        console.warn('关闭旧的下载数据库连接时发生错误', { error: error.message });
      }
      this.db = null;
    }

    try {
      this.db = new Database(this.paths.databasePath);
      this.db.pragma('journal_mode = WAL');
      
      // 创建下载历史表（用于去重查询）
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS download_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT,
          post_title TEXT,
          feed_title TEXT,
          entry_link TEXT,
          downloaded_at TEXT NOT NULL
        );
      `);
      
      // 创建去重索引
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_title ON download_history(post_title);');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_feed_title ON download_history(feed_title, post_title);');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_link ON download_history(entry_link);');
      
      // 创建完整历史记录表（包含文件信息和大小）
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS download_history_full (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          identifier TEXT,
          title TEXT NOT NULL,
          feed TEXT NOT NULL,
          article_url TEXT,
          images_json TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          total_size INTEGER DEFAULT 0
        );
      `);
      
      // 创建完整历史表索引
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_full_completed ON download_history_full(completed_at DESC);');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_full_task ON download_history_full(task_id);');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_full_size ON download_history_full(total_size);');
      
      // 创建任务表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          feed_url TEXT NOT NULL,
          interval TEXT DEFAULT '60m',
          status TEXT DEFAULT 'paused',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schedule_interval TEXT,
          schedule_next TEXT,
          category TEXT DEFAULT '',
          exclude_keywords TEXT DEFAULT '[]',
          tags TEXT DEFAULT '[]',
          notes TEXT DEFAULT '',
          cookie TEXT DEFAULT '',
          cookie_domain TEXT DEFAULT '',
          stats_articles_downloaded INTEGER DEFAULT 0,
          stats_images_downloaded INTEGER DEFAULT 0,
          stats_last_run_at TEXT,
          stats_last_success_at TEXT,
          stats_last_error_at TEXT,
          stats_last_error TEXT
        );
      `);
      
      // 创建任务索引
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_feed_url ON tasks(feed_url);');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);');
      
      console.info(`数据库连接成功 (去重模式: ${this.getDedupScopeDisplay(this.config.dedupScope)})`, {
        scope: '下载器',
        databasePath: this.paths.databasePath,
        dedupScope: this.config.dedupScope
      });
    } catch (error) {
      console.error('初始化下载历史数据库失败', { error: error.message });
      throw new Error('无法初始化下载历史数据库');
    }
  }

  /**
   * 检查是否已下载
   * @param {object} params 检查参数
   * @returns {boolean} 是否已下载
   */
  hasDownloaded({ taskId, title, feedTitle, entryLink }) {
    if (!this.db) return false;
    
    try {
      const scope = this.config.dedupScope;
      
      if (scope === 'by_link' && entryLink) {
        const stmt = this.db.prepare('SELECT 1 FROM download_history WHERE entry_link = ? LIMIT 1');
        return Boolean(stmt.get(entryLink));
      }
      
      if (scope === 'per_feed' && feedTitle && title) {
        const stmt = this.db.prepare('SELECT 1 FROM download_history WHERE feed_title = ? AND post_title = ? LIMIT 1');
        return Boolean(stmt.get(feedTitle, title));
      }
      
      if (title) {
        const stmt = this.db.prepare('SELECT 1 FROM download_history WHERE post_title = ? LIMIT 1');
        return Boolean(stmt.get(title));
      }
    } catch (error) {
      console.warn('查询历史记录失败', { error: error.message });
    }
    
    return false;
  }

  /**
   * 记录下载
   * @param {object} params 记录参数
   */
  recordDownload({ taskId, title, feedTitle, entryLink }) {
    if (!this.db) return;
    
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO download_history (task_id, post_title, feed_title, entry_link, downloaded_at)
        VALUES (@taskId, @title, @feedTitle, @entryLink, datetime('now'))
      `);
      stmt.run({ taskId, title, feedTitle, entryLink });
    } catch (error) {
      console.warn('写入下载历史失败', { error: error.message });
    }
  }

  /**
   * 添加历史记录条目
   * @param {object} entry 历史条目
   * @returns {object} 标准化的历史条目
   */
  addHistoryEntry(entry) {
    if (!this.db) {
      console.warn('数据库未初始化，无法添加历史记录');
      return null;
    }

    const normalizedEntry = {
      id: entry.id || uuidv4(),
      taskId: entry.taskId,
      identifier: entry.identifier || '',
      title: entry.title || '(未命名)',
      feed: entry.feed || '',
      articleUrl: entry.articleUrl || null,
      images: Array.isArray(entry.images) ? entry.images : [],
      completedAt: entry.completedAt || new Date().toISOString(),
      size: entry.size || 0
    };

    try {
      const stmt = this.db.prepare(`
        INSERT INTO download_history_full (
          id, task_id, identifier, title, feed, article_url, 
          images_json, completed_at, total_size
        ) VALUES (
          @id, @taskId, @identifier, @title, @feed, @articleUrl,
          @imagesJson, @completedAt, @totalSize
        )
      `);

      stmt.run({
        id: normalizedEntry.id,
        taskId: normalizedEntry.taskId,
        identifier: normalizedEntry.identifier,
        title: normalizedEntry.title,
        feed: normalizedEntry.feed,
        articleUrl: normalizedEntry.articleUrl,
        imagesJson: JSON.stringify(normalizedEntry.images),
        completedAt: normalizedEntry.completedAt,
        totalSize: normalizedEntry.size
      });

      return normalizedEntry;
    } catch (error) {
      console.error('添加历史记录失败', { 
        error: error.message,
        entryId: normalizedEntry.id
      });
      return null;
    }
  }

  /**
   * 批量添加历史记录
   * @param {Array} entries 历史条目数组
   */
  addHistoryBatch(entries) {
    if (!this.db || !Array.isArray(entries) || entries.length === 0) {
      return;
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO download_history_full (
        id, task_id, identifier, title, feed, article_url,
        images_json, completed_at, total_size
      ) VALUES (
        @id, @taskId, @identifier, @title, @feed, @articleUrl,
        @imagesJson, @completedAt, @totalSize
      )
    `);

    const transaction = this.db.transaction((items) => {
      for (const entry of items) {
        const normalizedEntry = {
          id: entry.id || uuidv4(),
          taskId: entry.taskId,
          identifier: entry.identifier || '',
          title: entry.title || '(未命名)',
          feed: entry.feed || '',
          articleUrl: entry.articleUrl || null,
          images: Array.isArray(entry.images) ? entry.images : [],
          completedAt: entry.completedAt || new Date().toISOString(),
          size: entry.size || 0
        };

        insertStmt.run({
          id: normalizedEntry.id,
          taskId: normalizedEntry.taskId,
          identifier: normalizedEntry.identifier,
          title: normalizedEntry.title,
          feed: normalizedEntry.feed,
          articleUrl: normalizedEntry.articleUrl,
          imagesJson: JSON.stringify(normalizedEntry.images),
          completedAt: normalizedEntry.completedAt,
          totalSize: normalizedEntry.size
        });
      }
    });

    try {
      transaction(entries);
    } catch (error) {
      console.error('批量添加历史记录失败', { 
        error: error.message,
        count: entries.length
      });
    }
  }

  /**
   * 获取最近的下载记录
   * @param {number} limit 限制数量
   * @returns {Array} 历史记录
   */
  getRecentHistory(limit = 25) {
    if (!this.db) {
      return [];
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 1000));

    try {
      const stmt = this.db.prepare(`
        SELECT * FROM download_history_full 
        ORDER BY completed_at DESC 
        LIMIT ?
      `);
      const rows = stmt.all(safeLimit);

      return rows.map(row => this.deserializeHistoryEntry(row)).filter(Boolean);
    } catch (error) {
      console.error('获取最近历史记录失败', { error: error.message });
      return [];
    }
  }

  /**
   * 获取历史记录数量
   * @returns {number}
   */
  getHistoryCount() {
    if (!this.db) {
      return 0;
    }

    try {
      const stmt = this.db.prepare('SELECT COUNT(*) as count FROM download_history_full');
      const result = stmt.get();
      return result.count || 0;
    } catch (error) {
      console.error('获取历史记录数量失败', { error: error.message });
      return 0;
    }
  }

  /**
   * 分页获取历史记录
   * @param {{page?:number,pageSize?:number}} [options]
   * @returns {{entries:Array,pagination:{page:number,pageSize:number,total:number}}}
   */
  getHistoryPage({ page = 1, pageSize = 50 } = {}) {
    if (!this.db) {
      return {
        entries: [],
        pagination: { page: 1, pageSize: 50, total: 0 }
      };
    }

    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeSize = Number.isFinite(pageSize) && pageSize > 0
      ? Math.min(Math.floor(pageSize), 200)
      : 50;
    const offset = (safePage - 1) * safeSize;

    try {
      const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM download_history_full');
      const total = countStmt.get().count || 0;

      const dataStmt = this.db.prepare(`
        SELECT * FROM download_history_full 
        ORDER BY completed_at DESC 
        LIMIT ? OFFSET ?
      `);
      const rows = dataStmt.all(safeSize, offset);

      const entries = rows
        .map(row => this.deserializeHistoryEntry(row))
        .filter(Boolean)
        .map(entry => this.normalizeEntryShape(entry))
        .filter(Boolean);

      return {
        entries,
        pagination: {
          page: safePage,
          pageSize: safeSize,
          total
        }
      };
    } catch (error) {
      console.error('分页查询历史记录失败', { error: error.message });
      return {
        entries: [],
        pagination: { page: safePage, pageSize: safeSize, total: 0 }
      };
    }
  }

  /**
   * 估算历史记录占用的字节数
   * @returns {number}
   */
  getTotalSizeEstimate() {
    if (!this.db) {
      return 0;
    }

    try {
      const stmt = this.db.prepare('SELECT SUM(total_size) as total FROM download_history_full');
      const result = stmt.get();
      return result.total || 0;
    } catch (error) {
      console.error('获取存储大小失败', { error: error.message });
      return 0;
    }
  }

  /**
   * 从数据库行反序列化历史条目
   * @param {object} row 数据库行
   * @returns {object|null}
   */
  deserializeHistoryEntry(row) {
    if (!row) return null;

    try {
      return {
        id: row.id,
        taskId: row.task_id,
        identifier: row.identifier || '',
        title: row.title,
        feed: row.feed,
        articleUrl: row.article_url,
        images: JSON.parse(row.images_json || '[]'),
        completedAt: row.completed_at,
        size: row.total_size || 0
      };
    } catch (error) {
      console.warn('反序列化历史记录失败', { 
        error: error.message,
        rowId: row.id
      });
      return null;
    }
  }

  /**
   * 清理过期的历史记录
   * @param {number} daysToKeep 保留天数
   */
  cleanupOldHistory(daysToKeep = 30) {
    if (!this.db) return;
    
    try {
      const stmt = this.db.prepare(`
        DELETE FROM download_history 
        WHERE downloaded_at < datetime('now', '-' || ? || ' days')
      `);
      const result = stmt.run(daysToKeep);
      
      if (result.changes > 0) {
        console.info(`清理了 ${result.changes} 条过期的下载历史记录`);
      }
    } catch (error) {
      console.warn('清理历史记录失败', { error: error.message });
    }
  }

  /**
   * 获取统计信息
   * @returns {object} 统计信息
   */
  getStatistics() {
    if (!this.db) {
      return {
        totalDownloads: 0,
        uniqueFeeds: 0,
        recentDownloads: 0
      };
    }
    
    try {
      const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM download_history');
      const feedsStmt = this.db.prepare('SELECT COUNT(DISTINCT feed_title) as count FROM download_history');
      const recentStmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM download_history 
        WHERE downloaded_at > datetime('now', '-24 hours')
      `);
      
      return {
        totalDownloads: totalStmt.get().count,
        uniqueFeeds: feedsStmt.get().count,
        recentDownloads: recentStmt.get().count
      };
    } catch (error) {
      console.warn('获取统计信息失败', { error: error.message });
      return {
        totalDownloads: 0,
        uniqueFeeds: 0,
        recentDownloads: 0
      };
    }
  }

  /**
   * 标准化历史条目结构
   * @param {object} entry
   * @returns {object|null}
   */
  normalizeEntryShape(entry) {
    if (!entry) return null;
    const images = Array.isArray(entry.images) ? entry.images : [];
    const normalizedImages = images.map((image) => ({
      url: image?.url || null,
      path: image?.path || null,
      size: Number(image?.size || 0)
    }));

    return {
      id: entry.id,
      taskId: entry.taskId,
      identifier: entry.identifier,
      title: entry.title,
      feed: entry.feed,
      articleUrl: entry.articleUrl || null,
      images: normalizedImages,
      imageCount: normalizedImages.length,
      size: Number(entry.size || 0),
      completedAt: entry.completedAt || new Date().toISOString()
    };
  }

  /**
   * 计算历史条目的体积估算
   * @param {object} entry
   * @returns {number}
   */
  calculateEntrySize(entry) {
    if (!entry) return 0;
    if (typeof entry.size === 'number' && Number.isFinite(entry.size)) {
      return Math.max(entry.size, 0);
    }
    if (Array.isArray(entry.images)) {
      return entry.images.reduce((sum, image) => {
        const value = Number(image?.size || 0);
        return sum + (Number.isFinite(value) && value > 0 ? value : 0);
      }, 0);
    }
    return 0;
  }

  /**
   * 获取去重策略的中文描述
   */
  getDedupScopeDisplay(scope) {
    const scopeMap = {
      'by_link': '按链接去重',
      'per_feed': '按订阅源去重',
      'global': '全局去重'
    };
    return scopeMap[scope] || scope;
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this.db) {
      try {
        this.db.close();
        this.db = null;
      } catch (error) {
        console.warn('关闭数据库连接失败', { error: error.message });
      }
    }
  }
}

module.exports = HistoryTracker;
