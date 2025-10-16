/**
 * @file router.js
 * @description 前端路由管理。负责页面导航、内容渲染、多路由场景切换等。
 */

import { state, clearExpiredAlbumTombstones, getAlbumTombstonesMap } from '../core/state.js';
import { elements } from '../shared/dom-elements.js';
import { applyMasonryLayout, getMasonryColumns } from '../features/gallery/masonry.js';
import { setupLazyLoading } from '../features/gallery/lazyload.js';
import { fetchSearchResults, fetchBrowseResults, postViewed } from './api.js';
import {
    renderBreadcrumb,
    renderBrowseGrid,
    renderSearchGrid,
    sortAlbumsByViewed,
    renderSortDropdown,
    applyLayoutMode,
    renderLayoutToggleOnly,
    ensureLayoutToggleVisible,
    adjustScrollOptimization
} from '../features/gallery/ui.js';
import { saveViewed, getUnsyncedViewed, markAsSynced } from '../shared/indexeddb-helper.js';
import { AbortBus } from '../core/abort-bus.js';
import { refreshPageEventListeners } from '../features/gallery/listeners.js';
import {
    showNetworkError,
    showEmptySearchResults,
    showEmptyAlbum,
    showIndexBuildingError,
    showMinimalLoader
} from '../features/gallery/loading-states.js';
import { routerLogger } from '../core/logger.js';
import { safeSetInnerHTML, safeGetElementById, safeClassList, safeSetStyle } from '../shared/dom-utils.js';
import { executeAsync, ErrorTypes, ErrorSeverity } from '../core/error-handler.js';
import { setManagedTimeout } from '../core/timer-manager.js';
import { CACHE, ROUTER } from '../core/constants.js';
import { escapeHtml } from '../shared/security.js';
import { isDownloadRoute, showDownloadPage, hideDownloadPage } from '../features/download/index.js';

let currentRequestController = null;

/**
 * 过滤集合，剔除被“墓碑”标记的相册项。
 * @param {Array} collection - 原始项目集合（相册和照片）
 * @returns {Object} { items: 过滤后的集合, removed: 被移除数量 }
 */
function applyAlbumTombstones(collection) {
    clearExpiredAlbumTombstones();
    const tombstones = getAlbumTombstonesMap();
    if (!(tombstones instanceof Map) || tombstones.size === 0) {
        return { items: collection, removed: 0 };
    }
    const filtered = [];
    let removed = 0;
    for (const item of collection || []) {
        if (item?.type === 'album') {
            const albumPath = item?.data?.path;
            if (albumPath && tombstones.has(albumPath)) {
                removed += 1;
                continue;
            }
        }
        filtered.push(item);
    }
    return { items: filtered, removed };
}

/**
 * 生成面包屑导航HTML，保证安全性。
 * @param {Object} data - 搜索结果数据
 * @param {string} query - 搜索查询词
 * @returns {string} HTML 字符串
 */
function generateBreadcrumbHTML(data, query) {
    const preSearchHash = state.preSearchHash;
    const hasResults = data.results && data.results.length > 0;
    const searchQuery = escapeHtml(data.query || query || '');
    const totalResults = data.totalResults || 0;
    return `
       <div class="flex items-center justify-between w-full">
           <div class="flex items-center">
               <a href="${preSearchHash}" class="flex items-center text-purple-400 hover:text-purple-300 transition-colors duration-200 group">
                   <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="mr-1 group-hover:-translate-x-1 transition-transform"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                   返回
               </a>
               ${hasResults ? `<span class="mx-3 text-gray-600">/</span><span class="text-white">搜索结果: "${searchQuery}" (${totalResults}项)</span>` : ''}
           </div>
           <div id="sort-container" class="flex-shrink-0 ml-4"></div>
       </div>`;
}

/**
 * 获取当前hash对应的路由路径（去除modal后缀与参数）。
 * @returns {string} 路径
 */
