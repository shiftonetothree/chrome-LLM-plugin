/* 
    This is a isolation content script can running without 
    content.js
*/

// ==UserScript==
// @name         Awesome Video List 优化时间轴
// @namespace    http://tampermonkey.net/
// @version      0.0.1
// @description  跨视频片段playlist + 分享码同步
// @author       You
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-end
// ==/UserScript==

// TODO: Chrome 扩展环境不提供 GM_* API，后续需逐项替换为扩展可用的存储、网络和菜单能力。
// TODO: 初步验证加载时，先确认脚本仅在上述 Bilibili URL 注入并成功创建 window.AVL。

const CONFIG = {
    maxFragments: 200,
    playlistStorageKey: 'avl_current_playlist',
    playlistIndexKey: 'avl_playlist_index'
};

/* 
    Chrome Extension does not have API like 
    GM_xmlhttpRequest, GM_setValue, GM_getValue, GM_registerMenuCommand
    So we make a Shim
*/
(() => {
    const STORAGE_PREFIX = 'avl_gm_';

    if (typeof globalThis.GM_getValue !== 'function') {
        globalThis.GM_getValue = (key, defaultValue) => {
            try {
                const value = localStorage.getItem(STORAGE_PREFIX + key);
                return value === null ? defaultValue : value;
            } catch (error) {
                console.debug('[AVL] GM_getValue 兼容层读取失败:', key, error);
                return defaultValue;
            }
        };
    }

    if (typeof globalThis.GM_setValue !== 'function') {
        globalThis.GM_setValue = (key, value) => {
            try {
                localStorage.setItem(STORAGE_PREFIX + key, String(value));
            } catch (error) {
                console.debug('[AVL] GM_setValue 兼容层写入失败:', key, error);
            }
        };
    }
})();

class DataManager {
    constructor() {
        this.storageKey = 'awesome_video_list';
        console.log('[AVL] DataManager 初始化');
        this.data = this.load();
        this.currentPlaylist = this.loadCurrentPlaylist();
        console.log('[AVL] DataManager 初始化完成，数据加载完成');
    }

    load() {
        try {
            console.log('[AVL] DataManager.load 开始加载数据');
            // TODO: 将 GM_getValue 迁移为 chrome.storage.local 或其他扩展存储方案。
            const data = JSON.parse(GM_getValue(this.storageKey, '{}'));
            console.log('[AVL] DataManager.load 数据加载完成，数据项数:', Object.keys(data).length);
            return data;
        } catch (e) {
            console.error('[AVL] DataManager.load 加载数据失败:', e);
            return {};
        }
    }

    save() {
        try {
            console.log('[AVL] DataManager.save 保存数据，数据项数:', Object.keys(this.data).length);
            // TODO: 将 GM_setValue 迁移为扩展存储，并确认异步保存不会影响现有调用流程。
            GM_setValue(this.storageKey, JSON.stringify(this.data));
            console.log('[AVL] DataManager.save 数据保存完成');
        } catch (e) {
            console.error('[AVL] DataManager.save 保存数据失败，可能是 GM_setValue 不可用或存储调用异常:', e);
        }
    }

    loadCurrentPlaylist() {
        try {
            console.log('[AVL] DataManager.loadCurrentPlaylist 开始加载播放列表');
            // TODO: 播放列表和索引也需要统一迁移到扩展存储，避免数据分散在不同存储空间。
            const playlist = JSON.parse(GM_getValue(CONFIG.playlistStorageKey, '[]'));
            console.log('[AVL] DataManager.loadCurrentPlaylist 播放列表加载完成，片段数:', playlist.length);
            return playlist;
        } catch (e) {
            console.error('[AVL] DataManager.loadCurrentPlaylist 加载播放列表失败:', e);
            return [];
        }
    }

    saveCurrentPlaylist() {
        try {
            console.log('[AVL] DataManager.saveCurrentPlaylist 保存播放列表，片段数:', this.currentPlaylist.length);
            // TODO: 将播放列表保存改为扩展存储，并检查相关调用方对异步结果的处理。
            GM_setValue(CONFIG.playlistStorageKey, JSON.stringify(this.currentPlaylist));
            console.log('[AVL] DataManager.saveCurrentPlaylist 播放列表保存完成');
        } catch (e) {
            console.error('[AVL] DataManager.saveCurrentPlaylist 保存播放列表失败:', e);
        }
    }

    getFragments(bvid) {
        return this.data[bvid]?.fragments || [];
    }

    getFragment(bvid, fragmentId) {
        return this.getFragments(bvid).find(f => f.id === fragmentId);
    }

    addFragment(bvid, videoTitle, fragment) {
        if (!this.data[bvid]) {
            this.data[bvid] = {
                bvid: bvid,
                title: videoTitle,
                url: `https://bilibili.com/video/${bvid}`,
                fragments: []
            };
        }

        const exists = this.data[bvid].fragments.some(f =>
            Math.abs(f.start - fragment.start) < 3 &&
            Math.abs(f.end - fragment.end) < 3
        );

        if (exists) return false;

        fragment.id = Date.now().toString(36) + Math.random().toString(36).substr(2);
        fragment.createdAt = new Date().toISOString();

        this.data[bvid].fragments.push(fragment);
        this.data[bvid].fragments.sort((a, b) => a.start - b.start);
        this.save();
        return true;
    }

    deleteFragment(bvid, fragmentId) {
        if (!this.data[bvid]) return;
        this.data[bvid].fragments = this.data[bvid].fragments.filter(f => f.id !== fragmentId);
        this.save();
        this.removeFromPlaylist(bvid, fragmentId);
    }

    addToPlaylist(bvid, fragmentId) {
        const fragment = this.getFragment(bvid, fragmentId);
        const video = this.data[bvid];
        if (!fragment || !video) return false;

        const exists = this.currentPlaylist.some(item =>
            item.bvid === bvid && item.fragmentId === fragmentId
        );
        if (exists) return false;

        this.currentPlaylist.push({
            bvid: bvid,
            fragmentId: fragmentId,
            title: fragment.title,
            videoTitle: video.title,
            start: fragment.start,
            end: fragment.end,
            tags: fragment.tags || []
        });

        this.saveCurrentPlaylist();
        return true;
    }

    removeFromPlaylist(bvid, fragmentId) {
        const idx = this.currentPlaylist.findIndex(item =>
            item.bvid === bvid && item.fragmentId === fragmentId
        );
        if (idx > -1) {
            this.currentPlaylist.splice(idx, 1);
            this.adjustIndexAfterRemove(idx);
            this.saveCurrentPlaylist();
        }
    }

    removeFromPlaylistByIndex(index) {
        if (index >= 0 && index < this.currentPlaylist.length) {
            this.currentPlaylist.splice(index, 1);
            this.adjustIndexAfterRemove(index);
            this.saveCurrentPlaylist();
        }
    }

    adjustIndexAfterRemove(removedIndex) {
        try {
            // TODO: 播放列表索引读写也要迁移，并确认迁移后索引在页面切换时仍保持一致。
            const currentIdx = parseInt(GM_getValue(CONFIG.playlistIndexKey, '0')) || 0;
            if (removedIndex < currentIdx) {
                GM_setValue(CONFIG.playlistIndexKey, (currentIdx - 1).toString());
            } else if (removedIndex === currentIdx && currentIdx >= this.currentPlaylist.length) {
                GM_setValue(CONFIG.playlistIndexKey, Math.max(0, this.currentPlaylist.length - 1).toString());
            }
        } catch (e) {
            console.error('[AVL] DataManager.adjustIndexAfterRemove 更新播放列表索引失败:', e);
        }
    }

    movePlaylistItem(index, direction) {
        try {
            const newIndex = index + direction;
            if (newIndex < 0 || newIndex >= this.currentPlaylist.length) return false;

            [this.currentPlaylist[index], this.currentPlaylist[newIndex]] =
                [this.currentPlaylist[newIndex], this.currentPlaylist[index]];

            const currentIdx = parseInt(GM_getValue(CONFIG.playlistIndexKey, '0')) || 0;
            if (index === currentIdx) {
                GM_setValue(CONFIG.playlistIndexKey, newIndex.toString());
            } else if (newIndex === currentIdx) {
                GM_setValue(CONFIG.playlistIndexKey, index.toString());
            }

            this.saveCurrentPlaylist();
            return true;
        } catch (e) {
            console.error('[AVL] DataManager.movePlaylistItem 移动播放列表项目失败:', e);
            return false;
        }
    }

    clearPlaylist() {
        try {
            this.currentPlaylist = [];
            GM_setValue(CONFIG.playlistIndexKey, '0');
            this.saveCurrentPlaylist();
        } catch (e) {
            console.error('[AVL] DataManager.clearPlaylist 清空播放列表失败:', e);
        }
    }

    getCurrentPlaylistIndex() {
        try {
            return parseInt(GM_getValue(CONFIG.playlistIndexKey, '0')) || 0;
        } catch (e) {
            console.error('[AVL] DataManager.getCurrentPlaylistIndex 读取播放列表索引失败:', e);
            return 0;
        }
    }

