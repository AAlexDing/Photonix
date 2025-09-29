-- 创建Photonix项目的四个数据库
-- 此文件将在MariaDB容器启动时自动执行

-- 创建主数据库
CREATE DATABASE IF NOT EXISTS photonix_main CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 创建设置数据库  
CREATE DATABASE IF NOT EXISTS photonix_settings CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 创建历史记录数据库
CREATE DATABASE IF NOT EXISTS photonix_history CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 创建索引数据库
CREATE DATABASE IF NOT EXISTS photonix_index CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 创建photonix用户并授权（如果不存在）
CREATE USER IF NOT EXISTS 'photonix'@'%' IDENTIFIED BY 'photonix123456';

-- 给photonix用户授权访问所有photonix数据库
GRANT ALL PRIVILEGES ON photonix_main.* TO 'photonix'@'%';
GRANT ALL PRIVILEGES ON photonix_settings.* TO 'photonix'@'%';
GRANT ALL PRIVILEGES ON photonix_history.* TO 'photonix'@'%';
GRANT ALL PRIVILEGES ON photonix_index.* TO 'photonix'@'%';

-- 刷新权限
FLUSH PRIVILEGES;