function getPathOnlyFromHash() {
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));
    const questionMarkIndex = newDecodedPath.indexOf('?');
    return questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
}

/**
 * 路由初始化。恢复session状态并监听hash变化。
 */
export function initializeRouter() {
    try {
        const raw = sessionStorage.getItem('sg_scroll_positions');
        if (raw) {
            const obj = JSON.parse(raw);
            const entries = Object.entries(obj).slice(-CACHE.SCROLL_POSITION_STORAGE_LIMIT);
            const map = new Map(entries);
            state.update('scrollPositions', map);
        }
        const pre = sessionStorage.getItem('sg_pre_search_hash');
        if (pre) state.update('preSearchHash', pre);
        const fromSearch = sessionStorage.getItem('sg_from_search_hash');
        if (fromSearch) state.update('fromSearchHash', fromSearch);
    } catch {}
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
}

/**
 * hash路由主入口，处理内容加载与导航切换。
 */
export async function handleHashChange() {
    persistRouteState();
    AbortBus.abortMany(['page', 'scroll']);
    const pageSignal = AbortBus.next('page');
    const { cleanHashString, newDecodedPath } = sanitizeHash();
    refreshRouteEventListenersSafely();
    if (isDownloadRoute(cleanHashString)) {
        await showDownloadPage();
        return;
    }
    hideDownloadPage();
    const navigation = buildNavigationContext(cleanHashString, newDecodedPath);
    if (shouldReuseExistingContent(navigation)) {
        return;
    }
    updatePreSearchHash(cleanHashString);
    manageFromSearchHash(newDecodedPath);
    if (navigation.isSearchRoute) {
        await handleSearchRoute(navigation, pageSignal);
    } else {
        await handleBrowseRoute(navigation, pageSignal);
    }
}

/**
 * 持久化当前路由相关状态（比如滚动位置）。
 */
function persistRouteState() {
    if (typeof state.currentBrowsePath === 'string' && window.savePageLazyState) {
        window.savePageLazyState(state.currentBrowsePath);
    }
    if (window.clearRestoreProtection) {
        window.clearRestoreProtection();
    }
    if (typeof state.currentBrowsePath === 'string') {
        const key = state.currentBrowsePath;
        
        // 检测是否是关闭modal（相册）
        const oldHash = sessionStorage.getItem('sg_last_hash') || '';
        const newHash = location.hash;
        const isClosingModal = oldHash.includes('#modal') && !newHash.includes('#modal');
        
        // 如果是关闭modal，不覆盖之前保存的滚动位置
        if (!isClosingModal) {
            const newScrollPositions = new Map(state.scrollPositions);
            newScrollPositions.set(key, window.scrollY);
            state.scrollPositions = newScrollPositions;
        }
        
        // 如果当前在搜索页，保存搜索hash（在离开前保存）
        if (key.startsWith('search?q=')) {
            try {
                sessionStorage.setItem('sg_from_search_hash', oldHash || newHash);
            } catch (e) {
                // 忽略错误
            }
        }
        
        // 保存当前hash供下次判断
        sessionStorage.setItem('sg_last_hash', newHash);
    }
}

/**
 * hash清洗与解码。
 * @returns {{ cleanHashString: string, newDecodedPath: string }}
 */