    setCurrentPlaylistIndex(index) {
        try {
            GM_setValue(CONFIG.playlistIndexKey, index.toString());
        } catch (e) {
            console.error('[AVL] DataManager.setCurrentPlaylistIndex 保存播放列表索引失败:', e);
        }
    }

    exportCompactData() {
        const compactData = {};
        Object.entries(this.data).forEach(([bvid, video]) => {
            compactData[bvid] = {
                t: video.title,
                f: video.fragments.map(f => [
                    Math.floor(f.start),
                    Math.floor(f.end),
                    f.title,
                    (f.tags || []).join(','),
                    f.note || ''
                ])
            };
        });

        const exportObj = {
            v: 1,
            t: Date.now(),
            data: compactData,
            playlist: this.currentPlaylist.map(p => [p.bvid, p.fragmentId])
        };

        return exportObj;
    }

    generateShareCode() {
        const data = this.exportCompactData();
        const json = JSON.stringify(data);
        const base64 = btoa(unescape(encodeURIComponent(json)));
        return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    async uploadToPastebinService() {
        const code = this.generateShareCode();

        return new Promise((resolve, reject) => {
            // 使用标准的 FormData（浏览器原生 multipart/form-data）
            const formData = new FormData();
            formData.append('content', code);
            formData.append('syntax', 'text');
            formData.append('expiry_days', '7'); // 7天后过期

            // TODO: 将 GM_xmlhttpRequest 迁移为 fetch，并确认 manifest 的网络权限和跨域行为。
            try {
                GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://dpaste.com/api/v2/',
                data: formData,
                headers: {
                    'Accept': 'text/plain'
                },
                responseType: 'text',
                onload: (response) => {
                    console.log('[AVL] dpaste 响应状态:', response.status);
                    console.log('[AVL] dpaste 返回内容:', response.responseText);

                    if (response.status === 200 || response.status === 201) {
                        const url = response.responseText.trim();
                        // 验证返回的是 URL 格式
                        if (url.startsWith('https://dpaste.com/')) {
                            resolve(url);
                        } else {
                            reject(new Error('dpaste 返回格式异常: ' + url.substring(0, 100)));
                        }
                    } else {
                        reject(new Error(`dpaste HTTP ${response.status}: ${response.responseText}`));
                    }
                },
                onerror: (err) => {
                    console.error('[AVL] dpaste 网络错误:', err);
                    reject(new Error('无法连接到 dpaste.com，请检查网络或 CSP 限制'));
                },
                ontimeout: () => {
                    reject(new Error('dpaste 请求超时（15秒）'));
                },
                    timeout: 15000
                });
            } catch (e) {
                console.error('[AVL] uploadToPastebinService 发起 dpaste 上传请求失败:', e);
                reject(e);
            }
        });
    }

    // 从 dpaste 链接获取原始分享码内容
    async fetchFromDpaste(url) {
        // 提取 key，支持 https://dpaste.com/223UMASZF 或 223UMASZF
        let key = url.trim();
        if (key.includes('dpaste.com/')) {
            key = key.split('dpaste.com/').pop().split('/')[0].split('?')[0];
        }

        // 确保是合法 key（通常是字母数字组合）
        if (!key || !/^[A-Z0-9]+$/i.test(key)) {
            throw new Error('无效的 dpaste 链接格式');
        }

        const rawUrl = `https://dpaste.com/${key}.txt`;
        console.log('[AVL] 正在从 dpaste 获取:', rawUrl);

        return new Promise((resolve, reject) => {
            // TODO: 将 GM_xmlhttpRequest 迁移为 fetch，并补充网络失败、超时和权限错误处理。
            try {
                GM_xmlhttpRequest({
                method: 'GET',
                url: rawUrl,
                headers: {
                    'Accept': 'text/plain'
                },
                responseType: 'text',
                onload: (response) => {
                    if (response.status === 200) {
                        resolve(response.responseText);
                    } else if (response.status === 404) {
                        reject(new Error('该 dpaste 链接已过期或被删除'));
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: (err) => {
                    reject(new Error('网络请求失败，无法获取分享内容'));
                },
                    timeout: 10000
                });
            } catch (e) {
                console.error('[AVL] fetchFromDpaste 发起 dpaste 下载请求失败:', e);
                reject(e);
            }
        });
    }

    parseShareCode(code) {
        try {
            code = code.trim().replace(/\s/g, '');
            let base64 = code.replace(/-/g, '+').replace(/_/g, '/');
            while (base64.length % 4) base64 += '=';
            const json = decodeURIComponent(escape(atob(base64)));
            return JSON.parse(json);
        } catch (e) {
            console.error('[AVL] 分享码解析失败:', e);
            return null;
        }
    }

    importFromShareCode(shareCode) {
        const imported = this.parseShareCode(shareCode);
        if (!imported || !imported.data) return { success: false, error: '无效的分享码' };

        let addedVideos = 0;
        let addedFragments = 0;
        let skippedFragments = 0;

        Object.entries(imported.data).forEach(([bvid, video]) => {
            if (!this.data[bvid]) {
                this.data[bvid] = {
                    bvid: bvid,
                    title: video.t,
                    url: `https://bilibili.com/video/${bvid}`,
                    fragments: []
                };
                addedVideos++;
            }

            video.f.forEach(fData => {
                const [start, end, title, tagsStr, note] = fData;
                const tags = tagsStr ? tagsStr.split(',') : [];

                const exists = this.data[bvid].fragments.some(existing =>
                    Math.abs(existing.start - start) < 3 &&
                    Math.abs(existing.end - end) < 3
                );

                if (!exists) {
                    this.data[bvid].fragments.push({
                        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
                        start: start,
                        end: end,
                        title: title,
                        tags: tags,
                        note: note,
                        createdAt: new Date().toISOString()
                    });
                    addedFragments++;
                } else {
                    skippedFragments++;
                }
            });

            this.data[bvid].fragments.sort((a, b) => a.start - b.start);
        });

        let addedPlaylist = 0;
        if (imported.playlist && Array.isArray(imported.playlist)) {
            imported.playlist.forEach(([bvid, fragmentId]) => {
                const exists = this.currentPlaylist.some(p =>
                    p.bvid === bvid && p.fragmentId === fragmentId
                );

                if (!exists) {
                    const video = this.data[bvid];
                    const fragment = video?.fragments.find(f => f.id === fragmentId);

                    if (video && fragment) {
                        this.currentPlaylist.push({
                            bvid: bvid,
                            fragmentId: fragmentId,
                            title: fragment.title,
                            videoTitle: video.title,
                            start: fragment.start,
                            end: fragment.end,
                            tags: fragment.tags || []
                        });
                        addedPlaylist++;
                    }
                }
            });
        }

        this.save();
        this.saveCurrentPlaylist();

        return {
            success: true,
            stats: { addedVideos, addedFragments, skippedFragments, addedPlaylist }
        };
    }

    formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }
}

class ProgressBarPainter {
    // Video Progress Bar render  
    constructor(dataManager) {
        this.dm = dataManager;
        this.overlay = null;
        this.currentBvid = '';
        this.currentDuration = 0;
        this.init();
    }

    init() {
        try {
            // TODO: 初步运行时确认播放器 DOM 尚未准备好时，观察器仍能完成绑定且不会重复绑定。
            this.observeVideoForDuration();
            this.observeUrlChange();
        } catch (e) {
            console.error('[AVL] ProgressBarPainter.init 初始化播放器观察逻辑失败:', e);
        }
    }

    observeVideoForDuration() {
        const tryAttach = () => {
            const video = document.querySelector('video');
            if (video && !video._avl_duration_attached) {
                video._avl_duration_attached = true;
                video.addEventListener('loadedmetadata', () => {
                    this.currentDuration = video.duration || 0;
                    this.renderMarkers();
                });
                if (video.duration) {
                    this.currentDuration = video.duration;
                    this.renderMarkers();
                }
            }
        };

        if (tryAttach()) return;
        const observer = new MutationObserver(() => {
            if (tryAttach()) observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 15000);
    }

    observeUrlChange() {
        let lastBvid = this.getBvid();
        const check = () => {
            const current = this.getBvid();
            if (current !== lastBvid) {
                lastBvid = current;
                this.currentBvid = current;
                this.currentDuration = 0;
                this.removeOverlay();
                setTimeout(() => this.observeVideoForDuration(), 500);
            }
        };
        setInterval(check, 800);
    }

    getBvid() {
        const match = window.location.pathname.match(/BV[0-9a-zA-Z]+/);
        return match ? match[0] : '';
    }

    getProgressBarContainer() {
        return document.querySelector('.bpx-player-progress-wrap') ||
            document.querySelector('.bpx-player-control-wrap') ||
            document.querySelector('.player-wrap') ||
            document.querySelector('.bpx-player-container');
    }

    createOverlay() {
        const container = this.getProgressBarContainer();
        if (!container) return null;

        if (this.overlay && document.body.contains(this.overlay)) {
            return this.overlay;
        }

        const overlay = document.createElement('div');
        overlay.id = 'avl-progress-overlay';
        overlay.style.cssText = `
                position: absolute;
                left: 0;
                right: 0;
                bottom: 0;
                height: 4px;
                z-index: 1000;
                pointer-events: none;
                transition: height 0.15s;
            `;

        container.addEventListener('mouseenter', () => {
            overlay.style.height = '8px';
        });
        container.addEventListener('mouseleave', () => {
            overlay.style.height = '4px';
        });

        const progressWrap = container.querySelector('.bpx-player-progress-wrap');
        if (progressWrap && progressWrap.parentNode === container) {
            container.insertBefore(overlay, progressWrap.nextSibling);
        } else {
            container.appendChild(overlay);
        }

        this.overlay = overlay;
        return overlay;
    }

    removeOverlay() {
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
    }

    renderMarkers() {
        const bvid = this.getBvid();
        if (!bvid) return;
        this.currentBvid = bvid;

        const fragments = this.dm.getFragments(bvid);
        if (fragments.length === 0) {
            this.removeOverlay();
            return;
        }

        const duration = this.currentDuration;
        if (!duration || duration <= 0) return;

        const overlay = this.createOverlay();
        if (!overlay) return;

        overlay.innerHTML = '';

        fragments.forEach(f => {
            const left = (f.start / duration) * 100;
            const width = ((f.end - f.start) / duration) * 100;

            const bar = document.createElement('div');
            bar.style.cssText = `
                    position: absolute;
                    left: ${left}%;
                    width: ${width}%;
                    top: 0;
                    bottom: 0;
                    background: #00a1d6;
                    opacity: 0.85;
                    border-radius: 2px;
                    pointer-events: auto;
                    cursor: pointer;
                    transition: opacity 0.15s, background 0.15s;
                `;

            bar.addEventListener('mouseenter', () => {
                bar.style.background = '#00d4ff';
                bar.style.opacity = '1';
                this.showTooltip(bar, f);
            });
            bar.addEventListener('mouseleave', () => {
                bar.style.background = '#00a1d6';
                bar.style.opacity = '0.85';
                this.hideTooltip();
            });

            bar.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const video = document.querySelector('video');
                if (video) {
                    video.currentTime = f.start;
                    if (video.paused) video.play();
                }
            });

            overlay.appendChild(bar);
        });
    }

    showTooltip(targetEl, fragment) {
        let tooltip = document.getElementById('avl-progress-tooltip');
        if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'avl-progress-tooltip';
            tooltip.style.cssText = `
                    position: fixed;
                    background: rgba(0,0,0,0.9);
                    color: #fff;
                    padding: 6px 10px;
                    border-radius: 6px;
                    font-size: 12px;
                    z-index: 10001;
                    pointer-events: none;
                    white-space: nowrap;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                    border: 1px solid rgba(255,255,255,0.1);
                `;
            document.body.appendChild(tooltip);
        }

        const rect = targetEl.getBoundingClientRect();
        tooltip.innerHTML = `
                <div style="font-weight:600;color:#00a1d6;margin-bottom:2px;">${this.escapeHtml(fragment.title)}</div>
                <div style="color:#aaa;font-size:11px;">${this.formatTime(fragment.start)} → ${this.formatTime(fragment.end)}</div>
            `;
        tooltip.style.display = 'block';
        tooltip.style.left = (rect.left + rect.width / 2 - tooltip.offsetWidth / 2) + 'px';
        tooltip.style.top = (rect.top - tooltip.offsetHeight - 8) + 'px';
    }

    hideTooltip() {
        const tooltip = document.getElementById('avl-progress-tooltip');
        if (tooltip) tooltip.style.display = 'none';
    }

    refresh() {
        this.renderMarkers();
    }

    formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        const pad = (n) => n.toString().padStart(2, '0');
        if (h > 0) {
            return `${h}:${pad(m)}:${pad(s)}.${ms.toString().padStart(3, '0')}`;
        }
        return `${pad(m)}:${pad(s)}.${ms.toString().padStart(3, '0')}`;
    }

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

class PlaylistEngine {
    constructor(dataManager, uiManager) {
        console.log('[AVL] PlaylistEngine 初始化');
        this.dm = dataManager;
        this.ui = uiManager;
        this.isNavigating = false;
        this.videoEndHandler = null;
        this.currentFragmentEndTime = null;
        this.attachVideoEndListener();
        console.log('[AVL] PlaylistEngine 初始化完成');
    }

    getCurrentItem() {
        const idx = this.dm.getCurrentPlaylistIndex();
        return this.dm.currentPlaylist[idx];
    }

    peekNext() {
        const idx = this.dm.getCurrentPlaylistIndex();
        return this.dm.currentPlaylist[idx + 1];
    }

    async playNext() {
        console.log('[AVL] PlaylistEngine.playNext 开始执行');
        if (this.isNavigating) {
            console.log('[AVL] PlaylistEngine.playNext 正在导航中，跳过执行');
            return;
        }

        const currentIdx = this.dm.getCurrentPlaylistIndex();
        const nextIdx = currentIdx + 1;
        console.log('[AVL] PlaylistEngine.playNext 当前索引:', currentIdx, '下一个索引:', nextIdx);

        if (nextIdx >= this.dm.currentPlaylist.length) {
            console.log('[AVL] PlaylistEngine.playNext 播放列表已完成');
            this.ui.showToast("🎉 播放列表已完成！");
            return;
        }

        const nextItem = this.dm.currentPlaylist[nextIdx];
        const currentBvid = this.ui.getBvid();
        console.log('[AVL] PlaylistEngine.playNext 下一项:', nextItem, '当前BVID:', currentBvid);

        this.isNavigating = true;

        try {
            if (nextItem.bvid !== currentBvid) {
                console.log('[AVL] PlaylistEngine.playNext 需要跳转到不同视频:', nextItem.bvid);
                this.ui.showToast(`正在跳转到: ${nextItem.videoTitle}...`);
                await this.navigateToVideo(nextItem.bvid, nextItem.start);
                this.dm.setCurrentPlaylistIndex(nextIdx);
            } else {
                console.log('[AVL] PlaylistEngine.playNext 同一视频内跳转到:', nextItem.start);
                this.ui.seekTo(nextItem.start);
                this.dm.setCurrentPlaylistIndex(nextIdx);
                this.ui.renderPlaylist();
            }
        } finally {
            this.isNavigating = false;
            console.log('[AVL] PlaylistEngine.playNext 执行完成');
        }
    }

    async jumpToIndex(index) {
        console.log('[AVL] PlaylistEngine.jumpToIndex 开始执行，索引:', index);
        if (index < 0 || index >= this.dm.currentPlaylist.length) {
            console.log('[AVL] PlaylistEngine.jumpToIndex 索引无效，跳过执行');
            return;
        }

        const item = this.dm.currentPlaylist[index];
        const currentBvid = this.ui.getBvid();
        console.log('[AVL] PlaylistEngine.jumpToIndex 目标项:', item, '当前BVID:', currentBvid);

        if (item.bvid !== currentBvid) {
            console.log('[AVL] PlaylistEngine.jumpToIndex 需要跳转到不同视频:', item.bvid);
            this.isNavigating = true;
            this.ui.showToast(`正在加载: ${item.videoTitle}...`);
            await this.navigateToVideo(item.bvid, item.start);
            this.dm.setCurrentPlaylistIndex(index);
            this.isNavigating = false;
        } else {
            console.log('[AVL] PlaylistEngine.jumpToIndex 同一视频内跳转到:', item.start);
            this.ui.seekTo(item.start);
            this.dm.setCurrentPlaylistIndex(index);
        }

        this.ui.renderPlaylist();
        console.log('[AVL] PlaylistEngine.jumpToIndex 执行完成');
    }