function sanitizeHash() {
    const cleanHashString = window.location.hash.replace(/#modal$/, '');
    const newDecodedPath = decodeURIComponent(cleanHashString.substring(1).replace(/^\//, ''));
    return { cleanHashString, newDecodedPath };
}

/**
 * 安全刷新全局页面事件监听（防止异常阻断）。
 */
function refreshRouteEventListenersSafely() {
    try {
        refreshPageEventListeners();
    } catch (error) {
        routerLogger.warn('刷新页面事件监听失败', error);
    }
}

/**
 * 构建导航上下文对象，用于路由状态判断和内容渲染逻辑。
 * @param {string} cleanHashString
 * @param {string} newDecodedPath
 * @returns {Object} 导航上下文
 */
function buildNavigationContext(cleanHashString, newDecodedPath) {
    const questionMarkIndex = newDecodedPath.indexOf('?');
    const pathOnly = questionMarkIndex !== -1 ? newDecodedPath.substring(0, questionMarkIndex) : newDecodedPath;
    let sortParam = questionMarkIndex !== -1 ? newDecodedPath.substring(questionMarkIndex) : '';
    if (sortParam.startsWith('?sort=')) {
        sortParam = sortParam.substring(6);
    }
    const pathChanged = pathOnly !== state.currentBrowsePath;
    const previousSort = state.currentSort || 'smart';
    const currentSortValue = sortParam || (pathChanged ? previousSort : 'smart');
    const sortChanged = currentSortValue !== previousSort;

    return {
        cleanHashString,
        newDecodedPath,
        pathOnly,
        sortParam,
        currentSortValue,
        previousSort,
        pathChanged,
        sortChanged,
        isSearchRoute: newDecodedPath.startsWith('search?q=')
    };
}

/**
 * 判断是否需要复用当前内容（避免重复渲染）。只有路径与排序都不变且已渲染内容时复用。
 * @param {Object} navigation
 * @returns {boolean}
 */
function shouldReuseExistingContent(navigation) {
    if (navigation.pathChanged || navigation.sortChanged || state.isInitialLoad) {
        return false;
    }
    return !!(elements.contentGrid && elements.contentGrid.querySelector('.grid-item'));
}

/**
 * 根据hash内容更新preSearchHash（搜索页返回用）。
 * @param {string} cleanHashString
 */
function updatePreSearchHash(cleanHashString) {
    if (!cleanHashString.startsWith('#/search?q=')) {
        return;
    }
    if (!state.currentBrowsePath || !state.currentBrowsePath.startsWith('search?q=')) {
        state.preSearchHash = state.currentBrowsePath ? `#/${encodeURIComponent(state.currentBrowsePath)}` : '#/';
    }
}

/**
 * 管理"来源搜索页"的hash，用于面包屑"返回搜索"功能。
 * @param {string} newDecodedPath - 新的路径
 */
function manageFromSearchHash(newDecodedPath) {
    const isTargetSearch = newDecodedPath.startsWith('search?q=');
    
    // 如果进入搜索页或首页，清除fromSearchHash
    if (isTargetSearch || newDecodedPath === '') {
        try {
            sessionStorage.removeItem('sg_from_search_hash');
            state.update('fromSearchHash', null);
        } catch (e) {
            // 忽略sessionStorage错误
        }
    } else {
        // 不是搜索页，从sessionStorage同步到state
        try {
            const savedHash = sessionStorage.getItem('sg_from_search_hash');
            if (savedHash) {
                state.update('fromSearchHash', savedHash);
            }
        } catch (e) {
            // 忽略sessionStorage错误
        }
    }
}

/**
 * 搜索路由处理业务入口。
 * @param {Object} navigation
 * @param {AbortSignal} pageSignal
 */
async function handleSearchRoute(navigation, pageSignal) {
    const queryIndex = navigation.newDecodedPath.indexOf('?');
    const searchParams = queryIndex !== -1 ? navigation.newDecodedPath.substring(queryIndex) : '';
    const urlParams = new URLSearchParams(searchParams);
    const query = urlParams.get('q') || '';
    await executeSearch(query, pageSignal);
}

/**
 * 普通相册浏览路由处理业务入口。
 * @param {Object} navigation
 * @param {AbortSignal} pageSignal
 */
async function handleBrowseRoute(navigation, pageSignal) {
    state.currentSort = navigation.currentSortValue;
    state.currentBrowsePath = navigation.pathOnly;
    renderBreadcrumb(navigation.pathOnly);

    if (navigation.pathChanged || navigation.sortChanged) {
        state.entrySort = navigation.currentSortValue;
    }

    await streamPath(navigation.pathOnly, pageSignal);

    try {
        setManagedTimeout(async () => {
            const stillSameRoute = getPathOnlyFromHash() === navigation.pathOnly && AbortBus.get('page') === pageSignal;
            const noRealContent = !(elements.contentGrid && elements.contentGrid.querySelector('.grid-item'));
            const notError = !(elements.contentGrid && safeClassList(elements.contentGrid, 'contains', 'error-container'));
            if (stillSameRoute && noRealContent && notError) {
                const retrySignal = AbortBus.next('page');
                await streamPath(navigation.pathOnly, retrySignal);
            }
        }, ROUTER.ROUTE_RETRY_DELAY, 'route-retry-delay');
    } catch {}
}

/**
 * 主相册/目录内容流式加载及UI渲染方法。
 * @param {string} path 路径
 * @param {AbortSignal} signal
 */
export async function streamPath(path, signal) {
    const requestStart = performance.now();
    const prepareControl = await prepareForNewContent();
    state.isBrowseLoading = true;
    state.currentBrowsePage = 1;
    state.totalBrowsePages = 1;

    renderBreadcrumb(path);

    if (path.startsWith('search?q=')) {
        routerLogger.error('搜索页面不应该调用 streamPath 函数');
        return;
    }

    try {
        const data = await executeAsync(
            async () => {
                const [browseData] = await Promise.all([
                    fetchBrowseResults(path, state.currentBrowsePage, signal),
                    onAlbumViewed(path)
                ]);
                return browseData;
            },
            {
                context: { path, operation: 'streamPath' },
                errorType: ErrorTypes.NETWORK,
                errorSeverity: ErrorSeverity.MEDIUM,
                onError: (error, ctx) => {
                    routerLogger.warn(`路径流式加载失败 (尝试 ${ctx.attempt})`, {
                        path,
                        error: error.message
                    });
                }
            }
        );

        if (!data || signal.aborted || AbortBus.get('page') !== signal || getPathOnlyFromHash() !== path) return;

        // 数据到达后取消加载器
        const responseTime = performance.now() - requestStart;
        if (prepareControl && prepareControl.cancelSkeleton) {
            prepareControl.cancelSkeleton();
        }

        const { items: filteredItems, removed: removedAlbums } = applyAlbumTombstones(data.items || []);
        data.items = filteredItems;
        if (removedAlbums > 0 && typeof data.totalResults === 'number') {
            data.totalResults = Math.max(0, data.totalResults - removedAlbums);
        }

        state.currentBrowsePath = path;
        state.totalBrowsePages = data.totalPages;

        if (!data.items || data.items.length === 0) {
            const sortContainer = safeGetElementById('sort-container');
            if (sortContainer) safeSetInnerHTML(sortContainer, '');
            state.totalBrowsePages = 0;
            state.currentBrowsePage = 1;
            // 隐藏无限加载器，提升UI性能
            if (elements.infiniteScrollLoader) safeClassList(elements.infiniteScrollLoader, 'remove', 'visible');
            showEmptyAlbum();
            return;
        }

        const hasMediaFiles = data.items.some(item => item.type === 'photo' || item.type === 'video');

        // 直接渲染所有项目（移除分批渲染逻辑）
        const { contentElements, newMediaUrls } = renderBrowseGrid(data.items, 0);
        const minimalLoader = safeGetElementById('minimal-loader');
        if (minimalLoader) {
            minimalLoader.replaceWith(...contentElements);
        } else {
            safeSetInnerHTML(elements.contentGrid, '');
            elements.contentGrid.append(...contentElements);
        }

        // 更新状态
        state.currentPhotos = newMediaUrls;
        state.currentBrowsePage++;

        if (AbortBus.get('page') !== signal || getPathOnlyFromHash() !== path) return;

        // UI恢复与布局切换
        import('../shared/dom-elements.js').then(({ reinitializeElements }) => {
            reinitializeElements();
            const sortContainer = safeGetElementById('sort-container');
            if (sortContainer) {
                if (hasMediaFiles) {
                    renderLayoutToggleOnly();
                } else {
                    renderSortDropdown();
                }
            }
            applyLayoutMode();
            finalizeNewContent(path);
        });

        setManagedTimeout(() => {
            ensureLayoutToggleVisible();
            adjustScrollOptimization(path);
        }, 50, 'layout-post-render');
    } catch (error) {
        if (error.name !== 'AbortError') {
            showNetworkError();
            return;
        }
    } finally {
        state.isBrowseLoading = false;
        if (!safeClassList(elements.contentGrid, 'contains', 'error-container')) {
            safeSetStyle(elements.contentGrid, 'minHeight', '');
        }
    }
}

/**
 * 执行全局搜索并渲染结果。
 * @param {string} query - 搜索关键词
 * @param {AbortSignal} signal - 中止信号
 */
async function executeSearch(query, signal) {
    const prepareControl = await prepareForNewContent();
    state.currentPhotos = [];
    state.currentSearchQuery = query;
    state.currentSearchPage = 1;
    state.totalSearchPages = 1;
    state.isSearchLoading = true;

    try {
        const data = await executeAsync(
            () => fetchSearchResults(query, state.currentSearchPage, signal),
            {
                context: { query, operation: 'executeSearch' },
                errorType: ErrorTypes.NETWORK,
                errorSeverity: ErrorSeverity.MEDIUM,
                onError: (error, ctx) => {
                    routerLogger.warn(`搜索请求失败 (尝试 ${ctx.attempt})`, {
                        query,
                        error: error.message
                    });
                }
            }
        );

        const searchPathKey = `search?q=${query}`;
        if (signal.aborted || AbortBus.get('page') !== signal) return;

        // 到达后取消骨架
        if (prepareControl && prepareControl.cancelSkeleton) {
            prepareControl.cancelSkeleton();
        }

        if (!data || !data.results) {
            routerLogger.error('搜索返回数据不完整', data);
            showNetworkError();
            return;
        }

        const { items: filteredResults, removed: removedAlbums } = applyAlbumTombstones(data.results || []);
        data.results = filteredResults;
        if (removedAlbums > 0 && typeof data.totalResults === 'number') {
            data.totalResults = Math.max(0, data.totalResults - removedAlbums);
        }

        state.currentBrowsePath = searchPathKey;

        safeSetInnerHTML(elements.breadcrumbNav, generateBreadcrumbHTML(data, query));

        if (data.results.length === 0) {
            state.totalSearchPages = 0;
            state.currentSearchPage = 1;
            // 隐藏加载器
            const loaderContainer = safeGetElementById('infinite-scroll-loader-container');
            if (loaderContainer) safeClassList(loaderContainer, 'remove', 'visible');
            showEmptySearchResults(query);
            safeSetStyle(elements.contentGrid, 'minHeight', '');
            return;
        }

        // 直接渲染所有搜索结果（移除分批渲染逻辑）
        const { contentElements, newMediaUrls } = renderSearchGrid(data.results, 0);
        const minimalLoader = safeGetElementById('minimal-loader');
        if (minimalLoader) {
            minimalLoader.replaceWith(...contentElements);
        } else {
            safeSetInnerHTML(elements.contentGrid, '');
            elements.contentGrid.append(...contentElements);
        }
        
        // 更新状态
        state.currentPhotos = newMediaUrls;
        state.totalSearchPages = data.totalPages;
        state.currentSearchPage++;

        if (AbortBus.get('page') !== signal) return;
        import('../shared/dom-elements.js').then(({ reinitializeElements }) => {
            reinitializeElements();
            renderLayoutToggleOnly();
        });

        applyLayoutMode();
        finalizeNewContent(searchPathKey);

        setManagedTimeout(() => {
            ensureLayoutToggleVisible();
            adjustScrollOptimization(searchPathKey);
        }, 50, 'search-layout-post-render');
    } catch (error) {
        if (error.name !== 'AbortError') {
            routerLogger.error("执行搜索失败", error);
            if (error.message && error.message.includes('搜索索引正在构建中')) {
                showIndexBuildingError();
            } else {
                showNetworkError();
            }
            return;
        }
    } finally {
        state.isSearchLoading = false;
        if (!safeClassList(elements.contentGrid, 'contains', 'error-container')) {
            safeSetStyle(elements.contentGrid, 'minHeight', '');
        }
    }
}

/**
 * 准备新内容渲染，清理旧页面与状态，并处理loading效果。
 * @returns {Promise<{ cancelSkeleton():void }>} 控制对象
 */
function prepareForNewContent() {
    return new Promise(resolve => {
        // 1. 先清空内容，避免滚动时看到旧内容移动
        safeSetInnerHTML(elements.contentGrid, '');
        
        // 2. 立即滚动到顶部（此时内容已清空，看不到滚动）
        if (window.scrollY > 0) {
            window.scrollTo(0, 0);
        }
        
        // 3. 清除目标路径的保存位置，避免恢复到旧位置
        // 但不清除以下情况：
        // - 当前路径的位置（用于modal返回）
        // - 上级路径的位置（用于返回上级目录）
        const { cleanHashString, newDecodedPath } = sanitizeHash();
        const navigation = buildNavigationContext(cleanHashString, newDecodedPath);
        if (navigation && navigation.pathOnly && navigation.pathOnly !== state.currentBrowsePath) {
            // 判断是否是返回上级目录
            const isGoingBack = state.currentBrowsePath && 
                               state.currentBrowsePath.startsWith(navigation.pathOnly + '/');
            
            // 只有前进到新页面时才清除，返回上级时保留
            if (!isGoingBack) {
                const newScrollPositions = new Map(state.scrollPositions);
                newScrollPositions.delete(navigation.pathOnly);
                state.scrollPositions = newScrollPositions;
            }
        }
        
        // 4. 立即显示topbar，避免展出动画
        const topbar = safeGetElementById('topbar');
        if (topbar) {
            safeClassList(topbar, 'remove', 'topbar--hidden');
            safeClassList(topbar, 'remove', 'topbar--condensed');
        }
        
        const scroller = state.virtualScroller;
        if (scroller) {
            scroller.destroy();
            state.update('virtualScroller', null);
        }
        // 清理预加载缓存
        if (typeof window !== 'undefined' && window.clearPrefetchCache) {
            window.clearPrefetchCache();
        }

        let loaderShown = false;
        let dataArrived = false;
        let loaderTimer = null;
        
        // 延迟 600ms 显示加载器（局域网不显示，3G网络必定显示）
        loaderTimer = setTimeout(() => {
            if (!loaderShown && !dataArrived) {
                showMinimalLoader({ text: '加载中' });
                loaderShown = true;
            }
        }, 600);

        // 立即返回控制对象
        const controlObject = {
            cancelSkeleton: () => {
                dataArrived = true;
                
                if (loaderTimer) {
                    clearTimeout(loaderTimer);
                    loaderTimer = null;
                }
                
                if (loaderShown) {
                    const loader = safeGetElementById('minimal-loader');
                    if (loader && loader.parentNode) {
                        loader.remove();
                    }
                    loaderShown = false;
                }
            }
        };
        
        // 立即resolve，让streamPath能马上调用cancelSkeleton
        resolve(controlObject);
        
        // 后台继续执行清理工作
        setManagedTimeout(() => {
            safeSetStyle(elements.contentGrid, 'height', 'auto');
            // 隐藏加载器
            if (elements.infiniteScrollLoader) {
                safeClassList(elements.infiniteScrollLoader, 'remove', 'visible');
            }
            // 仅路径切换才清空图片状态
            const currentPath = state.currentBrowsePath;
            const isSamePathReload = currentPath && currentPath === getPathOnlyFromHash();
            if (!isSamePathReload) {
                state.update('currentPhotos', []);
            }
        }, 100, 'content-transition');
    });
}

/**
 * 新内容渲染完成后，处理懒加载与滚动状态恢复。
 * @param {string} pathKey
 */
function finalizeNewContent(pathKey) {
    if (!state.virtualScroller) {
        setupLazyLoading();
        let stateRestored = false;
        if (window.restorePageLazyState) {
            stateRestored = window.restorePageLazyState(pathKey);
        }
        if (!stateRestored && safeClassList(elements.contentGrid, 'contains', 'masonry-mode')) {
            applyMasonryLayout();
        }
    }
    sortAlbumsByViewed();
    state.update('currentColumnCount', getMasonryColumns());
    preloadVisibleImages();
    const scrollPositions = state.scrollPositions;
    const scrollY = scrollPositions.get(pathKey);
    if (scrollY && scrollY > 0) {
        window.scrollTo({ top: scrollY, behavior: 'instant' });
        const newScrollPositions = new Map(scrollPositions);
        newScrollPositions.delete(pathKey);
        state.scrollPositions = newScrollPositions;
    }
    safeSetStyle(elements.contentGrid, 'minHeight', '');
    state.update('isInitialLoad', false);
}

/**
 * 预加载首屏与可视区域图片，加速首屏体验与布局稳定性。
 */
function preloadVisibleImages() {
    if (!elements.contentGrid) return;
    const viewportHeight = window.innerHeight;
    const lazyImages = Array.from(elements.contentGrid.querySelectorAll('.lazy-image:not(.loaded)'));
    if (lazyImages.length === 0) return;
    // 可见范围判断
    const visibleImages = lazyImages.filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.top < viewportHeight * 2.5;
    });
    // 优先前20张图片
    const priorityImages = visibleImages.slice(0, 20);
    if (priorityImages.length > 0) {
        import('../features/gallery/lazyload.js').then(lazyloadModule => {
            priorityImages.forEach(img => {
                if (typeof lazyloadModule.enqueueLazyImage === 'function') {
                    lazyloadModule.enqueueLazyImage(img, {
                        rect: img.getBoundingClientRect(),
                        priority: 'high'
                    });
                }
            });
        }).catch(error => {
            routerLogger.warn('预加载图片失败', error);
        });
    }
}

/**
 * 保存当前滚动位置到state和sessionStorage。
 */
function saveCurrentScrollPosition() {
    const key = state.currentBrowsePath;
    if (typeof key === 'string' && key.length > 0) {
        const newScrollPositions = new Map(state.scrollPositions);
        newScrollPositions.set(key, window.scrollY);
        state.scrollPositions = newScrollPositions;
        try {
            const obj = Object.fromEntries(state.scrollPositions);
            const entries = Object.entries(obj);
            const limited = entries.slice(-200);
            sessionStorage.setItem('sg_scroll_positions', JSON.stringify(Object.fromEntries(limited)));
            sessionStorage.setItem('sg_pre_search_hash', state.preSearchHash || '#/');
        } catch {}
    }
}

// 页面可见性变化时自动保存当前滚动位置
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        saveCurrentScrollPosition();
    }
});

// 页面卸载前自动保存当前滚动位置
window.addEventListener('beforeunload', () => {
    saveCurrentScrollPosition();
});

/**
 * 上传并记录某路径被浏览的行为，支持离线同步。
 * @param {string} path
 */
async function onAlbumViewed(path) {
    if (!path) return;
    await saveViewed(path, Date.now(), navigator.onLine);
    if (navigator.onLine) {
        try {
            await postViewed(path);
            await markAsSynced(path);
        } catch (e) {}
    }
}

// 监听网络恢复后自动同步本地未上传的浏览记录
window.addEventListener('online', async () => {
    const unsynced = await getUnsyncedViewed();
    for (const record of unsynced) {
        try {
            await postViewed(record.path);
            await markAsSynced(record.path);
        } catch (e) {}
    }
});