    navigateToVideo(bvid, startTime) {
        console.log('[AVL] PlaylistEngine.navigateToVideo 开始执行，BVID:', bvid, '开始时间:', startTime);
        return new Promise((resolve) => {
            const url = `https://www.bilibili.com/video/${bvid}?t=${Math.floor(startTime)}`;
            console.log('[AVL] PlaylistEngine.navigateToVideo 设置恢复播放会话存储');
            sessionStorage.setItem('avl_resume_playlist', JSON.stringify({
                index: this.dm.getCurrentPlaylistIndex(),
                time: startTime,
                timestamp: Date.now()
            }));

            let checked = false;
            const checkVideoLoaded = () => {
                if (checked) {
                    console.log('[AVL] PlaylistEngine.navigateToVideo 视频已检查，跳过重复检查');
                    return;
                }
                const newBvid = this.ui.getBvid();
                console.log('[AVL] PlaylistEngine.navigateToVideo 检查视频加载状态，当前BVID:', newBvid);
                if (newBvid === bvid) {
                    checked = true;
                    console.log('[AVL] PlaylistEngine.navigateToVideo 目标视频已加载，等待播放器准备');
                    setTimeout(() => {
                        const video = document.querySelector('video');
                        if (video && video.readyState >= 1) {
                            console.log('[AVL] PlaylistEngine.navigateToVideo 视频已准备就绪，跳转到指定时间');
                            this.ui.seekTo(startTime);
                            resolve();
                        } else {
                            console.log('[AVL] PlaylistEngine.navigateToVideo 视频未准备就绪，开始轮询检查');
                            const wait = setInterval(() => {
                                const v = document.querySelector('video');
                                if (v && v.readyState >= 1) {
                                    console.log('[AVL] PlaylistEngine.navigateToVideo 轮询检查到视频已准备就绪，跳转到指定时间');
                                    clearInterval(wait);
                                    this.ui.seekTo(startTime);
                                    resolve();
                                }
                            }, 100);
                            setTimeout(() => {
                                console.log('[AVL] PlaylistEngine.navigateToVideo 轮询检查超时，强制resolve');
                                clearInterval(wait);
                                resolve();
                            }, 5000);
                        }
                    }, 800);
                    return true;
                }
                return false;
            };

            if (this.ui.getBvid() === bvid) {
                console.log('[AVL] PlaylistEngine.navigateToVideo 已在目标视频页面，直接跳转到指定时间');
                this.ui.seekTo(startTime);
                resolve();
                return;
            }

            console.log('[AVL] PlaylistEngine.navigateToVideo 开始观察DOM变化以检测页面加载');
            const observer = new MutationObserver(() => {
                if (checkVideoLoaded()) {
                    console.log('[AVL] PlaylistEngine.navigateToVideo 检测到视频加载完成，断开观察器');
                    observer.disconnect();
                }
            });
            observer.observe(document.body, { subtree: true, childList: true });

            console.log('[AVL] PlaylistEngine.navigateToVideo 跳转到URL:', url);
            window.location.href = url;
            setTimeout(() => {
                console.log('[AVL] PlaylistEngine.navigateToVideo 导航超时，断开观察器并resolve');
                observer.disconnect();
                resolve();
            }, 6000);
        });
    }

    attachVideoEndListener() {
        // TODO: 确认 Bilibili SPA 切换视频后旧监听器会被清理，并只绑定到当前 video 元素。
        const checkAndAttach = () => {
            const video = document.querySelector('video');
            if (video && !this.videoEndHandler) {
                this.videoEndHandler = () => {
                    // 检查当前播放时间是否已达到当前片段的结束时间
                    const currentTime = video.currentTime;
                    const currentItem = this.getCurrentItem();

                    if (currentItem && currentTime >= currentItem.end) {
                        console.log('[AVL] 片段播放结束，自动播放下一个片段');
                        this.playNext();
                    }
                };
                video.addEventListener('timeupdate', this.videoEndHandler);
                console.log('[AVL] 已附加视频时间更新事件监听器');
            }
        };

        checkAndAttach();
        setInterval(checkAndAttach, 1000);
    }

    playPrev() {
        console.log('[AVL] PlaylistEngine.playPrev 开始执行');
        const idx = this.dm.getCurrentPlaylistIndex();
        console.log('[AVL] PlaylistEngine.playPrev 当前索引:', idx);
        if (idx > 0) {
            console.log('[AVL] PlaylistEngine.playPrev 跳转到上一个片段，索引:', idx - 1);
            this.jumpToIndex(idx - 1);
        } else {
            console.log('[AVL] PlaylistEngine.playPrev 当前已是第一个片段');
            this.ui.showToast("已经是第一个片段");
        }
    }
}

class UIManager {
    constructor(dataManager) {
        console.log('[AVL] UIManager 初始化');
        this.dm = dataManager;
        this.engine = new PlaylistEngine(dataManager, this);
        this.tempFragment = null;
        this.currentTab = 'mark';
        this.init();
        console.log('[AVL] UIManager 初始化完成');
    }

    init() {
        try {
            console.log('[AVL] UIManager.init 开始执行');
            // TODO: 初步加载验证应确认 document.body、document.head 和 Bilibili 播放器均可用。
            this.injectStyles();
            this.createFloatingButton();
            this.painter = new ProgressBarPainter(this.dm);

            this.observeVideoChange();
            this.checkResumeFromNavigation();
            console.log('[AVL] UIManager.init 执行完成');
        } catch (e) {
            console.error('[AVL] UIManager.init 初始化界面或播放器功能失败:', e);
        }
    }

    checkResumeFromNavigation() {
        console.log('[AVL] UIManager.checkResumeFromNavigation 开始检查是否需要恢复播放');
        const resume = sessionStorage.getItem('avl_resume_playlist');
        if (resume) {
            console.log('[AVL] UIManager.checkResumeFromNavigation 找到恢复数据');
            const data = JSON.parse(resume);
            if (Date.now() - data.timestamp < 30000) {
                console.log('[AVL] UIManager.checkResumeFromNavigation 恢复数据有效，设置播放列表索引:', data.index);
                this.dm.setCurrentPlaylistIndex(data.index);
                setTimeout(() => {
                    this.seekTo(data.time);
                    this.showToast(`已恢复播放位置 #${data.index + 1}`);
                }, 1000);
            } else {
                console.log('[AVL] UIManager.checkResumeFromNavigation 恢复数据已过期');
            }
            sessionStorage.removeItem('avl_resume_playlist');
        } else {
            console.log('[AVL] UIManager.checkResumeFromNavigation 未找到恢复数据');
        }
    }

    injectStyles() {
        console.log('[AVL] UIManager.injectStyles 开始注入样式');
        const css = `
                .avl-panel { position: fixed; right: 20px; top: 80px; width: 380px; max-height: 85vh; background: rgba(255, 255, 255, 0.98); backdrop-filter: blur(12px); border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.2); z-index: 99999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; color: #333; overflow: hidden; display: none; flex-direction: column; border: 1px solid rgba(0,0,0,0.08); }
                .avl-header { padding: 16px 20px; background: linear-gradient(135deg, #00a1d6, #00b5e5); color: white; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
                .avl-tabs { display: flex; background: rgba(255,255,255,0.1); margin-top: 12px; border-radius: 8px; overflow: hidden; }
                .avl-tab { flex: 1; padding: 8px; text-align: center; cursor: pointer; font-size: 13px; opacity: 0.8; transition: all 0.2s; }
                .avl-tab.active { background: rgba(255,255,255,0.2); opacity: 1; font-weight: 600; }
                .avl-close { cursor: pointer; opacity: 0.8; font-size: 20px; margin-left: 12px; }
                .avl-close:hover { opacity: 1; }
                .avl-body { padding: 0; overflow-y: auto; max-height: calc(85vh - 120px); }
                .avl-tab-content { display: none; padding: 16px; }
                .avl-tab-content.active { display: block; }
                .avl-section { margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #f0f0f0; }
                .avl-section:last-child { border-bottom: none; }
                .avl-section-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #999; margin-bottom: 12px; font-weight: 600; }
                .avl-btn { background: #00a1d6; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-right: 8px; margin-bottom: 8px; transition: all 0.2s; display: inline-flex; align-items: center; gap: 4px; }
                .avl-btn:hover { background: #0089b5; transform: translateY(-1px); }
                .avl-btn.secondary { background: #f1f2f3; color: #666; }
                .avl-btn.secondary:hover { background: #e3e5e7; }
                .avl-btn.success { background: #00b5e5; }
                .avl-btn.danger { background: #fb7299; }
                .avl-btn.small { padding: 6px 12px; font-size: 12px; }
                .avl-input-group { margin-bottom: 12px; }
                .avl-input { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; box-sizing: border-box; margin-top: 4px; }
                .avl-input:focus { outline: none; border-color: #00a1d6; }
                .avl-share-box { background: linear-gradient(135deg, #f6f7f8, #ffffff); border: 2px dashed #00a1d6; border-radius: 12px; padding: 20px; text-align: center; margin: 16px 0; }
                .avl-share-code-display { font-family: 'Courier New', monospace; font-size: 14px; background: white; padding: 12px; border-radius: 8px; border: 1px solid #e0e0e0; word-break: break-all; line-height: 1.6; color: #333; margin: 12px 0; max-height: 200px; overflow-y: auto; }
                .avl-share-stats { font-size: 12px; color: #666; margin-top: 8px; }
                .avl-share-input { width: 100%; min-height: 120px; font-family: monospace; font-size: 13px; padding: 12px; border: 2px solid #ddd; border-radius: 8px; resize: vertical; box-sizing: border-box; }
                .avl-share-input:focus { border-color: #00a1d6; outline: none; }
                .avl-modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 100000; display: none; align-items: center; justify-content: center; }
                .avl-modal-overlay.active { display: flex; }
                .avl-modal { background: white; border-radius: 16px; padding: 24px; width: 90%; max-width: 500px; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
                .avl-modal h3 { margin: 0 0 16px 0; color: #00a1d6; }
                .avl-playlist-stats { background: #f6f7f8; padding: 12px; border-radius: 8px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
                .avl-playlist-item { background: white; border: 1px solid #f0f0f0; border-radius: 10px; padding: 12px; margin-bottom: 10px; position: relative; cursor: pointer; transition: all 0.2s; display: flex; gap: 10px; align-items: flex-start; }
                .avl-playlist-item:hover { border-color: #00a1d6; }
                .avl-playlist-item.active { background: linear-gradient(135deg, rgba(0,161,214,0.05), rgba(0,181,229,0.1)); border-color: #00a1d6; border-left: 3px solid #00a1d6; }
                .avl-playlist-number { width: 24px; height: 24px; background: #f1f2f3; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; color: #666; flex-shrink: 0; }
                .avl-playlist-item.active .avl-playlist-number { background: #00a1d6; color: white; }
                .avl-playlist-content { flex: 1; min-width: 0; }
                .avl-playlist-title { font-weight: 500; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .avl-playlist-meta { font-size: 11px; color: #999; display: flex; gap: 8px; flex-wrap: wrap; }
                .avl-playlist-video-title { color: #00a1d6; font-weight: 500; }
                .avl-playlist-time { font-family: monospace; background: rgba(0,161,214,0.1); color: #00a1d6; padding: 2px 6px; border-radius: 4px; }
                .avl-playlist-controls { display: flex; gap: 4px; opacity: 0; transition: opacity 0.2s; }
                .avl-playlist-item:hover .avl-playlist-controls { opacity: 1; }
                .avl-playlist-btn { width: 28px; height: 28px; border: none; background: #f1f2f3; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #666; }
                .avl-playlist-btn:hover { background: #e3e5e7; color: #333; }
                .avl-playlist-btn.delete:hover { background: #ffe6ea; color: #fb7299; }
                .avl-empty-state { text-align: center; padding: 40px 20px; color: #999; }
                .avl-empty-icon { font-size: 48px; margin-bottom: 12px; opacity: 0.3; }
                .avl-fragment-item { background: #f6f7f8; border-radius: 8px; padding: 12px; margin-bottom: 10px; border-left: 3px solid #00a1d6; }
                .avl-fragment-time { font-family: monospace; color: #00a1d6; font-weight: bold; font-size: 12px; margin-bottom: 4px; }
                .avl-fragment-title { font-weight: 500; margin-bottom: 8px; }
                .avl-fragment-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
                .avl-tag { background: rgba(0, 161, 214, 0.1); color: #00a1d6; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
                .avl-player-bar { position: fixed; bottom: 0; left: 0; right: 0; background: white; border-top: 1px solid #f0f0f0; padding: 12px 20px; display: none; align-items: center; gap: 16px; z-index: 99998; box-shadow: 0 -4px 20px rgba(0,0,0,0.1); }
                .avl-player-bar.active { display: flex; }
                .avl-player-info { flex: 1; font-size: 14px; }
                .avl-player-title { font-weight: 500; color: #333; margin-bottom: 2px; }
                .avl-player-subtitle { font-size: 12px; color: #999; }
                .avl-player-buttons { display: flex; gap: 8px; }
                .avl-fab { position: fixed; right: 30px; bottom: 100px; width: 56px; height: 56px; background: #00a1d6; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 4px 12px rgba(0, 161, 214, 0.4); z-index: 99999; font-size: 24px; border: none; transition: all 0.3s; }
                .avl-fab:hover { transform: scale(1.1) rotate(90deg); box-shadow: 0 6px 20px rgba(0, 161, 214, 0.5); }
                .avl-fab.has-playlist { background: #00b5e5; animation: pulse 2s infinite; }
                @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(0, 181, 229, 0.4); } 50% { box-shadow: 0 0 0 10px rgba(0, 181, 229, 0); } }
                .avl-toast { position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%) translateY(20px); background: rgba(0,0,0,0.85); color: white; padding: 12px 24px; border-radius: 24px; z-index: 100001; font-size: 14px; opacity: 0; transition: all 0.3s; pointer-events: none; }
                .avl-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
            `;

        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    createFloatingButton() {
        console.log('[AVL] UIManager.createFloatingButton 开始创建浮动按钮');
        const btn = document.createElement('button');
        btn.className = 'avl-fab';
        btn.innerHTML = '✦';
        btn.title = 'Awesome Video List';
        btn.onclick = () => this.togglePanel();
        document.body.appendChild(btn);
        this.fab = btn;
        this.updateFabState();
        console.log('[AVL] UIManager.createFloatingButton 浮动按钮创建完成');
    }

    updateFabState() {
        console.log('[AVL] UIManager.updateFabState 开始更新浮动按钮状态，当前播放列表长度:', this.dm.currentPlaylist.length);
        if (this.dm.currentPlaylist.length > 0) {
            this.fab.classList.add('has-playlist');
            this.fab.title = `播放列表 (${this.dm.currentPlaylist.length})`;
            console.log('[AVL] UIManager.updateFabState 设置为有播放列表状态');
        } else {
            this.fab.classList.remove('has-playlist');
            this.fab.title = 'Awesome Video List';
            console.log('[AVL] UIManager.updateFabState 设置为无播放列表状态');
        }
    }

    // 关键修复：createPanel 不再使用 onclick="window.AVL..."，而是使用 id 和内部绑定
    createPanel() {
        console.log('[AVL] UIManager.createPanel 开始创建面板');
        const panel = document.createElement('div');
        panel.className = 'avl-panel';
        panel.id = 'avl-panel';

        // 使用 id 替代 onclick
        panel.innerHTML = `
                <div class="avl-header">
                    <div style="display: flex; flex-direction: column; flex: 1;">
                        <span>✦ Awesome Video</span>
                        <div class="avl-tabs">
                            <div class="avl-tab active" data-tab="mark">标记</div>
                            <div class="avl-tab" data-tab="playlist">播放列表 (${this.dm.currentPlaylist.length})</div>
                            <div class="avl-tab" data-tab="share">分享</div>
                        </div>
                    </div>
                    <span class="avl-close" id="avl-btn-close">×</span>
                </div>
                
                <div class="avl-body">
                    <!-- 标记标签页 -->
                    <div class="avl-tab-content active" id="tab-mark">
                        <div class="avl-section">
                            <div class="avl-section-title">片段标记</div>
                            <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                                <button class="avl-btn" id="avl-btn-mark-start">● 标记起点</button>
                                <button class="avl-btn secondary" id="avl-btn-mark-end">○ 标记终点</button>
                            </div>
                            <div id="avl-current-mark" style="font-size: 12px; color: #666; margin-bottom: 8px;">未开始标记</div>
                            <div id="avl-save-form" style="display: none;">
                                <div class="avl-input-group">
                                    <input type="text" class="avl-input" id="avl-fragment-title" placeholder="片段标题（如：核心概念讲解）">
                                </div>
                                <div class="avl-input-group">
                                    <input type="text" class="avl-input" id="avl-fragment-tags" placeholder="标签，用空格分隔（如：入门 技巧）">
                                </div>
                                <div class="avl-input-group">
                                    <textarea class="avl-input" id="avl-fragment-note" rows="2" placeholder="备注（可选）"></textarea>
                                </div>
                                <button class="avl-btn success" id="avl-btn-save-fragment">保存片段</button>
                                <button class="avl-btn secondary" id="avl-btn-cancel-fragment">取消</button>
                            </div>
                        </div>

                        <div class="avl-section">
                            <div class="avl-section-title">本视频标记 <span id="avl-count" style="color: #00a1d6;">(0)</span></div>
                            <div id="avl-fragments-list"></div>
                        </div>
                    </div>

                    <!-- 播放列表标签页 -->
                    <div class="avl-tab-content" id="tab-playlist">
                        <div class="avl-playlist-stats">
                            <div>
                                <span>共 <b>${this.dm.currentPlaylist.length}</b> 个片段</span>
                                <span style="margin-left: 12px;" id="avl-current-pos"></span>
                            </div>
                            <button class="avl-btn small danger" id="avl-btn-clear-playlist" style="margin:0;">清空</button>
                        </div>
                        <div id="avl-playlist-container"></div>
                        <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #f0f0f0;">
                            <div class="avl-section-title">批量操作</div>
                            <button class="avl-btn small secondary" id="avl-btn-add-all">添加本视频所有片段</button>
                        </div>
                    </div>

                    <!-- 分享标签页 -->
                    <div class="avl-tab-content" id="tab-share">
                        <div class="avl-section" style="text-align: center;">
                            <div class="avl-section-title">🚀 分享码同步（无需登录）</div>
                            <p style="font-size: 13px; color: #666; line-height: 1.6;">
                                将您的视频标记和播放列表生成一段分享码，<br>
                                发送给朋友，对方粘贴即可合并数据。<br>
                                <span style="color: #00a1d6;">完全离线，永不丢失！</span>
                            </p>
                            
                            <div class="avl-share-box" style="margin-top: 20px;">
                                <div style="font-size: 48px; margin-bottom: 8px;">📋</div>
                                <button class="avl-btn" id="avl-btn-generate-share" style="font-size: 15px; padding: 10px 24px;">
                                    生成分享码
                                </button>
                                // 在分享标签页的 HTML 中，更新提示信息
                                <div style="font-size: 12px; color: #999; margin-top: 8px;">
                                    共 ${Object.keys(this.dm.data).length} 个视频, ${this.dm.currentPlaylist.length} 个播放片段<br>
                                    <span style="color: #00a1d6;">由 dpaste.com 提供存储（7天有效）</span>
                                </div>
                            </div>
                            
                            <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid #f0f0f0;">
                                <div class="avl-section-title">导入分享码</div>
                                <textarea class="avl-share-input" id="avl-import-input" placeholder="粘贴分享码或 dpaste 链接到这里...&#10;&#10;支持格式：&#10;• 原始分享码（长字符串）&#10;• dpaste 链接：https://dpaste.com/XXXX&#10;• 仅提取码：XXXX"></textarea>
                                <button class="avl-btn success" id="avl-btn-import-share" style="width: 100%; margin-top: 8px;">
                                    解析并导入
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;

        document.body.appendChild(panel);
        this.panel = panel;

        // 关键修复：在DOM创建后立即绑定事件，不依赖window.AVL
        this.bindPanelEvents();
        this.createModals();
        this.createPlayerBar();
    }

    // 关键修复：所有事件在此绑定，不使用 onclick
    bindPanelEvents() {
        console.log('[AVL] UIManager.bindPanelEvents 开始绑定面板事件');
        // 关闭按钮
        document.getElementById('avl-btn-close').onclick = () => {
            console.log('[AVL] UIManager.bindPanelEvents 点击关闭按钮');
            this.panel.style.display = 'none';
        };

        // 标签切换
        this.panel.querySelectorAll('.avl-tab').forEach(tab => {
            tab.onclick = (e) => {
                console.log('[AVL] UIManager.bindPanelEvents 点击标签:', e.target.dataset.tab);
                this.panel.querySelectorAll('.avl-tab').forEach(t => t.classList.remove('active'));
                this.panel.querySelectorAll('.avl-tab-content').forEach(c => c.classList.remove('active'));
                e.target.classList.add('active');
                this.panel.querySelector(`#tab-${e.target.dataset.tab}`).classList.add('active');
                this.currentTab = e.target.dataset.tab;
                console.log('[AVL] UIManager.bindPanelEvents 切换到标签:', this.currentTab);
                if (this.currentTab === 'playlist') {
                    console.log('[AVL] UIManager.bindPanelEvents 渲染播放列表');
                    this.renderPlaylist();
                }
                if (this.currentTab === 'share') {
                    console.log('[AVL] UIManager.bindPanelEvents 更新分享统计');
                    this.updateShareStats();
                }
            };
        });

        // 标记相关
        document.getElementById('avl-btn-mark-start').onclick = () => {
            const time = this.getCurrentTime();
            this.tempFragment = { start: time };
            document.getElementById('avl-current-mark').innerHTML =
                `起点: <b>${this.formatTime(time)}</b> - 请点击"标记终点"`;
            document.getElementById('avl-current-mark').style.color = '#00a1d6';
        };

        document.getElementById('avl-btn-mark-end').onclick = () => {
            if (!this.tempFragment) { alert('请先标记起点'); return; }
            const time = this.getCurrentTime();
            if (time <= this.tempFragment.start) { alert('终点时间必须晚于起点'); return; }
            this.tempFragment.end = time;
            document.getElementById('avl-current-mark').innerHTML =
                `片段: <b>${this.formatTime(this.tempFragment.start)} - ${this.formatTime(time)}</b>`;
            document.getElementById('avl-save-form').style.display = 'block';
        };

        document.getElementById('avl-btn-save-fragment').onclick = () => {
            const title = document.getElementById('avl-fragment-title').value.trim();
            if (!title) { alert('请输入片段标题'); return; }

            this.tempFragment.title = title;
            this.tempFragment.tags = document.getElementById('avl-fragment-tags').value.split(/\s+/).filter(t => t);
            this.tempFragment.note = document.getElementById('avl-fragment-note').value;

            const bvid = this.getBvid();
            const videoTitle = document.title.replace('_哔哩哔哩_bilibili', '').trim();

            if (this.dm.addFragment(bvid, videoTitle, this.tempFragment)) {
                this.resetForm();
                this.painter.refresh();
                this.renderFragments();
                this.showToast('片段已保存');
                setTimeout(() => {
                    if (confirm('是否将该片段加入当前播放列表？')) {
                        const fragments = this.dm.getFragments(bvid);
                        this.dm.addToPlaylist(bvid, fragments[fragments.length - 1].id);
                        this.updateFabState();
                        this.showToast('已加入播放列表');
                    }
                }, 300);
            } else {
                alert('该时间段已有相似标记');
            }
        };

        document.getElementById('avl-btn-cancel-fragment').onclick = () => this.resetForm();

        // 播放列表操作（通过全局引用，但确保在init之后）
        document.getElementById('avl-btn-clear-playlist').onclick = () => {
            if (window.AVL) window.AVL.clearPlaylist();
        };
        document.getElementById('avl-btn-add-all').onclick = () => {
            if (window.AVL) window.AVL.addAllVisibleToPlaylist();
        };

        document.getElementById('avl-btn-generate-share').onclick = async () => {
            try {
                await this.showShareCode();
            } catch (e) {
                console.error('[AVL] 分享失败:', e);
                this.showToast('分享失败: ' + e.message);
            }
        };

        document.getElementById('avl-btn-import-share').onclick = () => {
            if (window.AVL) window.AVL.importShareCode();
        };
    }

    createModals() {
        console.log('[AVL] UIManager.createModals 开始创建模态框');
        const modal = document.createElement('div');
        modal.className = 'avl-modal-overlay';
        modal.id = 'avl-share-modal';
        modal.innerHTML = `
                <div class="avl-modal">
                    <h3>📋 复制分享码给好友</h3>
                    <div style="background: #f6f7f8; padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; color: #666;">
                        提示：分享码包含您所有的视频标记和当前播放列表。<br>
                        对方导入时会<strong>智能合并</strong>，不会覆盖已有数据。
                    </div>
                    
                    <div class="avl-share-code-display" id="avl-share-code-text"></div>
                    
                    <div class="avl-share-stats" id="avl-share-stats"></div>
                    
                    <div style="display: flex; gap: 8px; margin-top: 16px;">
                        <button class="avl-btn" id="avl-btn-copy-code" style="flex: 1;">一键复制</button>
                        <button class="avl-btn secondary" id="avl-btn-close-modal" style="flex: 1;">关闭</button>
                    </div>
                </div>
            `;
        document.body.appendChild(modal);

        // 关键修复：直接绑定事件，不依赖 window.AVL
        document.getElementById('avl-btn-close-modal').onclick = () => {
            modal.classList.remove('active');
        };
        document.getElementById('avl-btn-copy-code').onclick = () => {
            this.copyShareCodeToClipboard();
        };
    }

    createPlayerBar() {
        const bar = document.createElement('div');
        bar.className = 'avl-player-bar';
        bar.id = 'avl-player-bar';
        bar.innerHTML = `
                <div class="avl-player-info">
                    <div class="avl-player-title" id="avl-bar-title">播放列表控制</div>
                    <div class="avl-player-subtitle" id="avl-bar-subtitle">点击面板管理播放列表</div>
                </div>
                <div class="avl-player-buttons">
                    <button class="avl-btn secondary" id="avl-btn-play-prev">← 上一个</button>
                    <button class="avl-btn" id="avl-btn-play-next">下一个 →</button>
                    <button class="avl-btn secondary" id="avl-btn-toggle-panel">面板</button>
                </div>
            `;
        document.body.appendChild(bar);

        // 关键修复：直接绑定
        document.getElementById('avl-btn-play-prev').onclick = () => {
            if (window.AVL) window.AVL.playPrev();
        };
        document.getElementById('avl-btn-play-next').onclick = () => {
            if (window.AVL) window.AVL.playNext();
        };
        document.getElementById('avl-btn-toggle-panel').onclick = () => {
            this.togglePanel();
        };

        this.updatePlayerBar();
    }

    async showShareCode() {
        const modal = document.getElementById('avl-share-modal');
        const display = document.getElementById('avl-share-code-text');
        const stats = document.getElementById('avl-share-stats');

        // 关键：先显示上传中状态
        display.textContent = '正在上传到 0x0.st...';
        stats.innerHTML = '<span style="color: #999;">请稍候，正在生成短链接...</span>';
        modal.classList.add('active');

        try {
            const url = await this.dm.uploadToPastebinService();

            // 成功后显示短链接
            display.textContent = url;
            stats.innerHTML = `<span style="color: #00a1d6;">✓ 短链接已生成并复制</span>`;

            // 复制到剪贴板
            navigator.clipboard.writeText(url).then(() => {
                this.showToast('短链接已复制！');
            });

        } catch (error) {
            console.error('[AVL] 上传失败:', error);
            // 失败时显示原始分享码作为兜底
            const code = this.dm.generateShareCode();
            display.textContent = code;
            stats.innerHTML = `<span style="color: #fb7299;">⚠️ 短链接失败(${error.message})，请复制上方原始分享码</span>`;
        }
    }

    copyShareCodeToClipboard() {
        const code = document.getElementById('avl-share-code-text').textContent;
        navigator.clipboard.writeText(code).then(() => {
            this.showToast('✓ 已复制到剪贴板！');
            setTimeout(() => {
                document.getElementById('avl-share-modal').classList.remove('active');
            }, 500);
        }).catch(() => {
            const range = document.createRange();
            range.selectNode(document.getElementById('avl-share-code-text'));
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            document.execCommand('copy');
            this.showToast('✓ 已复制（请Ctrl+C确认）');
        });
    }

    updateShareStats() {
        const totalFragments = Object.values(this.dm.data).reduce((sum, v) => sum + v.fragments.length, 0);
        const shareBox = this.panel.querySelector('.avl-share-box div:last-child');
        if (shareBox) {
            shareBox.textContent = `共 ${Object.keys(this.dm.data).length} 个视频, ${totalFragments} 个片段, ${this.dm.currentPlaylist.length} 个播放位`;
        }
    }

    resetForm() {
        this.tempFragment = null;
        document.getElementById('avl-current-mark').innerHTML = '未开始标记';
        document.getElementById('avl-current-mark').style.color = '#666';
        document.getElementById('avl-save-form').style.display = 'none';
        document.getElementById('avl-fragment-title').value = '';
        document.getElementById('avl-fragment-tags').value = '';
        document.getElementById('avl-fragment-note').value = '';
    }

    renderFragments() {
        const bvid = this.getBvid();
        const fragments = this.dm.getFragments(bvid);
        const container = document.getElementById('avl-fragments-list');
        const countEl = document.getElementById('avl-count');

        countEl.textContent = `(${fragments.length})`;

        if (fragments.length === 0) {
            container.innerHTML = '<div style="color: #999; font-size: 12px; text-align: center; padding: 20px;">暂无标记，添加第一个片段吧</div>';
            return;
        }

        // 生成HTML时不使用 onclick，使用 data 属性存储信息
        container.innerHTML = fragments.map((f, idx) => {
            const inPlaylist = this.dm.currentPlaylist.some(p => p.bvid === bvid && p.fragmentId === f.id);
            return `
                <div class="avl-fragment-item" data-idx="${idx}" data-fid="${f.id}">
                    <div class="avl-fragment-time">${this.formatTime(f.start)} → ${this.formatTime(f.end)}</div>
                    <div class="avl-fragment-title">${f.title}</div>
                    ${f.tags?.length ? `<div class="avl-fragment-tags">${f.tags.map(t => `<span class="avl-tag">${t}</span>`).join('')}</div>` : ''}
                    <div style="display: flex; gap: 8px; margin-top: 8px;">
                        <button class="avl-btn small btn-play-fragment">播放</button>
                        <button class="avl-btn small secondary btn-add-playlist" ${inPlaylist ? 'disabled style="opacity:0.5"' : ''}>
                            ${inPlaylist ? '✓ 已在列表' : '+ 加入列表'}
                        </button>
                        <button class="avl-btn small danger btn-delete-fragment">删除</button>
                    </div>
                </div>
            `}).join('');

        // 动态绑定事件
        container.querySelectorAll('.avl-fragment-item').forEach((el, idx) => {
            const fid = el.dataset.fid;

            el.querySelector('.btn-play-fragment').onclick = () => {
                if (window.AVL) window.AVL.playFragment(bvid, fid);
            };

            el.querySelector('.btn-add-playlist').onclick = (e) => {
                if (e.target.disabled) return;
                if (window.AVL) {
                    window.AVL.addToPlaylist(bvid, fid);
                    e.target.disabled = true;
                    e.target.textContent = '✓ 已在列表';
                    e.target.style.opacity = '0.5';
                }
            };

            el.querySelector('.btn-delete-fragment').onclick = () => {
                if (confirm('确定删除这个片段标记？')) {
                    if (window.AVL) window.AVL.deleteFragment(bvid, fid);
                }
            };
        });
    }

    renderPlaylist() {
        const container = document.getElementById('avl-playlist-container');
        const stats = document.querySelector('.avl-playlist-stats');
        const currentIdx = this.dm.getCurrentPlaylistIndex();

        stats.innerHTML = `
                <div>
                    <span>共 <b>${this.dm.currentPlaylist.length}</b> 个片段</span>
                    <span style="margin-left: 12px; color: #00a1d6;">当前: #${currentIdx + 1}</span>
                </div>
                <button class="avl-btn small danger" id="avl-btn-clear-playlist2" style="margin:0;">清空</button>
            `;

        // 重新绑定清空按钮
        setTimeout(() => {
            const btn = document.getElementById('avl-btn-clear-playlist2');
            if (btn) btn.onclick = () => { if (window.AVL) window.AVL.clearPlaylist(); };
        }, 0);

        if (this.dm.currentPlaylist.length === 0) {
            container.innerHTML = `
                    <div class="avl-empty-state">
                        <div class="avl-empty-icon">📝</div>
                        <div>播放列表为空</div>
                        <div style="font-size: 12px; margin-top: 8px;">在"标记"标签页添加片段到此处</div>
                    </div>`;
            return;
        }

        container.innerHTML = this.dm.currentPlaylist.map((item, idx) => `
                <div class="avl-playlist-item ${idx === currentIdx ? 'active' : ''}" data-index="${idx}">
                    <div class="avl-playlist-number">${idx + 1}</div>
                    <div class="avl-playlist-content">
                        <div class="avl-playlist-title">${item.title}</div>
                        <div class="avl-playlist-meta">
                            <span class="avl-playlist-video-title">${item.videoTitle}</span>
                            <span class="avl-playlist-time">${this.formatTime(item.start)}-${this.formatTime(item.end)}</span>
                        </div>
                    </div>
                    <div class="avl-playlist-controls">
                        <button class="avl-playlist-btn btn-move-up" ${idx === 0 ? 'disabled' : ''}>↑</button>
                        <button class="avl-playlist-btn btn-move-down" ${idx === this.dm.currentPlaylist.length - 1 ? 'disabled' : ''}>↓</button>
                        <button class="avl-playlist-btn delete btn-remove-item">×</button>
                    </div>
                </div>
            `).join('');

        // 动态绑定播放列表事件
        container.querySelectorAll('.avl-playlist-item').forEach(el => {
            const idx = parseInt(el.dataset.index);

            el.onclick = (e) => {
                if (e.target.closest('.avl-playlist-controls')) return;
                this.engine.jumpToIndex(idx);
            };

            el.querySelector('.btn-move-up').onclick = (e) => {
                e.stopPropagation();
                if (window.AVL) window.AVL.movePlaylistItem(idx, -1);
            };

            el.querySelector('.btn-move-down').onclick = (e) => {
                e.stopPropagation();
                if (window.AVL) window.AVL.movePlaylistItem(idx, 1);
            };

            el.querySelector('.btn-remove-item').onclick = (e) => {
                e.stopPropagation();
                if (window.AVL) window.AVL.removeFromPlaylist(idx);
            };
        });

        this.updatePlayerBar();
    }

    togglePanel() {
        if (!this.panel) this.createPanel();
        const isVisible = this.panel.style.display === 'flex';
        this.panel.style.display = isVisible ? 'none' : 'flex';
        if (!isVisible) {
            this.renderFragments();
            if (this.currentTab === 'playlist') this.renderPlaylist();
            if (this.currentTab === 'share') this.updateShareStats();
            this.updateFabState();
        }
    }

    getCurrentTime() {
        const video = document.querySelector('video');
        return video ? video.currentTime || 0 : 0;
    }

    seekTo(seconds) {
        const video = document.querySelector('video');
        if (video) {
            video.currentTime = seconds;
            video.play();
        }
    }

    getBvid() {
        const match = window.location.pathname.match(/BV[0-9a-zA-Z]+/);
        return match ? match[0] : '';
    }

    formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    observeVideoChange() {
        let lastBvid = this.getBvid();
        new MutationObserver(() => {
            const currentBvid = this.getBvid();
            if (currentBvid !== lastBvid) {
                lastBvid = currentBvid;
                this.resetForm();
                if (this.panel?.style.display === 'flex') this.renderFragments();
                this.checkAutoResume(currentBvid);
            }
        }).observe(document.body, { subtree: true, childList: true });
    }

    checkAutoResume(bvid) {
        const nextItem = this.engine.peekNext();
        if (nextItem && nextItem.bvid === bvid) {
            setTimeout(() => {
                this.seekTo(nextItem.start);
                this.dm.setCurrentPlaylistIndex(this.dm.getCurrentPlaylistIndex() + 1);
                this.showToast(`自动恢复: ${nextItem.title}`);
                this.updatePlayerBar();
            }, 1000);
        }
    }

    updatePlayerBar() {
        const bar = document.getElementById('avl-player-bar');
        const current = this.engine.getCurrentItem();

        if (this.dm.currentPlaylist.length > 0) {
            bar.classList.add('active');
            if (current) {
                document.getElementById('avl-bar-title').textContent =
                    `${this.dm.getCurrentPlaylistIndex() + 1}. ${current.title}`;
                document.getElementById('avl-bar-subtitle').textContent =
                    `${current.videoTitle} (${this.formatTime(current.start)}-${this.formatTime(current.end)})`;
            }
        } else {
            bar.classList.remove('active');
        }
    }

    showToast(msg) {
        let toast = document.getElementById('avl-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'avl-toast';
            toast.className = 'avl-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2500);
    }
}

class AwesomeVideoList {
    constructor() {
        console.log('[AVL] AwesomeVideoList 初始化开始');
        this.dm = new DataManager();
        this.ui = new UIManager(this.dm);
        console.log('[AVL] AwesomeVideoList 初始化完成');
    }

    playFragment(bvid, fragmentId) {
        console.log('[AVL] AwesomeVideoList.playFragment 开始执行，BVID:', bvid, '片段ID:', fragmentId);
        const fragment = this.dm.getFragment(bvid, fragmentId);
        if (!fragment) {
            console.log('[AVL] AwesomeVideoList.playFragment 未找到指定片段');
            return;
        }
        if (this.ui.getBvid() !== bvid) {
            console.log('[AVL] AwesomeVideoList.playFragment 跳转到不同视频:', bvid);
            window.location.href = `https://bilibili.com/video/${bvid}?t=${Math.floor(fragment.start)}`;
        } else {
            console.log('[AVL] AwesomeVideoList.playFragment 同一视频内跳转到:', fragment.start);
            this.ui.seekTo(fragment.start);
        }
    }

    addToPlaylist(bvid, fragmentId) {
        console.log('[AVL] AwesomeVideoList.addToPlaylist 开始执行，BVID:', bvid, '片段ID:', fragmentId);
        if (this.dm.addToPlaylist(bvid, fragmentId)) {
            console.log('[AVL] AwesomeVideoList.addToPlaylist 成功添加到播放列表');
            this.ui.showToast('已加入播放列表');
            this.ui.updateFabState();
            if (this.ui.panel?.style.display === 'flex') {
                console.log('[AVL] AwesomeVideoList.addToPlaylist 更新面板显示，当前标签:', this.ui.currentTab);
                if (this.ui.currentTab === 'playlist') this.ui.renderPlaylist();
                else if (this.ui.currentTab === 'mark') this.ui.renderFragments();
                this.ui.painter.refresh();
            }
        } else {
            console.log('[AVL] AwesomeVideoList.addToPlaylist 片段已在列表中');
            this.ui.showToast('该片段已在列表中');
        }
    }

    removeFromPlaylist(index) {
        console.log('[AVL] AwesomeVideoList.removeFromPlaylist 开始执行，索引:', index);
        this.dm.removeFromPlaylistByIndex(index);
        this.ui.renderPlaylist();
        this.ui.painter.refresh();
        this.ui.showToast('已移除');
        console.log('[AVL] AwesomeVideoList.removeFromPlaylist 执行完成');
    }

    movePlaylistItem(index, direction) {
        console.log('[AVL] AwesomeVideoList.movePlaylistItem 开始执行，索引:', index, '方向:', direction);
        if (this.dm.movePlaylistItem(index, direction)) {
            this.ui.renderPlaylist();
            console.log('[AVL] AwesomeVideoList.movePlaylistItem 执行完成');
        } else {
            console.log('[AVL] AwesomeVideoList.movePlaylistItem 移动失败');
        }
    }

    playNext() {
        console.log('[AVL] AwesomeVideoList.playNext 开始执行');
        this.ui.engine.playNext();
        console.log('[AVL] AwesomeVideoList.playNext 执行完成');
    }

    playPrev() {
        console.log('[AVL] AwesomeVideoList.playPrev 开始执行');
        this.ui.engine.playPrev();
        console.log('[AVL] AwesomeVideoList.playPrev 执行完成');
    }

    clearPlaylist() {
        console.log('[AVL] AwesomeVideoList.clearPlaylist 开始执行');
        if (confirm('确定要清空当前播放列表吗？')) {
            console.log('[AVL] AwesomeVideoList.clearPlaylist 用户确认清空');
            this.dm.clearPlaylist();
            this.ui.renderPlaylist();
            this.ui.updatePlayerBar();
            this.ui.updateFabState();
            this.ui.showToast('播放列表已清空');
            console.log('[AVL] AwesomeVideoList.clearPlaylist 执行完成');
        } else {
            console.log('[AVL] AwesomeVideoList.clearPlaylist 用户取消操作');
        }
    }

    addAllVisibleToPlaylist() {
        console.log('[AVL] AwesomeVideoList.addAllVisibleToPlaylist 开始执行');
        const bvid = this.ui.getBvid();
        const fragments = this.dm.getFragments(bvid);
        console.log('[AVL] AwesomeVideoList.addAllVisibleToPlaylist 当前视频BVID:', bvid, '片段数:', fragments.length);
        let added = 0;
        fragments.forEach(f => {
            if (this.dm.addToPlaylist(bvid, f.id)) added++;
        });
        this.ui.showToast(`已添加 ${added} 个片段`);
        if (this.ui.currentTab === 'playlist') this.ui.renderPlaylist();
        this.ui.updateFabState();
        console.log('[AVL] AwesomeVideoList.addAllVisibleToPlaylist 执行完成，添加片段数:', added);
    }

    deleteFragment(bvid, fragmentId) {
        console.log('[AVL] AwesomeVideoList.deleteFragment 开始执行，BVID:', bvid, '片段ID:', fragmentId);
        if (confirm('确定删除这个片段标记？')) {
            console.log('[AVL] AwesomeVideoList.deleteFragment 用户确认删除');
            this.dm.deleteFragment(bvid, fragmentId);
            this.ui.renderFragments();
            console.log('[AVL] AwesomeVideoList.deleteFragment 执行完成');
        } else {
            console.log('[AVL] AwesomeVideoList.deleteFragment 用户取消删除');
        }
    }

    async importShareCode() {
        console.log('[AVL] 开始导入分享码');
        const input = document.getElementById('avl-import-input');
        let code = input?.value?.trim();

        if (!code) {
            alert('请先粘贴分享码或 dpaste 链接');
            return;
        }

        try {
            // 智能识别：如果是 dpaste 链接，自动获取原始内容
            if (code.includes('dpaste.com/')) {
                this.ui.showToast('检测到 dpaste 链接，正在获取内容...');
                code = await this.dm.fetchFromDpaste(code);
                this.ui.showToast('获取成功，正在解析...');
            }

            // 也可能用户只粘贴了 key（如 223UMASZF）
            else if (/^[A-Z0-9]{6,}$/i.test(code) && !code.includes(' ')) {
                // 尝试作为 dpaste key 获取
                try {
                    this.ui.showToast('尝试识别为 dpaste 提取码...');
                    code = await this.dm.fetchFromDpaste(code);
                    this.ui.showToast('获取成功，正在解析...');
                } catch (e) {
                    // 如果不是有效的 dpaste key，就当作文本分享码继续处理
                    console.log('[AVL] 不是有效的 dpaste key，尝试作为原始分享码解析');
                }
            }

            // 正常解析分享码
            const result = this.dm.importFromShareCode(code);

            if (result.success) {
                const stats = result.stats;
                this.ui.showToast(`导入成功！新增 ${stats.addedVideos} 视频, ${stats.addedFragments} 片段`);
                alert(`导入成功！\n\n📊 统计：\n• 新增视频：${stats.addedVideos} 个\n• 新增片段：${stats.addedFragments} 个\n• 跳过重复：${stats.skippedFragments} 个\n• 播放位：${stats.addedPlaylist} 个\n\n已智能合并到现有数据。`);
                input.value = '';
                this.ui.painter.refresh();
                this.ui.updateFabState();
                if (this.ui.panel?.style.display === 'flex') {
                    if (this.ui.currentTab === 'mark') this.ui.renderFragments();
                    else if (this.ui.currentTab === 'playlist') this.ui.renderPlaylist();
                    else if (this.ui.currentTab === 'share') this.ui.updateShareStats();
                }
            } else {
                alert('导入失败：' + result.error);
            }
        } catch (error) {
            console.error('[AVL] 导入过程出错:', error);
            alert('导入失败：' + error.message);
        }
    }

    togglePanel() {
        this.ui.togglePanel();
    }
}


// TODO: 初始化前需确认 document.body 已存在，并增加 window.AVL 的重复初始化保护。
// TODO: Bilibili 为 SPA，后续需在 URL 或视频切换时复用实例并刷新当前视频状态。
// init Main Entry and Append to Tas's windos object
try {
    console.log('[AVL] Start init.');
    window.AVL = new AwesomeVideoList();
    console.log('[AVL] init done, click ✦ Button to Start.');
} catch (e) {
    console.error('[AVL] 主入口初始化失败，请检查 GM_* API、DOM 生命周期和 Bilibili 页面结构:', e);
}