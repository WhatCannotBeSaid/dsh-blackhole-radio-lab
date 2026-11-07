/**
 * Black Hole Radio — browser half (phase 4).
 *
 * Three pieces meet here, and each keeps its own boundary:
 *
 *   client.radio.js  — data only: the mock repository, taxonomy, search.
 *                      No three.js, no DOM.
 *   client.stage.js  — rendering and interaction: black hole, station Points
 *                      layer, picking, the camera rig and the interaction
 *                      machine. It receives plain records and never fetches.
 *   this file        — the panel. It loads both chunks on demand and owns the
 *                      HTML chrome. Default state is deliberately chrome-free:
 *                      search appears over the hole's centre, the category
 *                      panel on a 600 ms dwell, and the cluster state gets only
 *                      a back affordance, a search trigger and a detail card.
 *
 * The station ids are the only keys shared by all three layers. Instance
 * indices stay inside the stage; the panel never sees them.
 *
 * Harness facts this file relies on (read from the installed packages):
 *   - the `main` slot is KEYED by `options.key` (dsh-client-ui-layout), and
 *     `layout.selectPanel(id)` fails unless a `main` entry carries that key;
 *   - `sidebar.panellist` is a list slot read as { id, order, label };
 *   - a seat that has not been declared throws on register, so every seat is
 *     claimed through `ctx.slots.inject(seat, register)`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-blackhole-radio-lab',

  factory(require) {
    const React = require('react');
    const {
      createElement: h,
      useCallback,
      useEffect,
      useLayoutEffect,
      useMemo,
      useRef,
      useState,
      useSyncExternalStore,
    } = React;

    const PANEL_ID = 'blackhole-radio-lab';
    const NS = 'blackhole-radio-lab';
    const STYLE_ID = 'bhrl-styles';
    const CONFIG_URL = '/blackhole-radio-lab/config';
    const STAGE_CHUNK = './client.stage.js';
    const RADIO_CHUNK = './client.radio.js';
    /** Host route that reads one stream's ICY metadata block. */
    const NOW_PLAYING_URL = '/blackhole-radio-lab/now-playing';
    /**
     * Host route that owns the library — favourite stations and liked songs.
     * It is a file on the machine, not `localStorage`: the page's port is not
     * stable, and a library must outlive one origin.
     */
    const LIBRARY_URL = '/blackhole-radio-lab/library';
    /** How long after the last mark the library is written, in milliseconds. */
    const LIBRARY_WRITE_MS = 400;
    /** How long a restore may wait for the file before it gives up, in ms. */
    const LIBRARY_READ_MS = 8000;
    /**
     * Largest body that may be sent with `keepalive`. Browsers cap such requests
     * at 64 KiB and reject anything above it outright, so a bigger body must go
     * out without the flag rather than fail every write once the library grows.
     */
    const KEEPALIVE_MAX_CHARS = 48 * 1024;
    /**
     * The write that is still on the wire.
     *
     * `dispose` sends the last marks without waiting, because it cannot wait. A
     * restore that started straight afterwards would then read the file as it
     * was before those marks, so it waits for this first.
     */
    let libraryWriteInFlight = null;
    /** How often a playing station is asked what it is playing. */
    const NOW_PLAYING_POLL_MS = 15000;

    /**
     * What the panel runs on when `/blackhole-radio-lab/config` is unreachable.
     *
     * These are the same values the server sends by default (`server/config.mjs`)
     * and the same ones the station count knob validates against. The card in the
     * left column loads the catalogue through `shared.ensureData`, which does not
     * depend on this request, so a failed fetch must not leave the panel without a
     * configuration to render with.
     */
    const DEFAULT_CFG = {
      antialias: true,
      pixelRatioCap: 2,
      reducedMotion: false,
      wormhole: true,
      stationCount: 2000,
      seed: 20261022,
      featuredCount: 18,
      // How much of the Radio Browser directory to pull. The API answers in
      // pages, so this is a count and a page size rather than one number; the
      // budget is what stops a slow mirror from stalling the boot.
      sourceLimit: 5000,
      sourcePageSize: 500,
      sourceConcurrency: 4,
      sourceTimeoutMs: 12000,
      sourceBudgetMs: 60000,
    };

    /** A shipped snapshot older than this loses to the live API. */
    const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

    /**
     * Fetch the build-time catalogue the host publishes at `/catalog`.
     *
     * The snapshot is larger than one live fetch and does not exclude stations
     * based on failed checks. Every failure — a host
     * without the route, a malformed file, a stale build — returns null and
     * lets the caller fall through to Radio Browser exactly as before.
     */
    async function fetchCatalogSnapshot(conf) {
      const configured = Number(conf.sourceTimeoutMs);
      const timeout = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 15000) : 15000;
      try {
        const res = await fetch('/blackhole-radio-lab/catalog', {
          cache: 'reload',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) return null;
        const body = await res.json();
        if (body?.selectionPolicy !== 'no-health-filter' || !Array.isArray(body.stations) || body.stations.length === 0) return null;
        const builtAt = Date.parse(body.builtAt || '');
        if (!Number.isFinite(builtAt) || Date.now() - builtAt > SNAPSHOT_MAX_AGE_MS) return null;
        return { rows: body.stations, builtAt: body.builtAt, fetchedAt: builtAt };
      } catch {
        return null;
      }
    }

    /** Chunk that carries hls.js; fetched the first time a station needs it. */
    const HLS_CHUNK = './client.hls.js';
    /** A URL that is an HLS playlist rather than a media file. */
    const HLS_URL = /\.m3u8(\?|#|$)/i;

    /**
     * Build the stream attacher the playback core asks before every attempt.
     *
     * m3u8 goes through hls.js, lazily. A cancellable pending handle lets the
     * first attempt wait for the shared chunk instead of failing natively first.
     */
    function makeAttachStream(shared, requireAsync) {
      const load = () => {
        if (!shared.hlsLoading) {
          shared.hlsLoading = Promise.resolve()
            .then(() => requireAsync(HLS_CHUNK))
            .then((chunk) => {
              if (chunk && typeof chunk.attachHls === 'function') shared.hlsChunk = chunk;
              return shared.hlsChunk;
            })
            .catch(() => null)
            .finally(() => { shared.hlsLoading = null; });
        }
        return shared.hlsLoading;
      };
      return (audio, url, onError) => {
        if (typeof url !== 'string' || !HLS_URL.test(url)) return null;
        if (shared.hlsChunk) return shared.hlsChunk.attachHls(audio, url, onError);
        if (typeof requireAsync !== 'function') return null;
        let disposed = false;
        let handle = null;
        return {
          ready: load().then((chunk) => {
            if (disposed) return null;
            handle = chunk ? chunk.attachHls(audio, url, onError) : null;
            if (disposed) { handle?.detach?.(); return null; }
            return handle;
          }),
          detach() { disposed = true; handle?.detach?.(); },
        };
      };
    }

    const DICT = {
      zh: {
        sidebarEntry: '黑洞电台',
        stageLabel: '三维舞台',
        stageLoading: '正在加载三维场景',
        stageError: '场景加载失败',
        stageRetry: '重新加载',
        openSearch: '打开搜索',
        searchLabel: '搜索',
        searchPlaceholder: '搜索电台、国家、语言或分类',
        searchHint: '回车定位 · Esc 关闭',
        searchMore: '向下滚动加载更多',
        searchTooMany: '结果过多，仅显示前 2000 条，请输入更精确的关键词',
        noResults: '这里还没有电台',
        categories: '分类',
        clusterStations: '个电台',
        country: '国家/地区',
        language: '语言',
        category: '分类',
        description: '简介',
        stationId: 'ID',
        closeDetail: '关闭详情',
        featuredNote: '精选电台 · 内环亮带中的稳定结构',
        demoNote: '模拟电台，仅用于界面演示；实时源不可用时替代显示，不含播放能力。',
        liveNote: '真实电台数据，来自 Radio Browser；本阶段尚未接入音频播放。',
        dataError: '模拟数据加载失败',
        // ---- phase 7: business actions -----------------------------------
        playAction: '播放',
        pauseAction: '暂停',
        favouriteAction: '收藏',
        unfavouriteAction: '取消收藏',
        hoverPlayHint: '左键播放 · 右键收藏',
        hoverPauseHint: '左键暂停 · 右键收藏',
        hoverTouchHint: '点按播放 · 长按查看',
        hoverLiveBadge: '在播',
        likeAction: '喜欢',
        unlikeAction: '取消喜欢',
        favouriteListTitle: '收藏的电台',
        favouriteListEmpty: '还没有收藏电台',
        likeListTitle: '喜爱的歌曲',
        likeListEmpty: '还没有喜爱歌曲',
        likeSongAction: '喜爱这首歌',
        unlikeSongAction: '取消喜爱这首歌',
        likeUnavailable: '这首歌还没有歌名',
        unavailable: '无法播放',
        playbackLoading: '正在缓冲…',
        playbackSlow: '连接较慢，仍在尝试…',
        playbackError: '播放失败',
        nowPlaying: '正在播放',
        miniPlayerEmpty: '未在播放',
        cardTags: '标签',
        cardOffline: '在线状态未知',
        cardPlayable: '可以收听',
        cardSelectHint: '选中查看电台卡片',
        cardPlayingState: '正在播放',
        cardPausedState: '已暂停',
        cardPausedNote: '已暂停，点按继续',
        cardStationLabel: '电台',
        liveStream: '直播流',
        fcardSub: 'BLACK HOLE RADIO',
        fcardOnline: '在线',
        fcardCountry: '国家',
        fcardLanguage: '语言',
        fcardCategory: '分类',
        fcardTags: '标签',
        fcardPrev: '上一首',
        fcardNext: '下一首（随机）',
        fcardVolume: '音量',
        fcardEmptyName: '未选择电台',
        fcardEmptyHint: '点播放，随机听一台',
        openHoleHint: '点黑洞图标进入黑洞',
        songOpenAction: '在音乐平台搜索这首歌',
        platformPickerTitle: '音乐平台',
        platformPickerHint: '点歌名即在此搜索；右键可改',
        platformCurrent: '默认',
        platform_spotify: 'Spotify',
        platform_netease: '网易云音乐',
        platform_qq: 'QQ 音乐',
        platform_apple: 'Apple Music',
        platform_youtube: 'YouTube',
        genre_jazz: '爵士',
        genre_rock: '摇滚',
        genre_pop: '流行',
        genre_classical: '古典',
        genre_electronic: '电子',
        genre_hiphop: '嘻哈',
        genre_ambient: '氛围',
        genre_folkworld: '民谣与世界',
        genre_bluessoul: '蓝调与灵魂',
        genre_news: '新闻',
        genre_talk: '谈话',
        genre_sports: '体育',
        genre_other: '其他',
      },
      en: {
        sidebarEntry: 'Black Hole Radio',
        stageLabel: '3-D stage',
        stageLoading: 'loading the 3-D scene',
        stageError: 'scene failed to load',
        stageRetry: 'Reload',
        openSearch: 'Open search',
        searchLabel: 'Search',
        searchPlaceholder: 'Search stations, countries, languages or categories',
        searchHint: 'Enter to locate · Esc to close',
        searchMore: 'Scroll for more',
        searchTooMany: 'Too many results — showing the first 2000. Refine your search.',
        noResults: 'No stations here yet',
        categories: 'Categories',
        clusterStations: 'stations',
        country: 'Country / region',
        language: 'Language',
        category: 'Categories',
        description: 'About',
        stationId: 'ID',
        closeDetail: 'Close detail',
        featuredNote: 'Featured · a steadier structure in the inner rim',
        liveNote: 'Real station from Radio Browser. This phase does not play audio yet.',
        demoNote: 'Simulated stations for this interface only. Shown when the live source is offline; nothing plays.',
        dataError: 'mock data failed to load',
        // ---- phase 7: business actions -----------------------------------
        playAction: 'Play',
        pauseAction: 'Pause',
        favouriteAction: 'Favourite',
        unfavouriteAction: 'Remove from favourites',
        hoverPlayHint: 'Click to play · right-click to favourite',
        hoverPauseHint: 'Click to pause · right-click to favourite',
        hoverTouchHint: 'Tap to play · hold for details',
        hoverLiveBadge: 'LIVE',
        likeAction: 'Like',
        unlikeAction: 'Unlike',
        favouriteListTitle: 'Favourite stations',
        favouriteListEmpty: 'No favourite stations yet',
        likeListTitle: 'Liked songs',
        likeListEmpty: 'No liked songs yet',
        likeSongAction: 'Like this song',
        unlikeSongAction: 'Unlike this song',
        likeUnavailable: 'No song title yet',
        unavailable: 'No stream',
        playbackLoading: 'Buffering…',
        playbackSlow: 'Slow connection, still trying…',
        playbackError: 'Playback failed',
        nowPlaying: 'Now playing',
        miniPlayerEmpty: 'Nothing playing',
        cardTags: 'Tags',
        cardOffline: 'Online status unknown',
        cardPlayable: 'Listenable',
        cardSelectHint: 'Select to open the station card',
        cardPlayingState: 'Playing',
        cardPausedState: 'Paused',
        cardPausedNote: 'Paused — tap to resume',
        cardStationLabel: 'Station',
        liveStream: 'Live stream',
        fcardSub: 'COSMIC RADIO',
        fcardOnline: 'Online',
        fcardCountry: 'Country',
        fcardLanguage: 'Language',
        fcardCategory: 'Genre',
        fcardTags: 'Tags',
        fcardPrev: 'Previous station',
        fcardNext: 'Next station (random)',
        fcardVolume: 'Volume',
        fcardEmptyName: 'No station selected',
        fcardEmptyHint: 'Press play for a random one',
        openHoleHint: 'Open the hole from the logo',
        songOpenAction: 'Search this song on a music platform',
        platformPickerTitle: 'Music platform',
        platformPickerHint: 'A press searches here; a right-click changes where',
        platformCurrent: 'Default',
        platform_spotify: 'Spotify',
        platform_netease: 'NetEase Cloud Music',
        platform_qq: 'QQ Music',
        platform_apple: 'Apple Music',
        platform_youtube: 'YouTube',
        genre_jazz: 'Jazz',
        genre_rock: 'Rock',
        genre_pop: 'Pop',
        genre_classical: 'Classical',
        genre_electronic: 'Electronic',
        genre_hiphop: 'Hip-Hop',
        genre_ambient: 'Ambient',
        genre_folkworld: 'Folk & World',
        genre_bluessoul: 'Blues & Soul',
        genre_news: 'News',
        genre_talk: 'Talk',
        genre_sports: 'Sports',
        genre_other: 'Other',
      },
    };

    const fallbackT = (key) => (DICT.en[key] !== undefined ? DICT.en[key] : key);

    function makeT(localeSvc) {
      try {
        if (localeSvc && typeof localeSvc.bind === 'function') {
          const bound = localeSvc.bind(NS);
          return (key) => {
            const value = bound(key);
            return value === key ? fallbackT(key) : value;
          };
        }
      } catch {
        /* fall through to the inline table */
      }
      return fallbackT;
    }

    function activeLanguage(localeSvc) {
      try {
        const snapshot = localeSvc && typeof localeSvc.getLocale === 'function' ? localeSvc.getLocale() : null;
        return String((snapshot && snapshot.active) || 'zh').toLowerCase();
      } catch {
        return 'zh';
      }
    }

    function useT(localeSvc) {
      const [revision, bump] = useState(0);
      useEffect(() => {
        if (!localeSvc || typeof localeSvc.subscribe !== 'function') return undefined;
        const off = localeSvc.subscribe(() => bump((n) => n + 1));
        return typeof off === 'function' ? off : undefined;
      }, [localeSvc]);
      return useMemo(() => makeT(localeSvc), [localeSvc, revision]);
    }

    /**
     * Build the repository once per config.
     *
     * Phase 5: Radio Browser first, the deterministic mock catalogue as the
     * fallback. The loader keeps the stage hidden until this settles, and the
     * data chunk resolves to a repository in every case — a dead mirror, a
     * timeout or a garbage response must never leave the page blank.
     *
     * Phase 7: whenever a repository settles, its stations are merged into the
     * shared store. Merging (not replacing) is what lets a repository reload —
     * a different station count, a fall back to mock, a retry — keep the
     * selection and the favourites that were already made.
     */
    function useRadio(requireAsync, cfg, shared) {
      const [state, setState] = useState({
        status: 'idle',
        repository: null,
        categories: null,
        anchors: null,
        error: null,
        fallback: null,
      });

      useEffect(() => {
        if (!cfg) return undefined;
        let disposed = false;
        setState({ status: 'loading', repository: null, categories: null, anchors: null, error: null, fallback: null });
        // One catalogue for the whole plugin: the left-column card and this
        // panel await the same promise, so they cannot disagree about what the
        // stations are or hold two stores.
        const flight = shared && shared.ensureData ? shared.ensureData(requireAsync, cfg) : Promise.reject(new Error('no shared data'));
        flight
          .then((outcome) => {
            if (disposed) return;
            setState({
              status: 'ready',
              repository: outcome.repository,
              categories: outcome.categories,
              anchors: outcome.anchors,
              error: null,
              fallback: outcome.fallback,
            });
          })
          .catch((error) => {
            if (disposed) return;
            // Loading the chunk itself failed: the panel shows its data error,
            // the stage is simply not mounted.
            setState({ status: 'error', repository: null, categories: null, anchors: null, error: String(error), fallback: null });
          });
        return () => {
          disposed = true;
        };
      }, [requireAsync, cfg, shared]);

      return state;
    }

    /** One console line per fallback; cheap, and the only out-of-band trace. */
    function reportData(fallback) {
      try {
        console.warn('[blackhole-radio-lab] live data unavailable, showing mock stations:', fallback.reason, fallback.detail || '');
      } catch {
        /* console may be unavailable in an embedded frame */
      }
    }

    /* ------------------------------------------------------------------ *
     *  Shared state, one level above every view.
     *
     *  `apply()` creates this object and hands it to whatever mounts; the panel
     *  closing, the stage re-mounting or the WebGL context being released all
     *  happen strictly below it. Nothing in here knows what is on screen.
     *
     *    radio     the station index + business state (selection, favourites,
     *              likes). Same object for the black hole and the cluster.
     *    playback  the one audio owner. Two facts with two owners: `selected`
     *              lives in the store, `playing` lives here, and they are
     *              deliberately not mirrored into each other.
     *
     *  Phase 7 scope: in-memory, for the life of the plugin. Persistence is a
     *  seam on the store (`save()` / `load()`), not a decision made here.
     * ------------------------------------------------------------------ */
    function createSharedState() {
      const shared = {
        radio: null,
        playback: null,
        /** The IndexedDB handle, or null when this browser has no cache. */
        cache: null,
        health: null,
        autoCandidates: null,
        persistHealth() {
          if (shared.cache && shared.health && typeof shared.cache.writeHealth === 'function') {
            shared.cache.writeHealth(shared.health.save()).catch(() => { /* local evidence is optional */ });
          }
        },
        /** The radio chunk, once loaded: it owns the host-liveness logic. */
        radioChunk: null,
        /** "Is the host still there?" watch, or null until the chunk arrives. */
        hostWatch: null,
        /** 'on' while a hidden, audible page should probe, 'off' when it should not. */
        hostWatchSync: 'off',
        /** Subscription to the playback core that re-evaluates the watch. */
        offPlayback: null,
        /** visibilitychange handler; kept so dispose can remove it. */
        onVisibility: null,
        /** pagehide handler; kept so dispose can remove it. */
        onPageHide: null,
        /**
         * The one catalogue promise for the whole plugin.
         *
         * Only one component may fetch the data: the left-column card mounts
         * before the panel, the panel may be closed and reopened, and each of
         * them must see the same stations and the same store. This is the
         * single flight both of them await.
         */
        data: null,
        ensureData(requireAsync, cfg) {
          if (shared.data) return shared.data;
          // The footer may be the first caller and has no host config to pass,
          // so an absent config falls back to the same defaults the panel uses
          // rather than failing the one shared flight.
          // Host config wins where it speaks, defaults fill the rest: a config
          // file written before a knob existed must not silently turn it off.
          const conf = Object.assign({}, DEFAULT_CFG, cfg || {});
          const token = shared.lifecycle;
          shared.data = Promise.resolve()
            .then(() => requireAsync(RADIO_CHUNK))
            .then(async (radio) => {
              if (token !== shared.lifecycle) return null;
              const store = shared.ensureStore(radio.createRadioStore);
              let repository = null;
              let fallback = null;
              let rows = null;
              let fromCache = false;
              let fromSnapshot = false;

              // The cache is an optimisation, never a dependency: a private
              // window, a quota error or a blocked upgrade resolves to null and
              // the network path below runs exactly as it did before.
              const cache = typeof radio.openRadioCache === 'function' ? await radio.openRadioCache() : null;
              if (token !== shared.lifecycle) return null;
              shared.cache = cache;
              shared.bindEnv(radio);
              if (cache && shared.health && typeof cache.readHealth === 'function') {
                try {
                  const evidence = await cache.readHealth();
                  if (token !== shared.lifecycle) return null;
                  shared.health.load(evidence);
                } catch { /* unreadable evidence is unverified, never a missing station */ }
              }
              const repoOptions = {
                count: conf.stationCount,
                seed: conf.seed,
                featuredCount: conf.featuredCount,
                mode: conf.sourceMode || 'auto',
                limit: conf.sourceLimit,
                pageSize: conf.sourcePageSize,
                concurrency: conf.sourceConcurrency,
                timeoutMs: conf.sourceTimeoutMs,
                budgetMs: conf.sourceBudgetMs,
              };

              // The catalogue is cached per query shape: a larger limit or a
              // different order must fetch its own answer instead of reusing
              // the previous shape's rows for a day.
              const catalogKey = `catalog:v3:${conf.sourceLimit || 5000}:${conf.sourcePageSize || 500}:${conf.sourceOrder || 'clickcount'}`;

              // A catalogue younger than the TTL paints the scene without a
              // network round trip. Anything older is refetched; the cached
              // rows stay on disk until the fresh answer replaces them.
              if (cache && (conf.sourceMode || 'auto') !== 'mock' && (conf.sourceMode || 'auto') !== 'live') {
                try {
                  const cached = await cache.readCatalog(catalogKey);
                  if (cached && Date.now() - cached.fetchedAt <= radio.CATALOG_TTL_MS) {
                    // The cached rows were written by whichever path won last
                    // time (a 5000-row live fetch or a 12000-row snapshot), so
                    // the read-back limit must be the row count, not sourceLimit.
                    const cachedOptions = Object.assign({}, repoOptions, { limit: cached.rows.length });
                    const cachedRepository = radio.createRepositoryFromRows(cached.rows, cachedOptions);
                    if (cachedRepository && cachedRepository.list().length > 0) {
                      repository = cachedRepository;
                      fromCache = true;
                    }
                  }
                } catch {
                  /* an unreadable cache is the same as no cache */
                }
              }

              if (!repository) {
                // Second choice: the build-time directory, without requiring
                // streams to pass a health check before they can be searched.
                const mode = conf.sourceMode || 'auto';
                if (mode !== 'mock' && mode !== 'live') {
                  const snapshot = await fetchCatalogSnapshot(conf);
                  if (snapshot) {
                    // Use the whole snapshot instead of re-applying the
                    // live-fetch limit.
                    const snapshotOptions = Object.assign({}, repoOptions, { limit: snapshot.rows.length });
                    const snapshotRepository = radio.createRepositoryFromRows(snapshot.rows, snapshotOptions);
                    if (snapshotRepository && snapshotRepository.list().length > 0) {
                      repository = snapshotRepository;
                      rows = snapshot.rows;
                      fromSnapshot = true;
                      if (cache) {
                        // Cache it under the same key as a live answer: the
                        // next boot paints from IndexedDB instead of refetching
                        // the snapshot.
                        cache.writeCatalog(rows, snapshot.fetchedAt, catalogKey).catch(() => {
                          /* quota or private mode: the session still has the data */
                        });
                      }
                    }
                  }
                }
              }

              if (!repository) {
                try {
                  const outcome = await radio.createRadioRepository(repoOptions);
                  repository = outcome && outcome.repository ? outcome.repository : null;
                  fallback = outcome ? outcome.fallback : null;
                  rows = outcome && Array.isArray(outcome.rows) ? outcome.rows : null;
                } catch (error) {
                  // The chunk already guarantees a mock fallback; this only
                  // catches a failure below it (the mock generator itself).
                  repository = radio.createMockRadioRepository({
                    count: conf.stationCount,
                    seed: conf.seed,
                    featuredCount: conf.featuredCount,
                  });
                  fallback = { reason: 'error', detail: String(error), attempts: [] };
                }
                if (cache && rows && rows.length > 0) {
                  // Verbatim rows, not mapped stations: a cache must be able to
                  // re-map when the mapping changes. Not awaited: the scene
                  // paints first, the structured clone lands when it lands.
                  cache.writeCatalog(rows, Date.now(), catalogKey).catch(() => {
                    /* quota or private mode: the session still has the data */
                  });
                }
              }

              if (token !== shared.lifecycle) return null;
              if (store && repository) store.index(repository.list());
              // After the index, never before: the store restores only the marks
              // whose station it can already resolve, so the catalogue has to be
              // in the store first — otherwise every favourite would be dropped
              // for having no record to point at.
              if (store) await shared.hydrateLibrary(store);
              if (token !== shared.lifecycle) return null;
              if (!shared.env) shared.bindEnv(radio);
              if (fallback) {
                // Say it out loud: the rail must not present mock stations as live.
                reportData(fallback);
              }
              return {
                radio,
                store,
                repository,
                categories: repository ? repository.categories() : null,
                anchors: repository ? repository.anchors() : null,
                fallback,
                fromCache,
                fromSnapshot,
              };
            });
          return shared.data;
        },
        /**
         * Restore what the user marked last time, then keep writing it back.
         *
         * The store's `load()` only accepts keys it has already indexed, so this
         * has to run after the catalogue is in the store — which is why it is
         * awaited at the end of the data load rather than called when the store
         * is created. A Host that does not answer the route leaves the library
         * in memory, exactly as it behaved before the route existed.
         */
        lifecycle: 0,
        libraryLoaded: false,
        libraryHydrated: false,
        libraryTimer: 0,
        async hydrateLibrary(store) {
          if (!store || shared.libraryLoaded || typeof store.load !== 'function') return;
          shared.libraryLoaded = true;
          const token = shared.lifecycle;
          const current = () => token === shared.lifecycle && shared.radio === store;
          // Read what the previous store wrote, not what was there before it: the
          // write `dispose` started is not awaited there, so it is awaited here.
          if (libraryWriteInFlight) {
            try {
              await libraryWriteInFlight;
            } catch {
              /* a write that failed left the file as it was; the read still runs */
            }
          }
          if (!current()) return;
          try {
            const signal =
              typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
                ? AbortSignal.timeout(LIBRARY_READ_MS)
                : undefined;
            const res = await fetch(LIBRARY_URL, { cache: 'no-store', signal });
            if (res.ok) {
              const record = await res.json();
              if (!current()) return;
              // Merge, not replace: a mark made while this read was in flight is
              // newer than the file and must survive it.
              if (record && typeof record === 'object') {
                store.load(record);
              }
            }
          } catch {
            /* no route, no server, or a network hiccup: memory-only is correct */
          }
          if (!current()) return;
          shared.libraryHydrated = true;
          if (shared.playback) {
            const state = shared.playback.getState();
            shared.playback.setVolume(store.playbackMemory().volume);
            if (state.status === 'playing') store.rememberPlayed(state.stationId);
          }
          // Subscribed once, after the restore: a listener attached earlier would
          // answer the restore itself with a write of the record just read.
          if (typeof store.subscribe === 'function') store.subscribe(() => shared.queueLibraryWrite(store));
        },
        /**
         * Write the library back, once the marks settle.
         *
         * Every toggle would otherwise be its own request; the delay collapses a
         * burst (a list being cleared, a station liked twice) into one write.
         */
        queueLibraryWrite(store) {
          if (!store || typeof store.save !== 'function') return;
          if (shared.libraryTimer) clearTimeout(shared.libraryTimer);
          shared.libraryTimer = setTimeout(() => {
            shared.libraryTimer = 0;
            shared.flushLibrary(store);
          }, LIBRARY_WRITE_MS);
        },
        /**
         * Send the library now, without waiting out the delay.
         *
         * Used by the dispose path, where the marks are already made and the
         * timer is about to be thrown away with the store that scheduled it.
         */
        flushLibrary(store) {
          if (!store || typeof store.save !== 'function') return;
          let body = '';
          try {
            body = JSON.stringify(store.save());
          } catch {
            return;
          }
          try {
            // `keepalive` so a write started as the window closes still lands —
            // but only while the body fits the cap browsers put on such a
            // request. Above it the fetch throws, and a write that always throws
            // is a library that silently stops saving.
            const request = fetch(LIBRARY_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
              ...(body.length <= KEEPALIVE_MAX_CHARS ? { keepalive: true } : {}),
            })
              .then((res) => {
                // A refusal is not silent: the storage caps would otherwise make
                // the library stop growing with nothing said about it.
                if (!res.ok) console.warn(`[blackhole-radio-lab] library write refused: HTTP ${res.status}`);
                return res;
              })
              .catch((error) => {
                console.warn('[blackhole-radio-lab] library write failed', error);
              })
              .finally(() => {
                if (libraryWriteInFlight === request) libraryWriteInFlight = null;
              });
            libraryWriteInFlight = request;
          } catch {
            /* a fetch that cannot even start leaves the memory copy intact */
          }
        },
        /**
         * The data chunk is only loadable from a panel, so the store is built
         * on the first successful load and then reused for the plugin's life.
         */
        ensureStore(createStore) {
          if (!shared.radio && typeof createStore === 'function') shared.radio = createStore();
          return shared.radio;
        },
        ensurePlayback(createPlayback, options) {
          if (!shared.playback && typeof createPlayback === 'function') {
            shared.playback = createPlayback(Object.assign({}, options, {
              onStable(id) {
                if (shared.health) { shared.health.success(id); shared.persistHealth(); }
              },
              onFailure(id) {
                if (shared.health) { shared.health.failure(id); shared.persistHealth(); }
              },
              nextStation(excluded) {
                if (!shared.health) return null;
                const pool = shared.autoCandidates ? shared.autoCandidates() : playablePool(shared.radio);
                const next = shared.health.pick(pool, excluded);
                if (!next) return null;
                if (shared.radio) shared.radio.select(next);
                return { id: next.id, url: streamOf(next) };
              },
            }));
            if (shared.radio && shared.libraryHydrated) shared.playback.setVolume(shared.radio.playbackMemory().volume);
            // Listening evidence never changes the index, favourites or manual access.
            if (shared.playback && typeof shared.playback.subscribe === 'function') {
              shared.playback.subscribe((state) => {
                if (!state) return;
                if (shared.radio) {
                  if (shared.libraryHydrated) shared.radio.rememberVolume(state.volume);
                  if (state.status === 'playing') shared.radio.rememberPlayed(state.stationId);
                }
              });
            }
          }
          if (shared.bindMedia) shared.bindMedia();
          // The watch needs a playback core; if the chunk was already loaded
          // when this core appeared, this is where the two halves meet.
          shared.armHostWatch();
          return shared.playback;
        },
        /** The hls.js chunk, once fetched. Null while no station needs it. */
        hlsChunk: null,
        /** Shared in-flight chunk promise, so concurrent requests load it once. */
        hlsLoading: null,
        /**
         * The small amount of the data chunk the panel itself needs: genre
         * labels and colours for list headers, and the station-key function so
         * a list can compare a row's identity with the selection without
         * holding a second opinion about what identity means.
         */
        env: null,
        bindEnv(chunk) {
          if (shared.env || !chunk) return shared.env;
          if (!shared.health && typeof chunk.createStationHealth === 'function') shared.health = chunk.createStationHealth();
          // The chunk owns the host-liveness logic; the shared state owns the
          // page and the audio. Hand it over as soon as it exists.
          shared.armHostWatch(chunk);
          shared.bindMedia = () => {
            if (!shared.mediaDispose && shared.playback && typeof chunk.bindMediaSession === 'function') {
              shared.mediaDispose = chunk.bindMediaSession(shared.playback, (id) => shared.radio && shared.radio.getStation(id));
            }
          };
          shared.bindMedia();
          shared.env = {
            pollMetadata: chunk.pollMetadata,
            genreLabel: typeof chunk.genreLabel === 'function' ? chunk.genreLabel : (id) => String(id),
            genreCss: typeof chunk.genreCss === 'function' ? chunk.genreCss : () => '#9a9a9a',
            stationKey: typeof chunk.stationKey === 'function' ? chunk.stationKey : null,
            isMusicGenre: typeof chunk.isMusicGenre === 'function' ? chunk.isMusicGenre : () => false,
          };
          return shared.env;
        },
        /**
         * The first unload signal a page gets: stop before the renderer goes.
         *
         * A `pagehide` with `persisted` is the back/forward cache — the page is
         * coming back, so nothing may be disposed there.
         */
        watchUnload() {
          if (shared.onPageHide) return;
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
          shared.onPageHide = (event) => {
            if (event && event.persisted) return;
            shared.dispose();
          };
          window.addEventListener('pagehide', shared.onPageHide);
        },
        /**
         * Bind the "host is still there" watch.
         *
         * It needs two things that arrive in either order: the radio chunk
         * (which owns the logic) and a playback core (whose state says whether
         * anything is audible). Idempotent, and called again when the missing
         * half shows up.
         */
        armHostWatch(chunk) {
          if (chunk) shared.radioChunk = chunk;
          const api = shared.radioChunk;
          if (!api || typeof api.createHostWatch !== 'function') return;
          if (!shared.hostWatch) {
            shared.hostWatch = api.createHostWatch({
              probe: async () => {
                try {
                  const signal =
                    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
                      ? AbortSignal.timeout(HOST_PROBE_TIMEOUT_MS)
                      : undefined;
                  // Any answer means the server process is still listening. A
                  // 404 or 500 says the host is up but unhappy; only a refused
                  // or timed-out connection says the app is on its way out.
                  await fetch('/blackhole-radio-lab/config', {
                    headers: { accept: 'application/json' },
                    cache: 'no-store',
                    signal,
                  });
                  return true;
                } catch {
                  return false;
                }
              },
              active: () => shared.hostWatchSync === 'on',
              onDead: () => {
                // The host is gone, the page is not: silence the radio now
                // rather than keeping it audible until the window is killed.
                if (shared.playback && typeof shared.playback.stop === 'function') shared.playback.stop();
              },
            });
            shared.hostWatchSync = 'off';
            if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
              shared.onVisibility = () => syncHostWatch();
              document.addEventListener('visibilitychange', shared.onVisibility);
            }
          }
          if (!shared.offPlayback && shared.playback && typeof shared.playback.subscribe === 'function') {
            shared.offPlayback = shared.playback.subscribe(() => syncHostWatch());
          }
          syncHostWatch();
        },
        dispose() {
          shared.lifecycle += 1;
          // Page-level listeners belong to this session's page, not to the
          // module: a dispose that left them behind would probe for a host the
          // next session does not own.
          if (shared.offPlayback) {
            shared.offPlayback();
            shared.offPlayback = null;
          }
          if (shared.onVisibility && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', shared.onVisibility);
            shared.onVisibility = null;
          }
          if (shared.hostWatch) {
            shared.hostWatch.stop();
            shared.hostWatch = null;
          }
          if (shared.onPageHide && typeof window !== 'undefined') {
            window.removeEventListener('pagehide', shared.onPageHide);
            shared.onPageHide = null;
          }
          shared.radioChunk = null;
          shared.hostWatchSync = 'off';
          if (shared.mediaDispose) shared.mediaDispose();
          shared.mediaDispose = null;
          shared.bindMedia = null;
          if (shared.playback && typeof shared.playback.dispose === 'function') {
            try {
              shared.playback.dispose();
            } catch {
              /* the element may already be gone */
            }
          }
          shared.playback = null;
          // A write still waiting belongs to the store that is going away: send it
          // now, because the timer would die with this call and take the last
          // marks with it. Whatever has not been written yet is then only the
          // marks made after this point, and there are none.
          if (shared.libraryTimer) {
            clearTimeout(shared.libraryTimer);
            shared.libraryTimer = 0;
            shared.flushLibrary(shared.radio);
          }
          // The restored flag belongs to the store as well; a new store reads the
          // library again instead of inheriting "already restored".
          shared.libraryLoaded = false;
          shared.libraryHydrated = false;
          shared.radio = null;
          shared.data = null;
          shared.env = null;
          // The cache handle and listening scope belong to this lifetime.
          shared.cache = null;
          shared.health = null;
          shared.autoCandidates = null;
        },
      };

      /**
       * A local host either answers at once or is not there. Kept below the
       * watch interval: a probe that outlived its interval would count twice
       * for one slow answer, and two slow answers would look like a dead app.
       */
      const HOST_PROBE_TIMEOUT_MS = 2500;

      /**
       * Decide whether the host watch should run.
       *
       * Only a hidden page with audible output has a reason to ask whether the
       * app is still up: a visible page can see the window, a silent one has
       * nothing to silence.
       */
      const syncHostWatch = () => {
        const watch = shared.hostWatch;
        if (!watch) return;
        const state =
          shared.playback && typeof shared.playback.getState === 'function'
            ? shared.playback.getState()
            : null;
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        if (hidden && state && state.status === 'playing') {
          // Playing again is a new audible attempt: the previous verdict was
          // about an older attempt and must not silence this one unprobed.
          if (watch.isDead()) watch.rearm();
          shared.hostWatchSync = 'on';
          watch.start();
        } else {
          shared.hostWatchSync = 'off';
          watch.stop();
        }
      };

      return shared;
    }

    /**
     * Subscribe to a plain state object from React.
     *
     * `useSyncExternalStore` needs a snapshot that only changes when the store
     * really changed, so callers pass a selector and a `version` field: the
     * snapshot stays the previous object while the version is unchanged, and
     * React re-renders exactly once per mutation.
     */
    function useShared(shared, key, selector, deps) {
      const subject = shared ? shared[key] : null;
      const subscribe = useCallback(
        (listener) => (subject && typeof subject.subscribe === 'function' ? subject.subscribe(() => listener()) : () => {}),
        [subject],
      );
      // Memoised per version so the identity is stable between renders.
      const memo = useRef({ version: -1, value: undefined, source: null, deps: null });
      const getSnapshot = useCallback(() => {
        if (!subject) return undefined;
        const source = typeof subject.getSnapshot === 'function' ? subject.getSnapshot() : subject.getState();
        const version = source && typeof source.version === 'number' ? source.version : null;
        // A selector can depend on something the version alone does not track:
        // the card asks "is *this* station a favourite", and the station arrives
        // in a later render than the store does. Cache on the version only and
        // the answer to the earlier question is returned forever, because the
        // version it was computed at has not changed since. The dependencies are
        // part of the cache key for that reason, not for tidiness.
        const changedDeps = deps ? !memo.current.deps || memo.current.deps.some((value, index) => value !== deps[index]) : false;
        if (memo.current.source !== subject || (version !== null && memo.current.version !== version) || changedDeps) {
          memo.current = {
            version: version === null ? memo.current.version : version,
            value: selector(source),
            source: subject,
            deps: deps ? deps.slice() : null,
          };
        } else if (memo.current.value === undefined) {
          memo.current.value = selector(source);
        }
        return memo.current.value;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps ? [subject, ...deps] : [subject]);
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    /**
     * The active color scheme, for the few things a token cannot express — a
     * drawing that ships in two inks, one per scheme.
     *
     * The host owns the answer: the theme service resolves a preference of
     * `system` into a concrete `light` or `dark` before it publishes, and
     * re-publishes on the `theme/change` event when the preference switches or
     * the OS scheme flips. The media query is only the fallback for a host that
     * answered nothing, so the corner still picks an ink rather than nothing.
     */
    function createThemeSource(ctx) {
      const service = ctx && typeof ctx.get === 'function' ? ctx.get('theme') : null;
      const listeners = new Set();
      const read = () => {
        try {
          const snapshot = service && typeof service.getTheme === 'function' ? service.getTheme() : null;
          const scheme = snapshot && snapshot.active ? snapshot.active.colorScheme : '';
          if (scheme === 'dark' || scheme === 'light') return scheme;
        } catch {
          /* a theme service that refuses to answer is not a crash */
        }
        try {
          return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        } catch {
          return 'light';
        }
      };
      const emit = () => {
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            /* one listener's failure must not stop the others */
          }
        }
      };
      if (ctx && typeof ctx.on === 'function') {
        ctx.effect(() => ctx.on('theme/change', emit), 'blackhole-radio-lab: theme');
      }
      return {
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        getScheme: read,
      };
    }

    /** The active color scheme: 'light' or 'dark', never undefined. */
    function useColorScheme(shared) {
      const source = shared ? shared.theme : null;
      const subscribe = useCallback(
        (listener) => (source && typeof source.subscribe === 'function' ? source.subscribe(listener) : () => {}),
        [source],
      );
      const getSnapshot = useCallback(
        () => (source && typeof source.getScheme === 'function' ? source.getScheme() : 'light'),
        [source],
      );
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    /** The playback state, or a frozen idle snapshot when nothing is mounted. */
    const IDLE_PLAYBACK = Object.freeze({ status: 'idle', stationId: null, url: null, error: null, pendingMs: 0, slow: false, volume: 1 });

    /** Mount the private WebGL chunk; its lifetime is the panel's lifetime. */
    function useStage(requireAsync, container, settings, handleRef, attempt) {
      const [state, setState] = useState({ status: 'idle', info: null, error: null });

      useEffect(() => {
        if (!container || !settings) return undefined;
        let disposed = false;
        let handle = null;
        setState({ status: 'loading', info: null, error: null });

        Promise.resolve()
          .then(() => requireAsync(STAGE_CHUNK))
          .then((stage) => {
            if (disposed) return;
            handle = stage.mountStage(container, settings);
            if (handleRef) handleRef.current = handle;
            setState({ status: 'ready', info: handle.info, error: null });
          })
          .catch((error) => {
            if (disposed) return;
            setState({ status: 'error', info: null, error: String(error) });
          });

        return () => {
          disposed = true;
          if (handleRef) handleRef.current = null;
          if (handle) {
            try {
              handle.dispose();
            } catch {
              /* the context may already be gone with the detached canvas */
            }
            handle = null;
          }
        };
      }, [requireAsync, container, settings, handleRef, attempt]);

      return state;
    }

    /* ------------------------------------------------------------------ *
     *  StationCard — the one place a station's business actions live.
     *
     *  Every surface (black-hole overlay, cluster list, search results, mini
     *  player) renders this component, and every one of them calls the same
     *  two owners through it:
     *
     *      favourites / likes  →  shared.radio   (the store)
     *      play / pause        →  shared.playback (the core)
     *
     *  No view keeps its own copy of those facts, so there is nothing to
     *  synchronise: a favourite toggled on one surface is the same boolean the
     *  next surface reads. `useSyncExternalStore` does the propagation.
     * ------------------------------------------------------------------ */

    /** Small transport glyphs; inline so no icon package is needed. */
    function PlayGlyph({ size }) {
      const s = size || 14;
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { d: 'M4.5 2.6v10.8L13 8z', fill: 'currentColor' }),
      );
    }

    function PauseGlyph({ size }) {
      const s = size || 14;
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('rect', { x: 4, y: 2.6, width: 3, height: 10.8, rx: 0.8, fill: 'currentColor' }),
        h('rect', { x: 9, y: 2.6, width: 3, height: 10.8, rx: 0.8, fill: 'currentColor' }),
      );
    }

    function HeartGlyph({ size, filled }) {
      const s = size || 13;
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8 13.5S2 9.8 2 6.3A3.3 3.3 0 0 1 8 4.6a3.3 3.3 0 0 1 6 1.7c0 3.5-6 7.2-6 7.2z',
          fill: filled ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
      );
    }

    function StarGlyph({ size, filled }) {
      const s = size || 13;
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8 1.9l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.7 4.2 13.7l.7-4.3-3.1-3 4.3-.6z',
          fill: filled ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinejoin: 'round',
        }),
      );
    }

    function PrevGlyph({ size }) {
      const s = size || 13;
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { d: 'M4 3v10', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', {
          d: 'M12.5 3.6v8.8L5.6 8z',
          fill: 'currentColor',
          stroke: 'currentColor',
          strokeWidth: 0.8,
          strokeLinejoin: 'round',
        }),
      );
    }

    function NextGlyph({ size }) {
      const s = size || 13;
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { d: 'M12 3v10', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', {
          d: 'M3.5 3.6v8.8L10.4 8z',
          fill: 'currentColor',
          stroke: 'currentColor',
          strokeWidth: 0.8,
          strokeLinejoin: 'round',
        }),
      );
    }

    function VolumeGlyph({ size }) {
      const s = size || 12;
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3 6h2.2L8 3.6v8.8L5.2 10H3z',
          fill: 'currentColor',
          stroke: 'currentColor',
          strokeWidth: 0.8,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M10.4 5.6a3.2 3.2 0 0 1 0 4.8M12.4 4a5.6 5.6 0 0 1 0 8',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
        }),
      );
    }

    /**
     * The stream a station should be played from, resolved defensively.
     *
     * The repository speaks `streamUrl`; the older names are kept because a
     * cached row or a future source may use them. A record with no absolute
     * http(s) address has no stream — a mock station never does, and a card
     * whose transport is disabled for that reason is telling the truth.
     */
    function streamOf(station) {
      if (!station) return null;
      const candidates = [station.streamUrl, station.stream, station.url, station.urlResolved, station.url_resolved];
      const metadata = station.metadata && typeof station.metadata === 'object' ? station.metadata : {};
      candidates.push(metadata.streamUrl, metadata.stream, metadata.url, metadata.urlResolved);
      for (const value of candidates) {
        if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
      }
      return null;
    }

    /**
     * The displayable facts of a record that the card shows beyond its name.
     *
     * Everything is read from what the catalogue already carries; a missing
     * field yields an empty value and the card renders no line for it. Nothing
     * here invents a tag, a genre or a bitrate that the source did not send.
     */
    function stationInfoOf(station) {
      const metadata = station && station.metadata && typeof station.metadata === 'object' ? station.metadata : {};
      const rawTags = Array.isArray(metadata.tags) ? metadata.tags : [];
      const tags = [];
      const seen = new Set();
      for (const tag of rawTags) {
        if (typeof tag !== 'string') continue;
        const clean = tag.trim().toLowerCase();
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        tags.push(clean);
        if (tags.length >= 12) break;
      }
      const bitrate = Number(metadata.bitrate);
      return {
        tags,
        codec: typeof metadata.codec === 'string' && metadata.codec.trim() ? metadata.codec.trim() : '',
        bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 0,
        hls: metadata.hls === true,
        playable: metadata.playable !== false,
      };
    }


    /**
     * What the card reads when no station is selected.
     *
     * The same shape `stationInfoOf` returns, with every field empty: the card
     * then draws its placeholder without a single branch inside the layout, and
     * nothing can be mistaken for a real bitrate, codec or tag.
     */
    const EMPTY_STATION_INFO = { tags: [], codec: '', bitrate: 0, hls: false, playable: false };

    /**
     * The song a stream last reported, and the station it belongs to.
     *
     * A title only counts while it belongs to the station currently on the card:
     * switching stations must never leave the previous station's song behind.
     */
    const EMPTY_NOW_PLAYING = { stationId: '', title: '' };

    /**
     * Where a song name goes when it is pressed.
     *
     * A radio title is text and nothing else — no album, no ISRC, no platform
     * id (`src/host/now-playing.js` reads one ICY block) — so a click cannot
     * address a track. The most it can honestly do is put the same question to
     * a platform in that platform's own words, which is why every entry below
     * is a *search* route and never a track route.
     */
    const SONG_PLATFORMS = Object.freeze([
      { id: 'spotify', href: (q) => `https://open.spotify.com/search/${encodeURIComponent(q)}` },
      { id: 'netease', href: (q) => `https://music.163.com/#/search/m/?type=1&s=${encodeURIComponent(q)}` },
      { id: 'qq', href: (q) => `https://y.qq.com/n/ryqq/search?w=${encodeURIComponent(q)}` },
      { id: 'apple', href: (q) => `https://music.apple.com/search?term=${encodeURIComponent(q)}` },
      { id: 'youtube', href: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
    ]);
    const DEFAULT_SONG_PLATFORM = 'spotify';
    const SONG_PLATFORM_KEY = 'bhrl.song-platform';

    const songPlatformOf = (id) =>
      SONG_PLATFORMS.find((entry) => entry.id === id) ||
      SONG_PLATFORMS.find((entry) => entry.id === DEFAULT_SONG_PLATFORM);

    /** The chosen platform, or the default when the store has nothing usable. */
    function readSongPlatform() {
      try {
        const stored = String(window.localStorage.getItem(SONG_PLATFORM_KEY) || '');
        return SONG_PLATFORMS.some((entry) => entry.id === stored) ? stored : DEFAULT_SONG_PLATFORM;
      } catch {
        return DEFAULT_SONG_PLATFORM;
      }
    }

    function writeSongPlatform(id) {
      try {
        window.localStorage.setItem(SONG_PLATFORM_KEY, id);
      } catch {
        /* A browser that refuses storage still gets the click; the choice just
         * does not survive the reload. */
      }
    }


    /* ------------------------------------------------------------------ *
     *  Nothing but the glass itself.
     *
     *  The card's material is the app's own menu surface — one fill token and
     *  one backdrop-filter token — and nothing else: no border, no shadow, no
     *  inner highlight, no refraction pass. Earlier revisions layered all of
     *  those on top; each was removed on request so what is left is the plain
     *  sheet of frosted glass every DSH menu already uses.
     * ------------------------------------------------------------------ */


    /**
     * One line of fixed length that scrolls instead of truncating.
     *
     * The card's two text lines are a fixed size by contract (the box is
     * 236x93 in every state, and the mark next to each line must not wander).
     * When the text is longer than the slot it advances and returns, so the
     * whole name stays readable without a tooltip and without changing height.
     */
    function OverflowText(props) {
      const { tag, className, text } = props;
      const boxRef = useRef(null);
      const innerRef = useRef(null);
      const [shift, setShift] = useState(0);

      useEffect(() => {
        const box = boxRef.current;
        const inner = innerRef.current;
        if (!box || !inner) return undefined;
        const measure = () => {
          const over = Math.round(inner.scrollWidth - box.clientWidth);
          setShift(over > 1 ? over : 0);
        };
        measure();
        if (typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(box);
        observer.observe(inner);
        return () => observer.disconnect();
      }, [text]);

      return h(
        tag,
        {
          ref: boxRef,
          className,
          'data-overflow': shift > 0 ? 'true' : 'false',
          style: shift > 0 ? { '--bhrl-shift': `${shift}px` } : undefined,
        },
        h('span', { ref: innerRef, className: 'bhrl-fcard__scroll' }, text),
      );
    }


    /**
     * The card's own entry to the hole: a small ringed disc, the same object
     * the panel renders, at 22px. It replaces the genre pill that used to sit
     * in this corner — the genre now rides on the meta line, and this corner
     * becomes the one door to the hole.
     */
    function HoleGlyph(props) {
      const size = props && props.size ? props.size : 22;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', focusable: 'false', 'aria-hidden': 'true' },
        h('ellipse', {
          cx: 12,
          cy: 12,
          rx: 10.6,
          ry: 4.2,
          stroke: 'currentColor',
          strokeWidth: '1',
          opacity: '0.45',
          transform: 'rotate(-18 12 12)',
        }),
        h('circle', { cx: 12, cy: 12, r: 7.1, stroke: 'currentColor', strokeWidth: '1.3', opacity: '0.7' }),
        h('circle', { cx: 12, cy: 12, r: 3.5, fill: 'currentColor' }),
      );
    }


    /**
     * One station's card.
     *
     * Props:
     *   station    the record
     *   shared     { radio, playback } — the two owners
     *   t          translator
     *   variant    'card' (default) | 'row' (compact list row) | 'chip'
     *   active     whether this is the station the stage has selected
     *   onFocus    optional: bring it into view / widen a cluster
     *   onClose    optional: dismiss the surface this card sits on
     */
    function StationCard(props) {
      const { station, shared, t, variant, active, onFocus, onClose } = props;
      const store = shared ? shared.radio : null;
      const playback = shared ? shared.playback : null;

      const favourite = useShared(shared, 'radio', (snapshot) => (store ? store.isFavorite(station) : false), [store, station]);
      const player = useShared(
        shared,
        'playback',
        (snapshot) => {
          const mine = snapshot && station && String(snapshot.stationId) === String(station.id);
          return mine ? snapshot.status : 'other';
        },
        [station],
      );

      if (!station) return null;
      const stream = streamOf(station);
      const isPlaying = player === 'playing' || player === 'loading';
      const isMine = player !== 'other';
      const country = (station.country && (station.country.en || station.country.zh)) || '';
      const language = (station.language && (station.language.en || station.language.zh)) || '';
      const genreId = station.genre || 'other';

      const togglePlay = (event) => {
        if (event) event.stopPropagation();
        if (!playback) return;
        if (isMine && player === 'playing') playback.pause();
        else if (isMine && player === 'paused') playback.resume();
        else if (stream) playback.play(station.id, stream);
      };
      const toggleFavourite = (event) => {
        if (event) event.stopPropagation();
        if (store) store.toggleFavorite(station);
      };
      const focus = (event) => {
        if (event) event.stopPropagation();
        if (onFocus) onFocus(station);
        else if (store) store.select(station);
      };

      const transport = h(
        'button',
        {
          type: 'button',
          className: `bhrl-act bhrl-act-play${isMine ? ' is-mine' : ''}`,
          onClick: togglePlay,
          disabled: !stream || !playback,
          'aria-label': isPlaying ? t('pauseAction') : t('playAction'),
          'aria-pressed': isPlaying ? 'true' : 'false',
        },
        isPlaying ? h(PauseGlyph) : h(PlayGlyph),
      );

      const favButton = h(
        'button',
        {
          type: 'button',
          className: `bhrl-act${favourite ? ' is-on' : ''}`,
          onClick: toggleFavourite,
          'aria-label': favourite ? t('unfavouriteAction') : t('favouriteAction'),
          'aria-pressed': favourite ? 'true' : 'false',
        },
        h(StarGlyph, { filled: favourite }),
      );

      // Everything below is read from the record itself, or from nothing at
      // all. `info` is the raw metadata the catalogue kept; a field that the
      // source did not send is simply absent, never guessed.
      const info = stationInfoOf(station);

      // The play state of *this* station, spelled out. `player` is 'other' for
      // every station that is not the one the audio element is attached to,
      // which is a different fact from "this station is paused".
      const stateBadge =
        player === 'playing'
          ? h('span', { className: 'bhrl-state is-playing' }, h('i', { className: 'bhrl-eq is-on', 'aria-hidden': 'true' }), t('cardPlayingState'))
          : player === 'paused'
            ? h('span', { className: 'bhrl-state is-paused' }, t('cardPausedState'))
            : null;

      if (variant === 'chip') {
        return h(
          'span',
          { className: `bhrl-chip${active ? ' is-active' : ''}${isMine ? ' is-mine' : ''}` },
          h(
            'button',
            { type: 'button', className: 'bhrl-chip-name', onClick: focus },
            isMine && isPlaying ? h('i', { className: 'bhrl-eq', 'aria-hidden': 'true' }) : null,
            h('span', null, station.name),
          ),
          transport,
          favButton,
        );
      }

      if (variant === 'row') {
        // The compact form of the same card: the same record, the same two
        // operations, the same state read from the same two owners. It is
        // compact in layout only — nothing it can do is missing here.
        return h(
          'li',
          {
            className: `bhrl-row${active ? ' is-active' : ''}${isMine ? ' is-mine' : ''}`,
            'data-status': isMine ? player : undefined,
            'data-key': station.id,
          },
          h(
            'button',
            { type: 'button', className: 'bhrl-row-main', onClick: focus },
            h('span', { className: 'bhrl-row-name' }, station.name),
            h(
              'span',
              { className: 'bhrl-row-meta' },
              [
                country,
                language,
                t(`genre_${String(genreId).replace(/[^a-z0-9]/gi, '')}`),
                info.bitrate ? `${info.bitrate} kbps` : '',
              ]
                .filter(Boolean)
                .join(' · '),
            ),
            info.tags.length
              ? h(
                  'span',
                  { className: 'bhrl-row-tags' },
                  info.tags.slice(0, 3).map((tag) => h('span', { className: 'bhrl-tag', key: tag }, tag)),
                )
              : null,
          ),
          stateBadge,
          h('span', { className: 'bhrl-row-acts' }, transport, favButton),
        );
      }

      // No third shape. `chip` and `row` are the two list forms; the station
      // itself is drawn by `StationFootCard`, in the one place the station
      // exists as a card.
      return null;
    }

    /*
     * FROZEN (2026-10-30): the left-column station card — this history, its
     * buttons and its styles — changes only with the user's explicit second
     * confirmation. See AGENTS.md.
     */

    /**
     * What played before the current station.
     *
     * Module scope on purpose: "previous" is a fact about the listening
     * session, not about one mount of the card. Bounded, so a long session
     * cannot grow it without limit.
     */
    const PLAY_HISTORY_MAX = 20;
    const playHistory = [];
    // Where in `playHistory` the station on the card sits. Going back moves
    // this cursor instead of appending, so "previous" walks the log the way a
    // transport does: A → B → C, back is B, back again is A.
    let playHistoryCursor = -1;

    function notePlayed(stationId) {
      const id = stationId === null || stationId === undefined ? '' : String(stationId);
      if (!id) return;
      // Starting the station the cursor already points at is not a new entry:
      // a resume, or the history write that follows going back, must not fork
      // the log.
      if (playHistoryCursor >= 0 && playHistory[playHistoryCursor] === id) return;
      // A station started from anywhere but "previous" begins a new branch:
      // the entries ahead of the cursor belong to a future that never happened.
      if (playHistoryCursor + 1 < playHistory.length) playHistory.length = playHistoryCursor + 1;
      playHistory.push(id);
      if (playHistory.length > PLAY_HISTORY_MAX) playHistory.shift();
      playHistoryCursor = playHistory.length - 1;
    }

    /** Every record that can actually be played — the pool the random next draws from. */
    function playablePool(store) {
      if (!store || typeof store.stations !== 'function') return [];
      try {
        return store.stations().filter((station) => !!streamOf(station));
      } catch {
        return [];
      }
    }

    /*
     * FROZEN (2026-10-30): the left-column station card — this component, its
     * buttons and its styles — changes only with the user's explicit second
     * confirmation. See AGENTS.md.
     */

    /**
     * The station, as a card.
     *
     * This is the only card in the plugin, and it is the station: it is drawn
     * in the sidebar foot, which outlives the panel, its stage and every view
     * inside it. Every scene only writes `selectedStationId` into the store;
     * this card reads that plus the playback snapshot, and every button it
     * draws calls the shared owners rather than keeping a local copy.
     *
     * Semantics, fixed here so no view invents its own: the star marks the
     * station itself, the heart marks the song the stream is publishing — and
     * is dead when there is no song — the middle button plays or pauses the
     * station being shown, and the button to its right plays a random station
     * from the whole catalogue. A right-click on a mark unfolds the list it
     * owns, and a right-click on the song line picks the platform it opens in.
     */
    function StationFootCard(props) {
      const { station, shared, t, onOpen, lang } = props;
      const store = shared ? shared.radio : null;
      const playback = shared ? shared.playback : null;

      const favourite = useShared(shared, 'radio', () => (store && station ? store.isFavorite(station) : false), [store, station]);
      const playState = useShared(shared, 'playback', (snapshot) => snapshot || IDLE_PLAYBACK, [shared, shared && shared.playback]);
      // The catalog lands after this card has already mounted, and the booleans
      // above never change on that event, so React would keep a placeholder
      // card with a dead play button. Subscribing to the playable count itself
      // makes the button honest: it wakes up the moment there is something to
      // shuffle, with no selection needed first.
      const playableCount = useShared(
        shared,
        'radio',
        () =>
          store && typeof store.stations === 'function'
            ? store.stations().filter((candidate) => !!streamOf(candidate)).length
            : 0,
        [store],
      );
      // What the station last said it was playing. Kept beside the station it
      // came from: a title only counts while its station is the one on the
      // card, so switching stations can never leave the last song behind.
      const [nowPlaying, setNowPlaying] = useState(EMPTY_NOW_PLAYING);
      // The mark whose list is unfolded, and where its panel is pinned. The
      // panel is an overlay positioned from the mark's own rectangle, because
      // the sidebar would clip anything drawn inside the card's box.
      const [reveal, setReveal] = useState(null);
      // Which platform a pressed song name asks. The stored word is only
      // trusted while it still names a platform this build knows about.
      const [platformId, setPlatformId] = useState(readSongPlatform);
      // The corner drawing ships in two inks; this is which one to draw.
      const scheme = useColorScheme(shared);
      // The line that owns the gesture and the panel it unfolds: a picker
      // opened by a right-click has to take the focus itself and give it back.
      const linkRef = useRef(null);
      const popupRef = useRef(null);
      // The marks themselves: an unfolded list is closed with Escape, and the
      // keyboard has to land back on the mark that opened it rather than on the
      // body of the page.
      const favRef = useRef(null);
      const likeRef = useRef(null);
      // An unfolded list is a popup, so it closes the ways a popup does: Escape,
      // or a press anywhere that is not the panel and not one of the two marks.
      useEffect(() => {
        if (!reveal) return undefined;
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          const kind = reveal.kind;
          setReveal(null);
          // Escape must not drop the keyboard on the body: it goes back to what
          // opened the panel — the song line, or the mark whose list it is.
          const back = kind === 'platform' ? linkRef.current : kind === 'stations' ? favRef.current : likeRef.current;
          if (back) back.focus();
        };
        const onPress = (event) => {
          const node = event.target;
          if (!node || typeof node.closest !== 'function') return;
          if (node.closest('.bhrl-favpop') || node.closest('.bhrl-act')) return;
          setReveal(null);
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('pointerdown', onPress, true);
        return () => {
          window.removeEventListener('keydown', onKey);
          window.removeEventListener('pointerdown', onPress, true);
        };
      }, [reveal]);

      // A picker opened by a press has to place the focus itself: the keyboard
      // lands on the current platform instead of starting again from the top of
      // the card.
      useEffect(() => {
        if (!reveal || reveal.kind !== 'platform') return;
        const panel = popupRef.current;
        if (!panel) return;
        const option = panel.querySelector('.bhrl-favpop__opt.is-on') || panel.querySelector('.bhrl-favpop__opt');
        if (option) option.focus();
      }, [reveal]);

      // Keep a short log of what the audio element has actually played, so
      // "previous" means the station heard before this one. It follows the
      // transport rather than one button: a station started from the panel or
      // the stage must be able to become "previous" as well.
      useEffect(() => {
        const id = playState && playState.stationId ? String(playState.stationId) : null;
        if (!id || !playState || playState.status === 'idle') return;
        notePlayed(id);
      }, [playState && playState.stationId, playState && playState.status]);

      // The card *is* the radio, so it is always on screen: with nothing
      // selected it keeps the same shell, the same 236x93 box and the same
      // controls, and only its content is a placeholder. An empty state here
      // would be a second, taller, differently shaped radio body.
      const hasStation = !!station;
      const stream = hasStation ? streamOf(station) : '';
      const isMine =
        hasStation && !!playState && playState.status !== 'idle' && String(playState.stationId) === String(station.id);
      const status = isMine ? playState.status : 'other';
      const playing = status === 'playing';
      const busy = status === 'loading';
      const volume = playState && typeof playState.volume === 'number' ? playState.volume : 1;

      const info = hasStation ? stationInfoOf(station) : EMPTY_STATION_INFO;
      const genreId = (hasStation && station.genre) || '';
      const genreLabel = hasStation
        ? t(`genre_${String(genreId || 'other').replace(/[^a-z0-9]/gi, '')}`)
        : t('cardStationLabel');
      // Not every stream publishes a song. A news or talk station puts its
      // programme name in the very same field, so the genre decides whether a
      // title counts as a song at all.
      const isMusic = hasStation && !!(shared && shared.env && shared.env.isMusicGenre(genreId));
      // Whether a shuffle has anything to draw from — from the subscription
      // above, so it cannot be frozen at the empty-catalog value.
      const canPick = playableCount > 0;

      /**
       * Ask the Host what this station is playing.
       *
       * The browser cannot read ICY metadata from another origin, and a stream
       * never ends, so the Host reads exactly one metadata block and caches it;
       * this only has to ask. The question is asked while the card's own
       * station is playing music — a pause keeps the last answer, because
       * pausing does not change what the stream is playing.
       */
      useEffect(() => {
        if (!hasStation || !stream || !isMine || status !== 'playing' || !isMusic) return undefined;
        const id = String(station.id);
        if (!shared.env || typeof shared.env.pollMetadata !== 'function') return undefined;
        return shared.env.pollMetadata({
          url: `${NOW_PLAYING_URL}?url=${encodeURIComponent(stream)}`,
          intervalMs: NOW_PLAYING_POLL_MS,
          onResult(body) {
            const title = body && typeof body.title === 'string' ? body.title.trim().slice(0, 160) : '';
            setNowPlaying((previous) =>
              previous.stationId === id && previous.title === title ? previous : { stationId: id, title },
            );
          },
        });
      }, [hasStation, stream, isMine, status, isMusic, station && station.id]);

      // The song on the card: the station's own title, and only while that
      // station is the one showing it.
      const songTitle = hasStation && isMusic && nowPlaying.stationId === String(station.id) ? nowPlaying.title : '';
      const song = songTitle
        ? {
            title: songTitle,
            artist: songTitle.includes(' - ') ? songTitle.slice(0, songTitle.indexOf(' - ')).trim() : '',
            stationKey: shared && shared.env && shared.env.stationKey ? shared.env.stationKey(station) : '',
            stationName: station.name,
          }
        : null;
      // `liked` depends on which song is on the card, not only on the store, and
      // `useShared` memoises a selector per store version — so it is subscribed
      // here as a bare version and the answer is derived from it instead.
      const radioVersion = useShared(shared, 'radio', () => (store ? store.getSnapshot().version : 0), [store]);
      const liked = useMemo(
        () => (store && song ? store.isSongLiked(song.title) : false),
        [store, song && song.title, radioVersion],
      );
      const favouriteStations = useShared(shared, 'radio', () => (store ? store.favoriteStations() : []), [store]);
      const likedSongs = useShared(shared, 'radio', () => (store ? store.likedSongs() : []), [store]);

      /**
       * Start a station: the transport and the selection move together.
       *
       * "What plays" and "what the card shows" are one decision — a next/prev
       * that plays X while the card keeps showing Y would leave the whole rail
       * lying about the current station.
       */
      const startStation = (next) => {
        if (!playback || !next) return;
        const nextStream = streamOf(next);
        if (!nextStream) return;
        notePlayed(next.id);
        if (store && typeof store.select === 'function') store.select(next);
        playback.play(next.id, nextStream);
      };

      const togglePlay = () => {
        if (!playback) return;
        // The card is the radio, so it is usable before anything is selected:
        // pressing play here starts a random station rather than being dead.
        // Listening never requires a trip to the hole first.
        if (!hasStation) {
          playRandom();
          return;
        }
        if (isMine && status === 'playing') playback.pause();
        else if (isMine && status === 'paused') playback.resume();
        else if (stream) startStation(station);
      };

      /**
       * Go back one station.
       *
       * The cursor walks the log backwards; the log itself is left intact, so
       * pressing back twice after A → B → C lands on A rather than toggling.
       * A station that no longer resolves to a playable stream is skipped, and
       * the cursor only moves when there is really something to play.
       */
      const playPrevious = () => {
        if (!playback) return;
        const currentId = playState && playState.stationId ? String(playState.stationId) : '';
        const from = playHistoryCursor >= 0 ? playHistoryCursor : playHistory.length - 1;
        for (let index = from - 1; index >= 0; index -= 1) {
          const id = playHistory[index];
          if (!id || id === currentId) continue;
          const next = store ? store.getStation(id) : null;
          if (!next) continue;
          const nextStream = streamOf(next);
          if (!nextStream) continue;
          // Move the cursor before playing: the transport write that follows
          // must read as "still this entry", not as a new branch.
          playHistoryCursor = index;
          if (store && typeof store.select === 'function') store.select(next);
          playback.play(next.id, nextStream);
          return;
        }
      };

      /**
       * Shuffle: the button to the right of play, and what play does when the
       * card has no station to resume yet. It never returns the station the
       * card is already showing, so "next" always means a different one.
       *
       * The button is only live once a station is on the card, so the no-station
       * call always comes from play: that is the single way to start listening.
       */
      const playRandom = () => {
        const pool = playablePool(store);
        if (!playback || pool.length === 0) return;
        const currentId = hasStation ? String(station.id) : '';
        const others = pool.filter((candidate) => String(candidate.id) !== currentId);
        const bag = others.length > 0 ? others : pool;
        startStation(bag[Math.floor(Math.random() * bag.length)]);
      };

      const changeVolume = (event) => {
        const value = Number(event.target.value);
        if (!playback || !Number.isFinite(value)) return;
        if (store) store.rememberVolume(value / 100);
        playback.setVolume(value / 100);
      };

      // Second line: the song while the stream publishes one; otherwise the
      // station itself, in the one shape the card promises —
      // `genre · tags · language · bitrate kbps`.
      const localized = (value) => {
        if (!value) return '';
        if (typeof value === 'string') return value;
        return String(value[lang] || value.en || value.zh || '');
      };
      // `countries.js` answers "language not stated" / "unknown region" with a
      // placeholder instead of an empty string. On the card a placeholder is
      // noise: the line drops it and keeps only the facts the source really has.
      const UNKNOWN_LABELS = new Set(['语言未标注', 'Unspecified', '地区未知', 'Unknown region']);
      const knownLabel = (value) => {
        const text = localized(value);
        return UNKNOWN_LABELS.has(text) ? '' : text;
      };
      const format = [info.codec ? String(info.codec).toUpperCase() : '', info.bitrate ? `${Math.round(info.bitrate)}kbps` : '']
        .filter(Boolean)
        .join(' ');
      const stationMeta = hasStation
        ? [
            genreLabel,
            info.tags.join(','),
            knownLabel(station.language),
            info.bitrate ? `${Math.round(info.bitrate)} kbps` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
      const trackLine = songTitle || stationMeta || (format ? `${t('liveStream')} · ${format}` : t('liveStream'));
      const displayName = hasStation ? station.name : t('fcardEmptyName');
      // Every state of the card is expressed on this one line, never as an
      // extra row: the box is 236x93 for the placeholder, for a playing
      // station, and for a station that cannot be played at all.
      const displayTrack = !hasStation
        ? t('fcardEmptyHint')
        : status === 'error'
          ? t('playbackError')
          : !stream
            ? t('unavailable')
            : trackLine;

      // The card carries no hover tooltips: `aria-label` names each control for
      // assistive tech, and nothing pops a text bubble over the artwork.
      const actButton = (className, onClick, label, glyph, extra) =>
        h(
          'button',
          Object.assign(
            {
              type: 'button',
              className: `bhrl-act ${className}`,
              onClick,
              'aria-label': label,
            },
            extra || {},
          ),
          glyph,
        );

      // Each mark owns one list and sits next to the line it belongs to: the
      // star is the station, the heart is the song. A press on a mark is still
      // just its toggle, so the list hangs on the other button instead — the
      // same right-click the song line uses for its platform picker. One
      // gesture opens every panel on the card, and no panel can open by the
      // pointer merely travelling across the card.

      // Where the panel hangs. It is aligned to the side of the mark that has
      // room: the sidebar sits on the left, so a mark there grows rightward,
      // and the clamp keeps the whole box inside the viewport.
      const FAVPOP_WIDTH = 208;
      const unfoldList = (kind, node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return;
        const rect = node.getBoundingClientRect();
        const bottom = Math.max(8, Math.round(window.innerHeight - rect.top + 8));
        const room = Math.max(8, window.innerWidth - 8 - FAVPOP_WIDTH);
        const place =
          rect.left <= window.innerWidth / 2
            ? { left: Math.min(Math.max(8, Math.round(rect.left)), room) }
            : { right: Math.min(Math.max(8, Math.round(window.innerWidth - rect.right)), room) };
        setReveal(Object.assign({ kind, bottom }, place));
      };
      // The two marks open their list the way the song line opens the platform
      // picker: the right button with a mouse, the context-menu key or
      // Shift+Enter with a keyboard. Nothing opens on hover, so a pointer
      // crossing the card cannot pop a panel over it.
      const listHandlers = (kind) => ({
        onContextMenu: (event) => {
          event.preventDefault();
          unfoldList(kind, event.currentTarget);
        },
        onKeyDown: (event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'Enter')) {
            event.preventDefault();
            unfoldList(kind, event.currentTarget);
          }
        },
      });

      // The song line is the one part of the card that leaves it: a press asks
      // the chosen platform the same question, and a right-click asks *which*
      // platform that is. Left and right are separate buttons, so neither one
      // can be mistaken for the other and there is nothing to cancel.
      //
      // The line only becomes a link while it really is the song. An error or
      // an unplayable stream puts its own words on that line, and those words
      // must not dress up as a search for a title that is not playing.
      const songLink = !!song && status !== 'error' && !!stream;
      const songHref = songLink ? songPlatformOf(platformId).href(song.title) : '';
      const songHandlers = songLink
        ? {
            // The platform menu is ours, not the browser's: the link's own menu
            // has nothing to offer here, and the panel replaces it.
            onContextMenu: (event) => {
              event.preventDefault();
              unfoldList('platform', event.currentTarget);
            },
            // The same menu without a second mouse button, for the keyboard:
            // the context-menu key and Shift+Enter both mean "ask, do not go".
            onKeyDown: (event) => {
              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'Enter')) {
                event.preventDefault();
                unfoldList('platform', event.currentTarget);
              }
            },
          }
        : {};

      // A mark is never really `disabled`: a disabled button stops firing
      // pointer events, and that would take the list away exactly when it is
      // the only way to reach it. The click guards itself, and the dimming is
      // driven by `aria-disabled` so a right-click still unfolds the panel.
      const favouriteButton = actButton(
        `bhrl-act-fav${favourite ? ' is-on' : ''}`,
        () => store && hasStation && store.toggleFavorite(station),
        favourite ? t('unfavouriteAction') : t('favouriteAction'),
        h(StarGlyph, { size: 12, filled: favourite }),
        Object.assign(
          {
            ref: favRef,
            'aria-pressed': favourite ? 'true' : 'false',
            'aria-disabled': !hasStation || !store ? 'true' : 'false',
            'aria-haspopup': 'dialog',
            'aria-expanded': reveal && reveal.kind === 'stations' ? 'true' : 'false',
          },
          listHandlers('stations'),
        ),
      );
      const likeButton = actButton(
        `bhrl-act-like${liked ? ' is-on' : ''}`,
        () => store && song && store.toggleSongLike(song),
        !song ? t('likeUnavailable') : liked ? t('unlikeSongAction') : t('likeSongAction'),
        h(HeartGlyph, { size: 11, filled: liked }),
        Object.assign(
          {
            ref: likeRef,
            'aria-pressed': liked ? 'true' : 'false',
            'aria-disabled': !song || !store ? 'true' : 'false',
            'aria-haspopup': 'dialog',
            'aria-expanded': reveal && reveal.kind === 'songs' ? 'true' : 'false',
          },
          listHandlers('songs'),
        ),
      );

      // The unfolded list. It is an overlay pinned to the mark's corner, so it
      // is never clipped by the foot and never moves the card's 236x93 box.
      const pickingPlatform = !!reveal && reveal.kind === 'platform';
      const listEntries =
        reveal && !pickingPlatform ? (reveal.kind === 'stations' ? favouriteStations : likedSongs) : [];
      const popoverTitle = pickingPlatform
        ? t('platformPickerTitle')
        : reveal && reveal.kind === 'stations'
          ? t('favouriteListTitle')
          : t('likeListTitle');
      // One row per platform. The current one is marked, and choosing another
      // both answers this press and becomes what the next press uses.
      const platformRow = (entry) => {
        const current = entry.id === platformId;
        return h(
          'li',
          { key: entry.id },
          h(
            'button',
            {
              type: 'button',
              className: `bhrl-favpop__opt${current ? ' is-on' : ''}`,
              'aria-pressed': current ? 'true' : 'false',
              onClick: () => {
                setPlatformId(entry.id);
                writeSongPlatform(entry.id);
                setReveal(null);
                // The row goes away with the panel; the focus goes back to the
                // line the picker was unfolded from.
                if (linkRef.current) linkRef.current.focus();
              },
            },
            h('span', { className: 'bhrl-favpop__name' }, t(`platform_${entry.id}`)),
            current ? h('span', { className: 'bhrl-favpop__meta' }, t('platformCurrent')) : null,
          ),
        );
      };
      // Right-clicking a row is the way out of the list: it takes the station
      // or the song out of the library without closing the panel, so a run of
      // removals stays one gesture. A left click keeps its own meaning (play
      // the station, open the platform search).
      const dropListed = (entry) => {
        if (!store) return;
        if (reveal.kind === 'stations') store.setFavorite(entry, false);
        else store.setSongLiked(entry, false);
        setTimeout(() => {
          const panel = popupRef.current;
          if (!panel) return;
          const next = panel.querySelector('.bhrl-favpop__item');
          if (next && typeof next.focus === 'function') next.focus();
          else if (typeof panel.focus === 'function') panel.focus();
        }, 0);
      };
      const rowMenu = (entry) => ({
        onContextMenu: (event) => {
          event.preventDefault();
          dropListed(entry);
        },
        onKeyDown: (event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'Enter')) {
            event.preventDefault();
            dropListed(entry);
          }
        },
      });
      const popover = reveal
        ? h(
            'div',
            {
              ref: popupRef,
              tabIndex: -1,
              className: 'bhrl-favpop',
              style: {
                bottom: `${reveal.bottom}px`,
                right: reveal.right === undefined ? 'auto' : `${reveal.right}px`,
                left: reveal.left === undefined ? 'auto' : `${reveal.left}px`,
              },
              role: 'dialog',
              'aria-label': popoverTitle,
            },
            h(
              'p',
              { className: 'bhrl-favpop__title' },
              pickingPlatform ? popoverTitle : `${popoverTitle} · ${listEntries.length}`,
            ),
            pickingPlatform
              ? h(
                  'div',
                  { className: 'bhrl-favpop__body' },
                  h('p', { className: 'bhrl-favpop__empty' }, t('platformPickerHint')),
                  h('ul', { className: 'bhrl-favpop__list' }, SONG_PLATFORMS.map(platformRow)),
                )
              : listEntries.length === 0
                ? h(
                    'p',
                    { className: 'bhrl-favpop__empty' },
                    reveal.kind === 'stations' ? t('favouriteListEmpty') : t('likeListEmpty'),
                  )
                : h(
                    'ul',
                    { className: 'bhrl-favpop__list' },
                    listEntries.slice(0, 40).map((entry, index) => {
                      const isStation = reveal.kind === 'stations';
                      const name = isStation ? entry.name : entry.title;
                      const meta = isStation
                        ? [
                            t(`genre_${String(entry.genre || 'other').replace(/[^a-z0-9]/gi, '')}`),
                            knownLabel(entry.language),
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : entry.stationName || '';
                      // A row is a way back into what the list already holds: a
                      // station starts playing, a song asks the platform that is
                      // current right now. Marking stays on the two marks, so a
                      // row never changes the library by being pressed.
                      const rowBody = [
                        h('span', { key: 'name', className: 'bhrl-favpop__name' }, name),
                        meta ? h('span', { key: 'meta', className: 'bhrl-favpop__meta' }, meta) : null,
                      ];
                      if (isStation) {
                        return h(
                          'li',
                          { className: 'bhrl-favpop__row', key: `${index}-${entry.id}` },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'bhrl-favpop__item',
                              onClick: () => {
                                startStation(entry);
                                setReveal(null);
                                if (favRef.current) favRef.current.focus();
                              },
                              ...rowMenu(entry),
                            },
                            rowBody,
                          ),
                        );
                      }
                      // The artist is separate from the title here, unlike the
                      // stream's own "Artist - Title", so both go into the query:
                      // a title alone finds covers and remixes first.
                      const query = [entry.title, entry.artist].filter(Boolean).join(' ');
                      return h(
                        'li',
                        { className: 'bhrl-favpop__row', key: `${index}-${entry.key}` },
                        h(
                          'a',
                          {
                            className: 'bhrl-favpop__item',
                            href: songPlatformOf(platformId).href(query),
                            target: '_blank',
                            rel: 'noopener noreferrer',
                            onClick: () => setReveal(null),
                            ...rowMenu(entry),
                          },
                          rowBody,
                        ),
                      );
                    }),
                  ),
          )
        : null;

      // The card has exactly two ways out: the black-hole mark in the corner,
      // and a song name that asks a platform to search itself. Every other
      // pixel belongs to the station — a stray click on the station name must
      // not navigate away from what is being listened to.
      const openHole = () => {
        if (typeof onOpen === 'function') onOpen();
      };

      return h(
        'div',
        {
          className: `bhrl-fcard${isMine ? ' is-mine' : ''}${hasStation ? '' : ' is-empty'}`,
          'data-status': hasStation ? status : 'empty',
          'data-key': hasStation ? station.id : undefined,
        },
        h(
          'div',
          { className: 'bhrl-fcard__text' },
          h(
            'div',
            { className: 'bhrl-fcard__row' },
            h(OverflowText, { tag: 'h3', className: 'bhrl-fcard__name', text: displayName }),
            favouriteButton,
          ),
          h(
            'div',
            { className: 'bhrl-fcard__row bhrl-fcard__row--sub' },
            // A song name is the one exit the card offers besides the hole: it
            // asks a platform to search the title. Everything else on the line
            // — a programme name, an empty card, an error — is not a song and
            // stays plain text, so a stray press still cannot navigate away.
            songLink
              ? h(
                  'a',
                  Object.assign(
                    {
                      ref: linkRef,
                      className: 'bhrl-fcard__songlink',
                      href: songHref,
                      target: '_blank',
                      rel: 'noopener noreferrer',
                      // The visible title leads, because a name that starts
                      // with something other than what is on screen cannot be
                      // matched by voice or by a person reading it back.
                      'aria-label': `${displayTrack} · ${t('songOpenAction')} · ${t(`platform_${platformId}`)}`,
                      'aria-haspopup': 'dialog',
                      'aria-expanded': reveal && reveal.kind === 'platform' ? 'true' : 'false',
                    },
                    songHandlers,
                  ),
                  h(OverflowText, { tag: 'span', className: 'bhrl-fcard__track', text: displayTrack }),
                )
              : h(OverflowText, { tag: 'p', className: 'bhrl-fcard__track', text: displayTrack }),
            likeButton,
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'bhrl-fcard__logo',
            onClick: openHole,
            'aria-label': t('openHoleHint'),
          },
          h('span', {
            className: 'bhrl-fcard__mark',
            'aria-hidden': 'true',
            style: { '--bhrl-mark': `url("${LOGO_MARK_URLS[scheme] || LOGO_MARK_URLS.light}")` },
          }),
        ),
        h(
          'div',
          { className: 'bhrl-fcard__acts' },
          actButton('bhrl-act-prev', playPrevious, t('fcardPrev'), h(PrevGlyph, { size: 13 }), {
            disabled: !hasStation || !playback,
          }),
          actButton(
            `bhrl-act-play${isMine ? ' is-mine' : ''}`,
            togglePlay,
            playing ? t('pauseAction') : t('playAction'),
            playing ? h(PauseGlyph, { size: 15 }) : h(PlayGlyph, { size: 15 }),
            { 'aria-pressed': playing ? 'true' : 'false', disabled: !playback || !(hasStation ? !!stream : canPick) },
          ),
          actButton('bhrl-act-next', playRandom, t('fcardNext'), h(NextGlyph, { size: 13 }), {
            // Without a station the next button has nothing to skip from, and
            // pressing play is the one way to start listening. So shuffle is
            // not offered until something is playing; play owns the first move.
            disabled: !hasStation || !playback || !canPick,
          }),
          h(
            'span',
            { className: 'bhrl-fcard__vol' },
            h('i', { className: 'bhrl-fcard__volicon', 'aria-hidden': 'true' }, h(VolumeGlyph, { size: 12 })),
            h('input', {
              type: 'range',
              className: 'bhrl-fcard__range',
              min: '0',
              max: '100',
              step: '1',
              value: String(Math.round(volume * 100)),
              // The filled side of the rail: the value itself, handed to the
              // gradient so the bar never disagrees with the thumb.
              style: { '--bhrl-vol': `${Math.round(volume * 100)}%` },
              onChange: changeVolume,
              'aria-label': t('fcardVolume'),
              disabled: !playback,
            }),
          ),
        ),
        popover,
      );
    }

    /*
     * FROZEN (2026-10-30): the left-column station card — this registration,
     * the rail form and the card it draws — changes only with the user's
     * explicit second confirmation. See AGENTS.md.
     */

    /**
     * The station, in the sidebar foot.
     *
     * This is the one place the station exists as a card. It is registered into
     * the host's `sidebar.footer.action` cell, so it lives exactly as long as
     * the left column does — longer than the panel, its stage, or any view
     * inside it. Every scene (the hole, the genre field, an opened volume)
     * only ever writes `selectedStationId` into the store; this card reads that
     * plus the playback snapshot and nothing else, and every button it draws
     * calls the shared owners rather than keeping a local copy.
     *
     * The host gives this cell `{ wide }`: true while the column is expanded,
     * false in the 56px rail. The rail form is a single line, the column form
     * is the full card.
     */
    function SidebarStation(props) {
      const { localeSvc, requireAsync, shared, wide, onOpen } = props;
      const t = makeT(localeSvc);
      const lang = activeLanguage(localeSvc);
      const store = shared ? shared.radio : null;
      const station = useShared(
        shared,
        'radio',
        () => (store ? store.getSelected() : null),
        [store],
      );
      const [ready, setReady] = useState(!!(store && shared.playback));
      useEffect(() => {
        if (ready || !shared || !requireAsync) return undefined;
        let alive = true;
        Promise.resolve()
          .then(() => requireAsync(RADIO_CHUNK))
          .then((chunk) => {
            if (!alive) return;
            if (!shared.env) shared.bindEnv(chunk);
            // The rail is the radio, not a preview of the panel: it builds the
            // same store and the same playback core the panel would, so the
            // card can show a station even when the panel has never mounted.
            shared.ensureStore(chunk.createRadioStore);
            shared.ensurePlayback(chunk.createPlaybackCore, { attachStream: makeAttachStream(shared, requireAsync) });
            // The footer is a first-class surface, not a preview: if it is the
            // first thing to mount, it must still have stations to show and a
            // play button that works. `ensureData` is the same single flight
            // the panel awaits and is idempotent, so whichever mounts first
            // pays the load and the other reuses it.
            try {
              Promise.resolve()
                .then(() => shared.ensureData(requireAsync))
                .catch(() => {
                  /* the panel reports data errors; the card stays quiet */
                });
            } catch {
              /* a data failure must not keep the card from rendering */
            }
            setReady(true);
          })
          .catch(() => {
            /* the panel reports data errors; the rail stays quiet */
          });
        return () => {
          alive = false;
        };
      }, [ready, requireAsync, shared]);

      const playingId = useShared(
        shared,
        'playback',
        (snapshot) => (snapshot && snapshot.status === 'playing' ? String(snapshot.stationId) : null),
        [],
      );

      let body;
      if (!wide) {
        // One exception, and it is geometry, not design: the collapsed rail is
        // 56px wide and a 236px card cannot exist there. The rail keeps a single
        // glyph; the moment the column is expanded the card is there again.
        const isPlaying = !!station && playingId !== null && String(station.id) === playingId;
        const label = station ? station.name : t('fcardEmptyName');
        body = h(
          'button',
          {
            type: 'button',
            className: `bhrl-foot-rail${isPlaying ? ' is-playing' : ''}`,
            'aria-label': label,
            onClick: () => {
              if (typeof onOpen === 'function') onOpen();
              else if (station && store) store.select(station);
            },
          },
          h('span', { className: 'bhrl-foot-rail__dot', 'aria-hidden': 'true' }),
        );
      } else {
        // Selected or not, the column form is the card: never a different body.
        body = h(StationFootCard, { station, shared, t, onOpen, lang });
      }

      return h('div', { className: `bhrl-foot${wide ? ' is-wide' : ' is-rail'}`, 'data-ready': ready ? 'true' : 'false' }, body);
    }

    function ArrowLeft({ size }) {
      return h(
        'svg',
        { width: size || 13, height: size || 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M13 8H3M7 4L3 8l4 4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    function Panel({ localeSvc, requireAsync, shared, layoutSvc }) {
      const t = useT(localeSvc);
      const lang = activeLanguage(localeSvc).startsWith('zh') ? 'zh' : 'en';
      const langRef = useRef(lang);
      langRef.current = lang;

      const [canvasNode, setCanvasNode] = useState(null);
      const [cfg, setCfg] = useState(null);
      const [attempt, setAttempt] = useState(0);
      const stageRef = useRef(null);
      const retryStage = useCallback(() => setAttempt((n) => n + 1), []);

      /**
       * The search box, and the only chrome this page has.
       *
       * The hole is its handle: a tap opens it, Escape or a result closes it.
       * It is view state, so it dies with the panel; the query itself is not
       * remembered anywhere, because a stale search is not a selection.
       */
      const [searchOpen, setSearchOpen] = useState(false);
      const [searchText, setSearchText] = useState('');
      const [modeState, setModeState] = useState({
        state: 'black-hole',
        mode: 'black-hole',
        categoryId: null,
        progress: 0,
        transitioning: false,
      });

      const modeRef = useRef(modeState);
      modeRef.current = modeState;

      /** Stable stage callbacks route through these closures. */
      const actionsRef = useRef({});

      const stageCallbacks = useMemo(
        () => ({
          onSelect(station) {
            // The stage names stations by record; the store owns the choice.
            // Routed through the ref for the same reason as onPlay: the store is
            // injected after the first render, and a memo that captured the null
            // it saw then would never hear another click.
            if (actionsRef.current.selectStation) actionsRef.current.selectStation(station || null);
          },
          onMode(snapshot) {
            setModeState(snapshot);
            // A hold owns the scene for the whole flight: an open library would
            // hang over the disc while it is being gathered, so it goes first.
            if (snapshot.transitioning && favMenuRef.current) setFavMenu(null);
          },
          /**
           * A click on the hole is not a hold: it opens the search box. The two
           * gestures never overlap, because a completed hold consumed the press
           * at pointer down and never reaches this path.
           */
          onHoleTap() {
            setSearchOpen(true);
          },
          /**
           * A click on a heat spot asks for transport. Routed through the ref so
           * this memo can stay empty: the panel that owns playing changes on
           * every catalogue update, and a memo that captured it would fire a
           * stage remount on every one of them.
           */
          onPlay(station) {
            if (actionsRef.current.playFromDisk) actionsRef.current.playFromDisk(station);
          },
          /**
           * The scene reports the heat spot under the pointer; the card that
           * names it belongs to this panel, so it is routed through the ref for
           * the same reason as the other actions: this memo is built once, and a
           * captured `hoverCardIn` would still be the first render's.
           */
          onHover(payload) {
            if (actionsRef.current.hoverCardIn) actionsRef.current.hoverCardIn(payload || null);
          },
          /**
           * A short right press in the scene asks for the library. The stage has
           * already done the gesture work (a long press is the way back, and the
           * two never overlap), so all that is left is where it landed.
           */
          onFavourites(x, y) {
            if (actionsRef.current.openFavourites) actionsRef.current.openFavourites(x, y);
          },
        }),
        [],
      );

      // Host config, fetched once. A failure is information, not a blocker.
      useEffect(() => {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let alive = true;
        (async () => {
          try {            const res = await fetch(CONFIG_URL, { cache: 'no-store', signal: controller ? controller.signal : undefined });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            // Verification knob: `?bhrlStations=5000` overrides the count.
            const asked = Number(new URLSearchParams(window.location.search).get('bhrlStations'));
            if (Number.isInteger(asked) && asked >= 200 && asked <= 20000) body.stationCount = asked;
            // Phase-2 fixture switch: `?bhrlRadio=all`, a kind, a business id or
            // a gpu id. Absent means the page renders the phase-1 baseline.
            const radioParam = new URLSearchParams(window.location.search).get('bhrlRadio');
            if (radioParam !== null) body.radio = radioParam;
            // `?bhrlWormhole=0` turns the transition off for an A/B against the
            // old instant handover. Absent means the shipped behaviour.
            const wormParam = new URLSearchParams(window.location.search).get('bhrlWormhole');
            if (wormParam !== null) body.wormhole = wormParam !== '0';
            if (alive) setCfg(body);
          } catch {
            // Unreachable config: fall back to the documented defaults so the
            // panel still mounts. The dataset is not fetched here — the shared
            // single flight owns that, and it must not depend on this request.
            if (alive) setCfg(DEFAULT_CFG);
          }
        })();
        return () => {
          alive = false;
          if (controller) controller.abort();
        };
      }, []);

      const radio = useRadio(requireAsync, cfg, shared);
      const repository = radio.repository;
      const categories = radio.categories || [];
      const anchors = radio.anchors || [];

      /**
       * The store, or null until the data chunk has resolved once.
       *
       * Both the store and the playback core arrive with the data chunk — the
       * chunk carries `createRadioStore`, `createPlaybackCore` and the genre
       * tables the list headers need. One effect builds both, once, into
       * `shared`; no view ever constructs either.
       */
      const store = shared ? shared.radio : null;
      const [, setPlaybackReady] = useState(0);
      useEffect(() => {
        let alive = true;
        Promise.resolve()
          .then(() => requireAsync(RADIO_CHUNK))
          .then((chunk) => {
            if (!alive || !shared) return;
            if (!shared.env) shared.bindEnv(chunk);
            shared.ensurePlayback(chunk.createPlaybackCore, { attachStream: makeAttachStream(shared, requireAsync) });
            if (shared.radio && shared.playback) setPlaybackReady((n) => n + 1);
          })
          .catch(() => {
            /* the panel already reports a data error; playback stays absent */
          });
        return () => {
          alive = false;
        };
      }, [requireAsync, shared]);

      /**
       * The core object itself. Read straight off `shared` — the mount above
       * has already run by the time this line is reached on a later render, and
       * an unsubscribed read keeps the "no panel, no subscription" property.
       */
      const playback = shared ? shared.playback : null;
      /** Playback *state*, subscribed, so every transport button is in step. */
      const playState = useShared(shared, 'playback', (snapshot) => snapshot || IDLE_PLAYBACK, [shared, shared && shared.playback]);

      // ---- the disk hover card ---------------------------------------------
      //
      // The stage reports which heat spot the pointer is over; this panel owns
      // the card: when it appears, what it says, and the one action it offers.
      // It is a DOM element so that a right click on it is a real contextmenu on
      // a real node — a canvas label layer could never carry that.
      const [hoverCard, setHoverCard] = useState(null);
      const hoverCardRef = useRef(null);
      const hoverCardTimer = useRef(0);
      const hoverCardPending = useRef(null);
      const stageElRef = useRef(null);
      // True while the pointer is on the card itself. The stage can only report
      // heat spots, so every move over the card reads as "no station" there;
      // without this the card would time itself out while being read.
      const hoverCardInside = useRef(false);

      const applyHoverCard = (next) => {
        hoverCardRef.current = next;
        setHoverCard(next);
      };

      const hoverCardIn = useCallback((payload) => {
        if (hoverCardTimer.current) {
          clearTimeout(hoverCardTimer.current);
          hoverCardTimer.current = 0;
        }
        if (!payload) {
          // The pointer is on the card, not on the sky: the card keeps itself.
          if (hoverCardInside.current) return;
          // Leaving is slower than arriving, so a pointer crossing a gap between
          // two heat spots does not make the card blink.
          hoverCardTimer.current = setTimeout(() => {
            hoverCardTimer.current = 0;
            applyHoverCard(null);
          }, 200);
          return;
        }
        // A station means the pointer is over the sky again, whatever the card
        // last saw. Self-healing, so a lost leave cannot wedge the dismissal off.
        hoverCardInside.current = false;
        // The stage reports viewport coordinates because that is what it reads
        // off the pointer event; the card is positioned inside the stage, so it
        // has to be brought into the stage's own frame here, once.
        const stageEl = stageElRef.current;
        const rect = stageEl ? stageEl.getBoundingClientRect() : null;
        const localX = rect ? payload.x - rect.left : payload.x;
        const localY = rect ? payload.y - rect.top : payload.y;
        // The card hangs to the right of the spot until that would push it off
        // the stage, then flips. Vertically it is centred unless the spot is
        // within half a card of the stage's top or bottom edge. Measured here,
        // not in render, so the layout is read once per hover instead of once
        // per paint.
        const cardHalf = 48;
        const tall = Boolean(rect) && rect.height > cardHalf * 4;
        const placed = {
          ...payload,
          x: localX,
          y: localY,
          flip: Boolean(rect) && rect.width > 0 && localX > rect.width - 280,
          vAlign: !tall ? 'center' : localY > rect.height - cardHalf ? 'up' : localY < cardHalf ? 'down' : 'center',
        };
        hoverCardPending.current = placed;
        // Already showing one: move it to the new station rather than dropping it
        // and waiting out the arrival delay a second time.
        if (hoverCardRef.current) {
          applyHoverCard(placed);
          return;
        }
        hoverCardTimer.current = setTimeout(() => {
          hoverCardTimer.current = 0;
          const current = hoverCardPending.current;
          if (current) applyHoverCard(current);
        }, 120);
      }, []);

      const hoverCardKeep = useCallback(() => {
        // The pointer crossed from the heat spot into the card itself. That is
        // still the same hover, so the dismissal must not fire — and it must not
        // re-arm while the pointer stays on the card.
        hoverCardInside.current = true;
        if (hoverCardTimer.current) {
          clearTimeout(hoverCardTimer.current);
          hoverCardTimer.current = 0;
        }
      }, []);

      const hoverCardRelease = useCallback(() => {
        hoverCardInside.current = false;
      }, []);

      /**
       * Transport for a click on the disk.
       *
       * `playback.toggle` is the one owner of the pause/resume rule: it holds
       * the current station id and state, so the disk, the card and the side
       * panel cannot disagree about what a second click on the same spot means.
       */
      const playFromDisk = useCallback(
        (station) => {
          const pb = shared ? shared.playback : null;
          if (!pb || !station) return;
          const stream = streamOf(station);
          if (!stream) return;
          pb.toggle(station.id, stream);
        },
        [shared],
      );

      /** The card's one action, on the same rule as the context menu. */
      const favouriteFromCard = useCallback(() => {
        const current = hoverCardRef.current;
        if (!store || !current) return;
        store.toggleFavorite(current.station);
      }, [store]);

      // The card reads its favourite state from the store, like every other
      // surface: a right click on the card and the side panel must agree.
      const hoverCardFavourite = useShared(
        shared,
        'radio',
        () => (store && hoverCard && hoverCard.station ? store.isFavorite(hoverCard.station) : false),
        [store, hoverCard && hoverCard.station],
      );

      /**
       * Tell the scene when the pointer is standing on the card.
       *
       * The card floats over the canvas, so naming a station and then reaching
       * for its star means leaving the canvas — and leaving is one of the things
       * that lets the disk start turning again. The star would then be a moving
       * target; this hands the freeze back while the card is under the pointer.
       */
      const setCardHover = (on) => {
        const handle = stageRef.current;
        if (!handle || typeof handle.setCardHover !== 'function') return;
        handle.setCardHover(on);
      };

      // A card that disappears while the pointer still rests on it — dismissed,
      // replaced by another station, torn down — has no pointerleave to give:
      // the scene has to be told the freeze is over, or the record stays pinned
      // for nobody.
      useEffect(() => {
        if (!hoverCard) setCardHover(false);
      }, [hoverCard]);

      // ---- the library on the scene -----------------------------------------
      //
      // A short right press anywhere in the scene opens the favourites where the
      // press happened. It is the same list the card's corner post unfolds;
      // there the mark on the row stood for "take it out", here the press on the
      // row itself does, so the list reads the same in both places.
      const [favMenu, setFavMenu] = useState(null);
      const favMenuRef = useRef(null);
      const favMenuPanelRef = useRef(null);
      favMenuRef.current = favMenu;

      const favouriteList = useShared(
        shared,
        'radio',
        () => (store ? store.favoriteStations() : []),
        [store],
      );

      const playFavourite = useCallback(
        (station) => {
          const pb = shared ? shared.playback : null;
          if (!pb || !station) return;
          const stream = streamOf(station);
          if (!stream) return;
          // The list is transport, not navigation: this starts what was pressed
          // and leaves the list open, so a row of favourites can be tried out.
          if (store) store.select(station);
          pb.play(station.id, stream);
        },
        [shared, store],
      );

      const dropFavourite = useCallback(
        (station) => {
          if (!store || !station) return;
          store.toggleFavorite(station);
          // The press takes the row out and leaves the list up, so a run of
          // removals stays one gesture. Keyboard focus follows the list: the
          // next row, or the empty panel when the last one just went.
          setTimeout(() => {
            const panel = favMenuPanelRef.current;
            if (!panel) return;
            const next = panel.querySelector('.bhrl-favpop__item');
            if (next && typeof next.focus === 'function') next.focus();
            else if (typeof panel.focus === 'function') panel.focus();
          }, 0);
        },
        [store],
      );

      /**
       * Open the list where the press landed, or close it when it is already up:
       * the second right press is the way out - the same gesture that opened it.
       * The corner it hangs from is flipped here, not by a layout pass, so a
       * press near an edge does not put the list off the screen.
       */
      const openFavourites = useCallback(
        (x, y) => {
          if (!store) return;
          // A second right press is the way out: the same gesture that opened
          // it, so the list needs no other key of its own.
          if (favMenuRef.current) {
            setFavMenu(null);
            return;
          }
          const width = 260;
          const height = 240;
          const gap = 6;
          const flipX = x + width + gap > window.innerWidth;
          const flipY = y + height + gap > window.innerHeight;
          // The card behind the list still names the last station crossed; it
          // belongs to a hover the press has already ended.
          hoverCardIn(null);
          setFavMenu({
            x: flipX ? Math.max(6, x - width - gap) : x + gap,
            y: flipY ? Math.max(6, y - height - gap) : y + gap,
          });
        },
        [store, hoverCardIn],
      );

      // Escape belongs to the page's own key handler - the list has to close
      // before the radio does - so only the press outside lives here. A right
      // press in the scene is excluded: that one is the list's own toggle, and
      // closing it here would let the stage's report reopen it a frame later.
      useEffect(() => {
        if (!favMenu) return undefined;
        const onPointerDown = (event) => {
          const node = event.target;
          if (node instanceof Element) {
            if (node.closest('.bhrl-favpop')) return;
            if (event.button === 2 && node.closest('.bhrl-stage')) return;
          }
          setFavMenu(null);
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        return () => window.removeEventListener('pointerdown', onPointerDown, true);
      }, [favMenu]);

      /**
       * Keep the list next to the press, whatever the host's layout did.
       *
       * The point is in client pixels and the box asks to be painted fixed, but
       * a fixed box only measures from the viewport while nothing above it
       * makes a containing block - a filter, a transform, a `contain`, all of
       * which glass surfaces carry. Under one of those the same numbers name a
       * spot in that surface's own box, and the list opens somewhere else.
       *
       * Guessing that surface's scale is what failed before: a plain offset and
       * a zoomed one look the same to a single measurement, and a wrong guess
       * is exact near the surface's origin and further off the further the
       * press lands. So nothing is assumed. The box is moved, the move is
       * measured, and the next move is divided by what the last one actually
       * bought - a ratio that is 1 for a plain viewport, the surface's zoom for
       * a zoomed one, and whatever the host does for anything stranger. Three
       * passes settle every affine case; the loop stops early once the box is
       * on the point.
       */
      useLayoutEffect(() => {
        const panel = favMenuPanelRef.current;
        if (!panel || !favMenu) return;
        let worthX = 1;
        let worthY = 1;
        for (let pass = 0; pass < 3; pass += 1) {
          const rect = panel.getBoundingClientRect();
          const dx = favMenu.x - rect.left;
          const dy = favMenu.y - rect.top;
          if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return;
          const stepX = dx / worthX;
          const stepY = dy / worthY;
          const atX = Number.parseFloat(panel.style.left) || 0;
          const atY = Number.parseFloat(panel.style.top) || 0;
          panel.style.left = `${atX + stepX}px`;
          panel.style.top = `${atY + stepY}px`;
          const after = panel.getBoundingClientRect();
          const movedX = after.left - rect.left;
          const movedY = after.top - rect.top;
          // What one local pixel is worth out there. Only learned from a move
          // big enough to read, and only when the box actually obeyed.
          if (Math.abs(stepX) > 2 && movedX !== 0) worthX = movedX / stepX;
          if (Math.abs(stepY) > 2 && movedY !== 0) worthY = movedY / stepY;
        }
      }, [favMenu]);

      // ---- the disk's ring -----------------------------------------
      //
      // The ring under the hole belongs to playback, so the panel must say when
      // the transport changed for a reason the stage cannot see.
      const playId = playState && playState.stationId ? String(playState.stationId) : null;
      const playStatus = playState ? playState.status : 'idle';

      /**
       * The selected record, read from the store instead of held locally.
       *
       * Phase 7: this used to be a `useState` in the panel, so closing the panel
       * forgot the selection while the radio kept playing it. The stage still
       * receives full records; only the owner changed.
       */
      const selected = useShared(
        shared,
        'radio',
        () => (store ? store.getSelected() : null),
        [store],
      );
      const selectedKey = selected && store ? store.keyOf(selected) : null;

      const stageSettings = useMemo(() => {
        if (!cfg || !repository) return null;
        return {
          antialias: cfg.antialias !== false,
          pixelRatioCap: typeof cfg.pixelRatioCap === 'number' ? cfg.pixelRatioCap : 2,
          reducedMotion: Boolean(cfg.reducedMotion),
          // The wormhole between the two spaces. Off restores the old instant
          // handover, which is what a user who dislikes the transition wants.
          wormhole: cfg.wormhole !== false,
          stations: repository.list(),
          seed: repository.seed,
          categories: anchors,
          // Already-counted visible genres from the repository. The stage never
          // classifies anything; it only places what it is handed.
          genres: typeof repository.visibleGenres === 'function' ? repository.visibleGenres() : [],
          language: langRef.current,
          // Phase-2 fixture switch, carried through from the URL. `null` in the
          // default case, so the stage never even creates the overlay.
          radio: cfg.radio === undefined ? null : cfg.radio,
          onSelect: stageCallbacks.onSelect,
          onMode: stageCallbacks.onMode,
          onHoleTap: stageCallbacks.onHoleTap,
          onPlay: stageCallbacks.onPlay,
          onHover: stageCallbacks.onHover,
          onFavourites: stageCallbacks.onFavourites,
        };
      }, [cfg, repository, anchors, stageCallbacks]);

      const stage = useStage(requireAsync, canvasNode, stageSettings, stageRef, attempt);

      // The disk's ring belongs to playback, so the panel tells the stage which
      // station is live whenever the transport changes for a reason the stage
      // cannot see: a side-panel click, a track ending, a host command.
      useEffect(() => {
        const handle = stageRef.current;
        if (!handle || typeof handle.setPlaying !== 'function') return;
        handle.setPlaying(playId, playStatus !== 'playing');
      }, [playId, playStatus, stage && stage.status]);

      // Favourites recolour the heat spots; they never relayout the disk. Keyed
      // on the favourites themselves, not the store version: every selection
      // also bumps that version, and re-walking 24k stations for an unrelated
      // change costs a full attribute upload.
      const favouriteSignature = useShared(
        shared,
        'radio',
        () => (store ? store.favoriteKeys().join('|') : ''),
        [store],
      );
      useEffect(() => {
        const handle = stageRef.current;
        if (!handle || typeof handle.setFavourites !== 'function' || !store) return;
        handle.setFavourites((station) => store.isFavorite(station));
      }, [favouriteSignature, store, stage && stage.status]);

      // ---- mode transitions ----------------------------------------------

      /** Selection lives in the store; these three keep the old call shape. */
      const selectNone = useCallback(() => {
        if (store) store.select(null);
      }, [store]);

      const backToHole = useCallback(() => {
        selectNone();
        const handle = stageRef.current;
        if (!handle) return;
        if (typeof handle.clearSelection === 'function') handle.clearSelection(false);
        if (typeof handle.exitCluster === 'function') handle.exitCluster();
      }, [selectNone]);

      // ---- station selection ---------------------------------------------

      const chooseStation = useCallback((station) => {
        if (!station) return;
        if (store) store.select(station);
        const handle = stageRef.current;
        if (!handle) return;
        // locateStation is the cross-mode path: it enters the scene that owns
        // the station first, then focuses it. selectById would only work when
        // the station already sits in the active scene.
        if (typeof handle.locateStation === 'function') handle.locateStation(station.id);
        else if (typeof handle.selectById === 'function') handle.selectById(station.id, { focus: true, notify: false });
      }, [store]);

      /**
       * The search box's own results.
       *
       * The repository already ranks by name and features, so the panel only
       * asks and draws. The ranked list is now rendered lazily — one page at a
       * time, appended as the list scrolls to the bottom — so a country or
       * language query (hundreds of stations) is browsable instead of capped
       * at eight rows.
       */
      const SEARCH_PAGE = 12;
      const SEARCH_MAX = Number.POSITIVE_INFINITY;
      const searchResults = useMemo(() => {
        const query = searchText.trim();
        if (!query || !repository || typeof repository.search !== 'function') return [];
        try {
          const list = repository.search(query, SEARCH_MAX);
          return Array.isArray(list) ? list : [];
        } catch {
          return [];
        }
      }, [searchText, repository]);
      // How many of `searchResults` are currently mounted. Reset on a new query
      // so a fresh search always starts at one page.
      const [searchShown, setSearchShown] = useState(SEARCH_PAGE);
      useEffect(() => {
        setSearchShown(SEARCH_PAGE);
      }, [searchText]);
      const searchVisible = searchResults.slice(0, searchShown);
      const onSearchScroll = (event) => {
        const el = event.currentTarget;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) {
          setSearchShown((n) => Math.min(searchResults.length, n + SEARCH_PAGE));
        }
      };

      // Automatic recovery stays in the currently visible library/category/query.
      // This is not a catalogue filter: searches and manual plays still see every station.
      useEffect(() => {
        if (!shared) return;
        const candidates = () => {
          let pool = playablePool(store);
          const searchLimit = pool.length;
          if (favMenu && store) pool = pool.filter((station) => store.isFavorite(station));
          const category = modeState.categoryId;
          if (category) pool = pool.filter((station) => station.genre === category || (station.categories || []).includes(category));
          const query = searchOpen ? searchText.trim() : '';
          if (query) {
            if (!repository || typeof repository.search !== 'function') return [];
            // Recovery is best-effort: cap the id set so a one-letter query does
            // not build a ~60k-entry Set on every keystroke. The visible search
            // list is paged separately and is unaffected.
            const ids = new Set(repository.search(query, Math.min(searchLimit, 5000)).map((station) => String(station.id)));
            pool = pool.filter((station) => ids.has(String(station.id)));
          }
          return pool;
        };
        shared.autoCandidates = candidates;
        return () => { if (shared.autoCandidates === candidates) shared.autoCandidates = null; };
      }, [shared, store, repository, favMenu, modeState.categoryId, searchOpen, searchText]);

      /** The one-line place a result belongs to, in the current language. */
      const stationPlace = useCallback(
        (station) => {
          const country = station && station.country;
          if (!country) return '';
          return lang === 'en' ? country.en || country.zh || '' : country.zh || country.en || '';
        },
        [lang],
      );

      // Escape and a press anywhere outside both close the box. The press still
      // belongs to the scene: closing is the only thing this adds to it.
      useEffect(() => {
        const handle = stageRef.current;
        if (handle && typeof handle.setSearchOpen === 'function') handle.setSearchOpen(searchOpen);
        if (!searchOpen) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setSearchOpen(false);
        };
        const onPointerDown = (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest('.bhrl-search')) return;
          setSearchOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown);
          window.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [searchOpen]);

      const clearSelection = useCallback(() => {
        selectNone();
        const handle = stageRef.current;
        if (handle && typeof handle.clearSelection === 'function') handle.clearSelection(false);
      }, [selectNone]);

      /**
       * Bring the station that is actually playing into view.
       *
       * The mini player's name is a jump target: it selects the playing station
       * (so the info overlay describes it) and asks the stage to locate it. The
       * stage is free to ignore a stale id — that is why the result is unchecked
       * rather than asserted.
       */
      const locatePlaying = useCallback(
        (stationId) => {
          if (!store || !stationId) return;
          const station = store.getStation(stationId);
          if (!station) return;
          store.select(station);
          const handle = stageRef.current;
          if (!handle) return;
          if (typeof handle.locateStation === 'function') {
            try {
              handle.locateStation(station.id);
            } catch {
              /* the id may not be in the mounted scene; the selection stands */
            }
          }
        },
        [store],
      );

      useEffect(() => {
        const handle = stageRef.current;
        if (handle && typeof handle.setLanguage === 'function') handle.setLanguage(lang);
      }, [lang, stage.status]);

      const inCluster = modeState.mode === 'cluster' || modeState.state === 'transition-to-cluster';

      /**
       * Escape leaves the radio page.
       *
       * It is not a level step: the way back through the three spaces is the
       * right-button hold, reversed. Escape means one thing at every depth —
       * leave the plugin, back to whatever page the hole was opened from — and
       * it is the only key that does that.
       */
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          const target = event.target;
          // A text field keeps its own Escape (clear the query, close its list).
          if (
            target &&
            (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          // The library drawn over the scene is the innermost layer: it closes
          // first, and only the next Escape leaves the radio page.
          if (favMenuRef.current) {
            setFavMenu(null);
            return;
          }
          const handle = stageRef.current;
          if (handle && typeof handle.dismissHover === 'function') handle.dismissHover();
          try {
            if (layoutSvc && typeof layoutSvc.selectPanel === 'function') layoutSvc.selectPanel(null);
          } catch {
            /* no keyed main entry in this composition — nothing to leave */
          }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, [layoutSvc]);

      actionsRef.current = {
        backToHole,
        playFromDisk,
        hoverCardIn,
        openFavourites,
        /**
         * The disk click selects before it plays, and the store that records the
         * choice arrives a render later than the memo that asks for it. Reading
         * it here keeps the click honest without remounting the stage.
         */
        selectStation: (station) => {
          if (store) store.select(station || null);
        },
      };

      // ---- genre labels ---------------------------------------------------

      /**
       * The genre definitions the scene received. `radio.genres` is the
       * repository's own summary, so the chrome names and colours exactly what
       * the cluster draws — no second table, no second classifier.
       */
      const genreTable = useMemo(() => {
        // Read the sample's own display groups straight from the repository.
        // `useRadio` only carries the status records, so there is no `genres`
        // field on it to read — asking it for one left the rail permanently
        // empty ("0 个流派") while thirteen volumes existed in the scene.
        if (!repository || typeof repository.visibleGenres !== 'function') return [];
        const visible = repository.visibleGenres();
        return (Array.isArray(visible) ? visible : []).filter((genre) => genre && genre.count > 0);
      }, [repository]);

      const genreTableRef = useRef(genreTable);
      genreTableRef.current = genreTable;

      const genreLabelOf = useCallback(
        (id) => {
          if (shared && shared.env) return shared.env.genreLabel(id, lang);
          const genre = genreTableRef.current.find((item) => item.id === String(id));
          return genre ? (lang === 'en' ? genre.en : genre.zh) : String(id);
        },
        [shared, lang],
      );

      const genreCssOf = useCallback(
        (id) => {
          if (shared && shared.env) return shared.env.genreCss(id);
          const genre = genreTableRef.current.find((item) => item.id === String(id));
          return genre ? `#${Number(genre.color).toString(16).padStart(6, '0')}` : '#9a9a9a';
        },
        [shared],
      );

      /**
       * The card itself.
       *
       * It names the station under the pointer and offers exactly one action. It
       * is deliberately not a second copy of the side panel: no artwork, no
       * transport row, no navigation — anything more would compete with the disk
       * it floats over.
       */
      const hoverCardStation = hoverCard ? hoverCard.station : null;
      const hoverCardLive = Boolean(hoverCardStation && playId && String(hoverCardStation.id) === playId);
      const hoverCardCountry =
        hoverCardStation && hoverCardStation.country
          ? lang === 'en'
            ? hoverCardStation.country.en || hoverCardStation.country.zh
            : hoverCardStation.country.zh || hoverCardStation.country.en
          : '';
      const hoverCardLanguage =
        hoverCardStation && hoverCardStation.language
          ? lang === 'en'
            ? hoverCardStation.language.en || hoverCardStation.language.zh
            : hoverCardStation.language.zh || hoverCardStation.language.en
          : '';

      /**
       * The hover card.
       *
       * It is DOM and not a canvas label: the name has to be a real target for
       * the pointer (so the card can be held still while the star is pressed),
       * and it carries nothing else — no transport row, no hint line, no
       * navigation — so it never competes with the disk it floats over.
       */
      const hoverCardNode = hoverCardStation
        ? h(
            'div',
            {
              className: 'bhrl-hovercard',
              'data-touch': hoverCard.touch ? 'true' : 'false',
              style: {
                left: `${hoverCard.x}px`,
                top: `${hoverCard.y}px`,
                // Horizontally the card hangs off the side that has room; vertically
                // it is centred on the spot unless that would run it off the stage's
                // own edge, where it sits above or below instead. The stage clips
                // itself, so a centred card near the frame would lose its name.
                transform: `translate(${hoverCard.flip ? 'calc(-100% - 14px)' : '14px'}, ${
                  hoverCard.vAlign === 'up'
                    ? 'calc(-100% - 12px)'
                    : hoverCard.vAlign === 'down'
                      ? '12px'
                      : '-50%'
                })`,
              },
              // The card is part of the hover, not a new target: entering it
              // keeps the hover alive, leaving it is what ends it. The scene is
              // told as well, because the disk must stop turning underneath it.
              onPointerEnter: () => {
                hoverCardKeep();
                setCardHover(true);
              },
              onPointerLeave: () => {
                hoverCardRelease();
                setCardHover(false);
                hoverCardIn(null);
              },
              onPointerDown: (event) => event.stopPropagation(),
              onContextMenu: (event) => {
                event.preventDefault();
                event.stopPropagation();
              },
            },
            // The star sits with the name it acts on: one line, title on the left
            // and the mark at the right end, so the card opens as a name plus its
            // action instead of stacking a button under the text.
            h(
              'div',
              { className: 'bhrl-hovercard__head' },
              h('span', { className: 'bhrl-hovercard__name' }, hoverCardStation.name),
              h(
                'button',
                {
                  type: 'button',
                  className: 'bhrl-hovercard__fav',
                  'data-icon': 'true',
                  'data-active': hoverCardFavourite ? 'true' : 'false',
                  'aria-pressed': hoverCardFavourite ? 'true' : 'false',
                  'aria-label': hoverCardFavourite ? t('unfavouriteAction') : t('favouriteAction'),
                  title: hoverCardFavourite ? t('unfavouriteAction') : t('favouriteAction'),
                  onClick: (event) => {
                    event.stopPropagation();
                    favouriteFromCard();
                  },
                },
                h(StarGlyph, { size: 12, filled: hoverCardFavourite }),
              ),
            ),
            hoverCardCountry || hoverCardLanguage
              ? h(
                  'span',
                  { className: 'bhrl-hovercard__meta' },
                  [hoverCardCountry, hoverCardLanguage].filter(Boolean).join(' · '),
                )
              : null,
            h(
              'div',
              { className: 'bhrl-hovercard__row' },
              h(
                'span',
                { className: 'bhrl-hovercard__genre' },
                h('span', {
                  className: 'bhrl-hovercard__dot',
                  style: { background: genreCssOf(hoverCardStation.genre || 'other') },
                  'aria-hidden': 'true',
                }),
                h('span', null, genreLabelOf(hoverCardStation.genre || 'other')),
              ),
              hoverCardLive ? h('span', { className: 'bhrl-hovercard__live' }, t('hoverLiveBadge')) : null,
            ),
          )
        : null;

      /**
       * The favourites, opened where the right press landed.
       *
       * A row starts what it names and the list stays open; a right press on the
       * row takes it out of the library, the way the card's own list does.
       */
      const favMenuNode = favMenu
        ? h(
            'div',
            {
              ref: favMenuPanelRef,
              tabIndex: -1,
              className: 'bhrl-favpop',
              style: { left: `${favMenu.x}px`, top: `${favMenu.y}px` },
              role: 'dialog',
              'aria-label': t('favouriteListTitle'),
              onContextMenu: (event) => event.preventDefault(),
              onPointerDown: (event) => event.stopPropagation(),
            },
            h(
              'p',
              { className: 'bhrl-favpop__title' },
              `${t('favouriteListTitle')} · ${favouriteList.length}`,
            ),
            favouriteList.length === 0
              ? h('p', { className: 'bhrl-favpop__empty' }, t('favouriteListEmpty'))
              : h(
                  'ul',
                  { className: 'bhrl-favpop__list' },
                  favouriteList.slice(0, 40).map((entry) => {
                    const rowLanguage = entry.language
                      ? lang === 'en'
                        ? entry.language.en || entry.language.zh
                        : entry.language.zh || entry.language.en
                      : '';
                    const meta = [genreLabelOf(entry.genre || 'other'), rowLanguage]
                      .filter(Boolean)
                      .join(' · ');
                    return h(
                      'li',
                      { className: 'bhrl-favpop__row', key: String(entry.id) },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'bhrl-favpop__item',
                          onClick: () => playFavourite(entry),
                          onContextMenu: (event) => {
                            event.preventDefault();
                            dropFavourite(entry);
                          },
                          onKeyDown: (event) => {
                            if (
                              event.key === 'ContextMenu' ||
                              (event.shiftKey && event.key === 'Enter')
                            ) {
                              event.preventDefault();
                              dropFavourite(entry);
                            }
                          },
                        },
                        h('span', { className: 'bhrl-favpop__name' }, entry.name),
                        meta ? h('span', { className: 'bhrl-favpop__meta' }, meta) : null,
                      ),
                    );
                  }),
                ),
          )
        : null;

      return h(
        'div',
        {
          className: 'bhrl-root',
          'data-lang': lang,
          'data-mode': inCluster ? 'cluster' : 'black-hole',
          'data-state': modeState.state,
          'data-transition': modeState.transitioning ? 'true' : 'false',
        },
        h(
          'section',
          { className: 'bhrl-stage', 'aria-label': t('stageLabel'), ref: stageElRef },
          h('div', { className: 'bhrl-stage__canvas', ref: setCanvasNode, 'data-bhrl-canvas': true }),
          hoverCardNode,

          /*
           * The search box. It is the page's only chrome, and the hole is its
           * only handle: a tap opens it, Escape or a chosen result closes it.
           * Nothing else is drawn over the scene.
           */
          searchOpen
            ? h(
                'div',
                { className: 'bhrl-search', role: 'search' },
                h(
                  'div',
                  { className: 'bhrl-search__field' },
                  h('input', {
                    className: 'bhrl-search__input',
                    type: 'search',
                    value: searchText,
                    placeholder: t('searchPlaceholder'),
                    'aria-label': t('searchLabel'),
                    autoFocus: true,
                    onChange: (event) => setSearchText(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key !== 'Enter') return;
                      const first = searchResults[0];
                      if (!first) return;
                      setSearchText('');
                      setSearchOpen(false);
                      chooseStation(first);
                    },
                  }),
                ),
                searchResults.length
                  ? h(
                      'ul',
                      { className: 'bhrl-search__list', onScroll: onSearchScroll },
                      searchVisible.map((station) =>
                        h(
                          'li',
                          { key: String(station.id), className: 'bhrl-search__row' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'bhrl-search__hit',
                              onClick: () => {
                                setSearchText('');
                                setSearchOpen(false);
                                chooseStation(station);
                              },
                            },
                            h('span', { className: 'bhrl-search__name' }, station.name),
                            h(
                              'span',
                              { className: 'bhrl-search__meta' },
                              [stationPlace(station), genreLabelOf(station.genre)].filter(Boolean).join(' · '),
                            ),
                          ),
                        ),
                      ),
                      searchShown < searchResults.length
                        ? h('li', { className: 'bhrl-search__more', 'aria-hidden': 'true' }, t('searchMore'))
                        : null,
                    )
                  : searchText.trim()
                    ? h('p', { className: 'bhrl-search__empty' }, t('searchHint'))
                    : null,
              )
            : null,

          stage.status === 'loading'
            ? h(
                'div',
                { className: 'bhrl-boot' },
                h(
                  'svg',
                  { className: 'bhrl-boot__disc', viewBox: '0 0 12 12', 'aria-hidden': 'true', focusable: 'false' },
                  h('circle', { cx: 6, cy: 6, r: 5.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1, pathLength: 100, strokeDasharray: '75 25' }),
                ),
                h('span', null, `${t('stageLoading')}…`),
              )
            : null,
          stage.status === 'error'
            ? h(
                'div',
                { className: 'bhrl-fail', role: 'alert' },
                h('p', null, `${t('stageError')} · ${stage.error}`),
                h('button', { type: 'button', className: 'bhrl-btn', onClick: retryStage }, t('stageRetry')),
              )
            : null,

          /**
           * The hole has no chrome at all: no wordmark, no close button, no
           * way-in button, no hint line and no category list. It is a place,
           * not a control panel — holding its centre enters the cluster.
           * Everything drawn over the scene belongs to the cluster.
           */

          /**
           * Nothing is drawn over the scene. The berth's shelves, the tag
           * names, the station names and the per-label counts all live inside
           * the three.js field now: this page has no chrome of its own.
           */
        ),

        /*
         * The library hangs off the root, not the stage: a right press anywhere
         * in the scene opens it, and the stage clips its own overflow.
         */
        favMenuNode,
      );
    }

    /**
     * The corner mark: the zen ripple drawing, inlined as a data URL.
     *
     * Only the strokes travel: each source plate (ink on a white ground, ink on
     * a black one) had its ground dropped, so the alpha comes straight from the
     * plate's own luminance and nothing is left behind but the pattern. The
     * light-theme copy keeps the dark ink, the dark-theme copy the light ink,
     * which is why there are two. Inlined because the client half is served as
     * one file with no asset route, and because a few KB in the bundle is
     * cheaper than a second request a sidebar cell would have to wait for.
     */
    const LOGO_MARK_URLS = Object.freeze({
  light: 'data:image/webp;base64,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',
  dark: 'data:image/webp;base64,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',
    });

    /**
     * Theme + layout. Scoped under `.bhrl-root`; one injected <style>, removed on
     * unload. The dark palette is artwork — this stage stays dark in light mode.
     */
    const CSS = `
.bhrl-root {
  --bhrl-bg: #030408;
  /* Layout contract: the root is a normal-flow block inside the main
     slot's cell, not an absolutely positioned overlay. Its anchor wrappers
     use display-contents, so the cell is the only box between the panel
     and .BynINW_centerCol; a root that is position-absolute, or merely
     wider than its cell, escapes toward the grid .BynINW_frame and covers
     the sidebar. position-relative + overflow-hidden keep this element the
     containing block for .bhrl-stage and .bhrl-overlay. */
  position: relative;
  /* Fill the main slot without overflowing it: the slot cell is the
     containing block, so no width/height: 100% (which would add to the
     slot's own cell in the centred main column). */
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  --bhrl-ink: #eef1f8;
  --bhrl-ink-dim: rgba(226, 232, 244, 0.68);
  --bhrl-ink-faint: rgba(210, 220, 238, 0.42);
  --bhrl-line: rgba(150, 170, 210, 0.18);
  --bhrl-line-soft: rgba(150, 170, 210, 0.1);
  --bhrl-flare: #ff8a3d;
  overflow: hidden;
  background: var(--bhrl-bg);
  color: var(--bhrl-ink);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  isolation: isolate;
}
.bhrl-root *, .bhrl-root *::before, .bhrl-root *::after { box-sizing: border-box; }
.bhrl-stage { position: absolute; inset: 0; overflow: hidden; }
.bhrl-stage__canvas { position: absolute; inset: 0; }
.bhrl-stage__canvas canvas { display: block; }
.bhrl-stage__canvas canvas:focus-visible { outline: 1px solid rgba(255, 190, 140, 0.55); outline-offset: -1px; }

/* The search box: the page's only chrome. It hangs over the hole's centre, on
   the axis the tap came from, and it is a field with one row per match — never
   a panel, never a second page. */
.bhrl-search {
  position: absolute; z-index: 7; top: 50%; left: 50%;
  width: min(420px, calc(100% - 48px));
  transform: translate(-50%, -50%);
  display: flex; flex-direction: column; gap: 6px;
  animation: bhrl-search-in 160ms ease-out both;
}
@keyframes bhrl-search-in {
  from { opacity: 0; transform: translate(-50%, -46%); }
  to { opacity: 1; transform: translate(-50%, -50%); }
}
.bhrl-search__field {
  display: flex; align-items: center; gap: 6px;
  padding: 9px 10px 9px 13px;
  border-radius: 999px; border: 1px solid rgba(255, 176, 118, 0.30);
  background: rgba(8, 7, 9, 0.90); backdrop-filter: blur(10px) saturate(120%);
  box-shadow: 0 18px 44px -18px rgba(0, 0, 0, 0.82), 0 0 0 1px rgba(0, 0, 0, 0.28);
}
.bhrl-search__field:focus-within { border-color: rgba(255, 196, 146, 0.62); }
.bhrl-search__input {
  flex: 1 1 auto; min-width: 0;
  border: 0; outline: 0; background: transparent;
  color: var(--bhrl-ink); font: inherit; font-size: 13px; letter-spacing: 0.01em;
}
.bhrl-search__input::placeholder { color: var(--bhrl-ink-faint); }
.bhrl-search__input::-webkit-search-decoration,
.bhrl-search__input::-webkit-search-cancel-button { appearance: none; }
.bhrl-search__list {
  margin: 0; padding: 4px; list-style: none;
  display: flex; flex-direction: column; gap: 1px;
  border-radius: 13px; border: 1px solid rgba(255, 168, 110, 0.16);
  background: rgba(8, 7, 9, 0.90); backdrop-filter: blur(10px) saturate(120%);
  box-shadow: 0 22px 48px -20px rgba(0, 0, 0, 0.86);
  max-height: min(340px, 52vh); overflow-y: auto;
  overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
}
.bhrl-search__hit {
  width: 100%; padding: 7px 9px;
  display: flex; flex-direction: column; gap: 2px; text-align: left;
  border: 0; border-radius: 9px; background: transparent; color: inherit;
  font: inherit; cursor: pointer;
}
.bhrl-search__hit:hover, .bhrl-search__hit:focus-visible {
  background: rgba(255, 255, 255, 0.07); outline: 0;
}
.bhrl-search__name {
  font-size: 12.5px; font-weight: 560; color: var(--bhrl-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bhrl-search__meta {
  font-size: 10.5px; color: var(--bhrl-ink-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bhrl-search__empty {
  margin: 0; padding: 10px 12px;
  border-radius: 11px; border: 1px solid rgba(255, 168, 110, 0.14);
  background: rgba(8, 7, 9, 0.86);
  font-size: 11px; color: var(--bhrl-ink-faint);
}
.bhrl-search__more {
  padding: 8px 9px 3px; text-align: center;
  font-size: 10px; color: var(--bhrl-ink-faint);
}

/* The disk hover card: a floating label, not a panel. It sits above the canvas
   and above the scene chrome, because it is the answer to where the pointer is,
   and it must never be the thing the pointer is over instead of the station. */
.bhrl-hovercard {
  position: absolute; z-index: 6; width: 232px; padding: 9px 11px 10px;
  display: flex; flex-direction: column; gap: 3px;
  border-radius: 10px; border: 1px solid rgba(255, 168, 110, 0.24);
  background: rgba(9, 7, 6, 0.88); color: var(--bhrl-ink);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);
  font-size: 11.5px; line-height: 1.5; text-align: left;
  pointer-events: auto; user-select: none;
  animation: bhrl-card-in 120ms ease-out;
}
@keyframes bhrl-card-in { from { opacity: 0; } to { opacity: 1; } }
.bhrl-hovercard[data-touch='true'] { animation: none; }
/* Title line: the station's name and the mark that changes the library, so the
   action sits with the thing it acts on instead of under the text. */
.bhrl-hovercard__head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.bhrl-hovercard__name {
  font-size: 12.5px; font-weight: 600; letter-spacing: 0.01em;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bhrl-hovercard__meta { font-size: 10.5px; color: var(--bhrl-ink-dim); }
/* The card's second line: what the station is, with the live badge beside it. */
.bhrl-hovercard__row { display: flex; align-items: center; gap: 6px; margin-top: 4px; min-width: 0; }
.bhrl-hovercard__genre { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--bhrl-ink-dim); min-width: 0; }
.bhrl-hovercard__dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.bhrl-hovercard__live {
  flex: none; padding: 1px 5px; border-radius: 4px;
  background: rgba(255, 150, 86, 0.16); color: #ffb884;
  font-size: 8.5px; letter-spacing: 0.1em; text-transform: uppercase;
}
.bhrl-hovercard__hint { margin-top: 5px; font-size: 10px; color: var(--bhrl-ink-faint); }
.bhrl-hovercard__fav {
  flex: none; margin-left: auto; padding: 4px 9px; border-radius: 6px;
  border: 1px solid var(--bhrl-line-soft); background: rgba(255, 255, 255, 0.04);
  color: var(--bhrl-ink); font: inherit; font-size: 10.5px; cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease, background 140ms ease;
}
.bhrl-hovercard__fav:hover { border-color: var(--bhrl-line); background: rgba(255, 255, 255, 0.09); }
.bhrl-hovercard__fav[data-active='true'] { color: #ffc08a; border-color: rgba(255, 150, 86, 0.42); }
/* The star alone in the card's action slot: the card is already the station's
   own label, so the only thing worth pressing is the mark that changes the
   library. Square-ish padding keeps it a target rather than a caption. */
.bhrl-hovercard__fav[data-icon='true'] {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 4px 7px;
}

.bhrl-backbtn, .bhrl-iconbtn {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 9px; border-radius: 7px;
  border: 1px solid var(--bhrl-line-soft); background: rgba(8, 11, 18, 0.5); color: rgba(228, 234, 246, 0.78);
  font: inherit; font-size: 11px; letter-spacing: 0.04em; cursor: pointer; backdrop-filter: blur(6px);
  transition: color 140ms ease, border-color 140ms ease, background 140ms ease;
}
.bhrl-backbtn:hover, .bhrl-iconbtn:hover { color: var(--bhrl-ink); border-color: var(--bhrl-line); background: rgba(18, 22, 32, 0.75); }
.bhrl-clusterbar__title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.bhrl-clusterbar__title strong { font-size: 12px; font-weight: 550; letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bhrl-clusterbar__title span { font-size: 9.5px; letter-spacing: 0.08em; color: var(--bhrl-ink-faint); white-space: nowrap; }

.bhrl-cat {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px; border: 0; border-radius: 7px;
  background: transparent; color: inherit; font: inherit; font-size: 11.5px; text-align: left; cursor: pointer;
  transition: background 120ms ease;
}
.bhrl-cat:hover, .bhrl-cat:focus-visible { background: rgba(255, 255, 255, 0.055); outline: none; }
.bhrl-cat__name { color: rgba(232, 238, 250, 0.82); }
.bhrl-cat__n { margin-left: auto; font-size: 9.5px; font-variant-numeric: tabular-nums; color: rgba(206, 218, 238, 0.36); }

.bhrl-btn {
  padding: 5px 10px; border-radius: 6px; border: 1px solid var(--bhrl-line); background: rgba(255, 255, 255, 0.04);
  color: var(--bhrl-ink-dim); font: inherit; font-size: 10.5px; cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;
}
.bhrl-btn:hover { color: var(--bhrl-ink); border-color: rgba(150, 170, 210, 0.36); }
.bhrl-btn:focus-visible { outline: 1px solid rgba(255, 176, 120, 0.7); outline-offset: 2px; }

.bhrl-boot {
  position: absolute; left: 50%; top: 50%; display: flex; align-items: center; gap: 10px;
  transform: translate(-50%, -50%); font-size: 11px; letter-spacing: 0.08em; color: rgba(206, 218, 238, 0.45);
  pointer-events: none;
}
.bhrl-boot__disc { flex: none; width: 12px; height: 12px; color: rgba(255, 160, 100, 0.5); animation: bhrl-spin 900ms linear infinite; }
.bhrl-fail {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(320px, 80%);
  padding: 14px; border-radius: 10px; border: 1px solid rgba(255, 140, 90, 0.35); background: rgba(8, 9, 14, 0.9);
  text-align: center; font-size: 11px; color: var(--bhrl-ink-dim);
}
.bhrl-fail p { margin: 0 0 10px; overflow-wrap: anywhere; }

@keyframes bhrl-spin { to { transform: rotate(360deg); } }
@keyframes bhrl-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes bhrl-rise-in { from { opacity: 0; transform: translate(-50%, -48%); } to { opacity: 1; transform: translate(-50%, -50%); } }

@media (prefers-reduced-motion: reduce) {
  .bhrl-boot__disc { animation: none; }
  .bhrl-eq, .bhrl-eq.is-on { animation: none; }
  .bhrl-fcard [data-overflow="true"] .bhrl-fcard__scroll { animation: none; }
  .bhrl-favpop { animation: none; }
  .bhrl-fcard__mark { transition: none; }
}

/* ---- phase 7: station actions, info overlay, mini player ----------------
   The overlay and the mini player are the only new chrome. Everything here is
   additive: the existing layout rules above are untouched, and every new class
   is namespaced under .bhrl-root so nothing leaks into the harness. */

.bhrl-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid rgba(214, 224, 240, 0.18);
  border-radius: 50%;
  background: rgba(8, 12, 22, 0.62);
  color: rgba(226, 234, 248, 0.78);
  cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease, background-color 140ms ease;
}
.bhrl-act:hover:not(:disabled) { color: #f2f6ff; border-color: rgba(214, 224, 240, 0.42); background: rgba(24, 34, 54, 0.86); }
.bhrl-act:disabled { opacity: 0.34; cursor: default; }
.bhrl-act:focus-visible { outline: 2px solid rgba(150, 190, 255, 0.72); outline-offset: 1px; }
.bhrl-act.is-on { color: #ffd479; border-color: rgba(255, 212, 121, 0.52); }
.bhrl-act-like.is-on { color: #ff8fa6; border-color: rgba(255, 143, 166, 0.52); }
.bhrl-act-play.is-mine { color: #9fe6c4; border-color: rgba(159, 230, 196, 0.52); }

/* A tiny equaliser: the only motion, and the only "this one is playing" cue. */
.bhrl-eq {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  background: rgba(159, 230, 196, 0.35);
  flex: none;
}
.bhrl-eq.is-on { background: #9fe6c4; animation: bhrl-pulse 1.4s ease-in-out infinite; }
@keyframes bhrl-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

/* Chip: one station's inline controls, for lists and the mini player. */
.bhrl-chip { display: inline-flex; align-items: center; gap: 4px; }
.bhrl-chip-name {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bhrl-chip.is-mine .bhrl-chip-name { color: #9fe6c4; }

/* Row: a station list row. */
.bhrl-row { display: flex; align-items: center; gap: 6px; }
.bhrl-row-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.bhrl-row-main:hover { background: rgba(255, 255, 255, 0.05); border-color: rgba(214, 224, 240, 0.14); }
.bhrl-row.is-active .bhrl-row-main { border-color: rgba(150, 190, 255, 0.4); }
.bhrl-row.is-mine .bhrl-row-name { color: #9fe6c4; }
.bhrl-row-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bhrl-row-meta { font-size: 10px; color: rgba(214, 224, 240, 0.48); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bhrl-row-tags { display: inline-flex; flex-wrap: wrap; gap: 3px; margin-top: 2px; }
.bhrl-row-acts { display: inline-flex; align-items: center; gap: 4px; flex: none; }

/* Shared bits used by the list rows and the footer card. */
.bhrl-sep { margin: 0 5px; opacity: 0.5; }
.bhrl-tag {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid rgba(214, 224, 240, 0.16);
  border-radius: 999px;
  font-size: 10px;
  line-height: 1.5;
  color: rgba(214, 224, 240, 0.62);
  white-space: nowrap;
}
.bhrl-state { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; letter-spacing: 0.06em; white-space: nowrap; }
.bhrl-state.is-playing { color: #9fe6c4; }
.bhrl-state.is-paused { color: rgba(214, 224, 240, 0.6); }
.bhrl-act-close { font-size: 15px; line-height: 1; }

/* ------------------------------------------------------------------ *
 *  The station card in the sidebar foot.
 *
 *  This block is deliberately NOT scoped to \`.bhrl-root\`: the card does not
 *  live inside the panel, it lives in the host's sidebar cell, which is a
 *  separate subtree. It therefore declares its own tokens and its own copy
 *  of the surface/act rules the panel uses, at the same visual weight.
 * ------------------------------------------------------------------ */
/* FROZEN (2026-10-30): every rule from here through the \`.bhrl-fcard\` block
 * belongs to the left-column station card and changes only with the user's
 * explicit second confirmation. See AGENTS.md. */
.bhrl-foot {
  /* Everything below is derived from the inherited text colour, so the card
   * reads correctly on any theme — light, dark, or a custom palette — without
   * naming a single colour of its own. */
  --bhrl-ink: currentColor;
  --bhrl-ink-dim: color-mix(in srgb, currentColor 68%, transparent);
  --bhrl-ink-faint: color-mix(in srgb, currentColor 42%, transparent);
  --bhrl-line: color-mix(in srgb, currentColor 22%, transparent);
  --bhrl-line-soft: color-mix(in srgb, currentColor 12%, transparent);
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.45;
  color: inherit;
}
.bhrl-foot *, .bhrl-foot *::before, .bhrl-foot *::after { box-sizing: border-box; }
/* Compensate the host sidebar's bottom padding; leave a 0.5px outer gap. */
.bhrl-foot.is-wide { padding: 8px 0 0; margin-inline: 0; margin-bottom: calc(0.5px - 6px); }
.bhrl-foot.is-rail { display: flex; align-items: center; justify-content: center; padding: 2px 0; }

/* ---- the station card ----------------------------------------------- *
 * Two rows, nothing else: what the selected station is (name, the label line
 * it is airing) and the transport. Anything more pushes the session list up,
 * so the card is exactly as tall as its own controls.
 *
 * The card draws no surface of its own. It used to be a sheet of frosted glass
 * over the sidebar; the sidebar is already the material, and a second tinted
 * sheet inside it only made the two lines look boxed in. So there is no fill,
 * no blur, no ring and no radius left to draw: the text and the four marks sit
 * directly on whatever the sidebar is showing.
 */
.bhrl-fcard {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'text logo'
    'acts acts';
  /* The card is the station: one size in every state. Content centres inside
   * it rather than deciding how tall it is. */
  grid-template-rows: minmax(0, 1fr) auto;
  height: 93px;
  align-items: center;
  column-gap: 6px;
  row-gap: 6px;
  padding: 7px 8px;
}
/* The two lines are one block, and the only space between them is this gap:
 * 8px. Two pixels read as one smudged line; this is what makes the station
 * name and the song name two lines instead of one.
 *
 * The gap is the whole story on purpose. Neither line carries a margin, so both
 * rows stay exactly as tall as their own content and align-items: center puts
 * the star on the name's centre line and the heart on the track's. The block
 * then measures 16.25 + 8 + 14 = 38.25px inside a 49px area, which centres on a
 * whole pixel — at 6px it centred on a half one and the star sat half a pixel
 * above the name. */
.bhrl-fcard__text { grid-area: text; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
.bhrl-fcard__row { display: flex; align-items: center; gap: 5px; min-width: 0; }

/* The corner: the only door to the hole, and now the mark is the button.
 * No ring and no fill of our own: the drawing brings nothing but its strokes,
 * and the two copies differ in ink rather than in ground, so each color scheme
 * gets the one that reads on its glass. */
.bhrl-fcard__logo {
  grid-area: logo;
  align-self: start;
  display: block;
  width: 30px; height: 17.2px; padding: 0;
  border: 0; background: none;
  color: color-mix(in srgb, currentColor 74%, transparent);
  cursor: pointer;
  transition: color 120ms ease;
}
.bhrl-fcard__logo:hover { color: var(--bhrl-ink); }
.bhrl-fcard__logo:focus-visible { outline: 1px solid color-mix(in srgb, currentColor 60%, transparent); outline-offset: 3px; border-radius: 3px; }
.bhrl-fcard__mark {
  /* The badge: the zen ripple drawing, trimmed of its empty margin and of its
   * ground, in the ink that matches the active color scheme. The url arrives
   * on the element itself (see the mark node), so the theme switch is one
   * variable. */
  --bhrl-mark: none;
  display: block; width: 100%; height: 100%;
  background-image: var(--bhrl-mark);
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
  opacity: 0.94;
  transition: opacity 120ms ease;
}
.bhrl-fcard__logo:hover .bhrl-fcard__mark { opacity: 1; }

/* Fixed slot widths: each mark sits exactly where its line ends, and a long
 * name scrolls inside the slot instead of pushing the mark around. */
.bhrl-fcard__name,
.bhrl-fcard__track {
  flex: 0 1 auto; min-width: 0;
  max-width: 166px;
  overflow: hidden;
}
.bhrl-fcard__name {
  margin: 0; font-size: 13px; font-weight: 600; line-height: 1.25; letter-spacing: -0.005em;
  color: var(--bhrl-ink);
}
.bhrl-fcard__track {
  margin: 0; font-size: 10px; line-height: 1.3; color: var(--bhrl-ink-dim);
}
/* The song line is the only part of the card that leads out of it, so it takes
 * the ink up one step and underlines itself on hover; a right-click changes
 * where it goes. The slot stays 166px wide, so the heart next to it never
 * moves. */
.bhrl-fcard__songlink {
  display: block; flex: 0 1 auto; min-width: 0; max-width: 166px;
  color: inherit; text-decoration: none; cursor: pointer;
  -webkit-user-select: none; user-select: none;
  touch-action: manipulation;
}
/* The ticker is measured against clientWidth, which an inline box reports as
 * zero — inside the link the line has to be a block. */
.bhrl-fcard__songlink .bhrl-fcard__track { display: block; }
.bhrl-fcard__songlink:hover .bhrl-fcard__track,
.bhrl-fcard__songlink:focus-visible .bhrl-fcard__track {
  color: var(--bhrl-ink);
  text-decoration: underline dotted;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}
.bhrl-fcard__songlink:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--bhrl-ink) 42%, transparent);
  outline-offset: 1px; border-radius: 3px;
}
.bhrl-fcard__scroll { display: inline-block; white-space: nowrap; will-change: transform; }
/* One-way ticker: the line travels left, the tail comes in from the right, and
 * the next pass restarts at the head. Never reverses. */
.bhrl-fcard [data-overflow="true"] .bhrl-fcard__scroll { animation: bhrl-fcard-marquee 9s linear infinite; }
@keyframes bhrl-fcard-marquee {
  from { transform: translateX(0); }
  to { transform: translateX(calc(-1 * var(--bhrl-shift, 0px))); }
}

.bhrl-fcard[data-status="error"] .bhrl-fcard__track { color: color-mix(in srgb, #ff5f6d 62%, currentColor); }
.bhrl-fcard.is-empty .bhrl-fcard__name { color: color-mix(in srgb, currentColor 74%, transparent); }
.bhrl-fcard.is-empty .bhrl-fcard__track { color: var(--bhrl-ink-faint); }

.bhrl-fcard__acts { grid-area: acts; display: flex; align-items: center; gap: 4px; }

/* Transport: bare glyphs. Previous, play and next are the mark and nothing
 * else — no ring, no fill, no shadow, and nothing appears on hover either; the
 * glyph itself answers by reaching full ink. */
.bhrl-foot .bhrl-fcard__acts .bhrl-act,
.bhrl-foot .bhrl-fcard__acts .bhrl-act:hover:not(:disabled) {
  border: 0; background: none; box-shadow: none;
}
.bhrl-foot .bhrl-fcard__acts .bhrl-act:hover:not(:disabled) { color: var(--bhrl-ink); }
.bhrl-foot .bhrl-fcard__acts .bhrl-act-play {
  width: 34px; height: 34px; flex: none;
  color: var(--bhrl-ink);
}
.bhrl-foot .bhrl-fcard__acts .bhrl-act-play:hover:not(:disabled) { color: var(--bhrl-ink); background: none; }
/* No colour here on purpose: the slider lives inside and paints itself from
 * currentColor, so a faint tint on the wrapper would dim the whole bar. The
 * icon asks for the faint tint itself. */
.bhrl-fcard__vol { display: inline-flex; align-items: center; gap: 4px; flex: 1 1 auto; min-width: 42px; margin-left: 2px; }
.bhrl-fcard__range { color: var(--bhrl-ink); }
.bhrl-fcard__volicon { display: inline-flex; flex: none; color: var(--bhrl-ink-faint); }
.bhrl-fcard__range {
  -webkit-appearance: none; appearance: none;
  width: 100%; min-width: 0; height: 3px; border-radius: 999px;
  /* Two colours, not one: what is set is filled with ink and what is left is
   * the faint rail, so the level is read from the bar instead of being guessed
   * from where the thumb sits. The custom property --bhrl-vol is written from
   * the value on every render, which is why the gradient needs no second
   * element. */
  background-image: linear-gradient(to right,
    color-mix(in srgb, currentColor 78%, transparent) 0 var(--bhrl-vol, 0%),
    color-mix(in srgb, currentColor 14%, transparent) var(--bhrl-vol, 0%) 100%);
  background-color: transparent;
  outline: none; cursor: pointer;
}
.bhrl-fcard__range::-webkit-slider-thumb {
  -webkit-appearance: none; width: 9px; height: 9px; border: 0; border-radius: 50%;
  background: currentColor;
}
.bhrl-fcard__range::-moz-range-thumb { width: 9px; height: 9px; border: 0; border-radius: 50%; background: currentColor; }
.bhrl-fcard__range:disabled { opacity: 0.4; cursor: default; }

/* ---- the two unfolded lists -------------------------------------------
   One panel shape for both marks. It is an overlay rather than a child layout,
   so it never pushes the card's 236x93 box around and the sidebar never clips
   it; the corner it hangs from is decided in the component, not here. */
.bhrl-favpop {
  position: fixed;
  z-index: 60;
  min-width: 180px;
  max-width: min(260px, calc(100vw - 16px));
  max-height: 240px;
  overflow: hidden;
  padding: 8px;
  border: 1px solid var(--bhrl-line-soft);
  border-radius: 10px;
  background: var(--dsw-specific-menu, color-mix(in srgb, var(--bhrl-ink) 6%, transparent));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.42);
  color: var(--bhrl-ink);
  text-align: left;
  animation: bhrl-favpop-in 120ms ease both;
}
.bhrl-favpop__title { margin: 0 0 6px; font-size: 10px; line-height: 1.3; color: var(--bhrl-ink-dim); }
.bhrl-favpop__empty { margin: 0; font-size: 10px; color: var(--bhrl-ink-faint); }
.bhrl-favpop__list {
  display: flex; flex-direction: column; gap: 5px;
  margin: 0; padding: 0; list-style: none;
  max-height: 196px; overflow-y: auto;
}
/* One row of a list is a control, not a label: a station starts playing and a
 * song opens its search, so the row itself carries the button and link shape.
 * The list item is only the slot it sits in. */
.bhrl-favpop__row { margin: 0; }
.bhrl-favpop__item {
  display: flex; flex-direction: column; gap: 1px;
  width: 100%; margin: 0; padding: 3px 4px; border: 0; border-radius: 6px;
  background: none; color: inherit; font: inherit; text-align: left;
  text-decoration: none; cursor: pointer;
}
.bhrl-favpop__item:hover,
.bhrl-favpop__item:focus-visible { background: color-mix(in oklab, var(--bhrl-ink) 8%, transparent); }
.bhrl-favpop__item:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--bhrl-ink) 40%, transparent);
  outline-offset: 1px;
}
.bhrl-favpop__name {
  font-size: 11px; line-height: 1.3;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bhrl-favpop__meta {
  font-size: 10px; line-height: 1.25; color: var(--bhrl-ink-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* The platform picker: one row per platform, the current one marked on the
 * right rather than by a tick, so the row never changes height. */
.bhrl-favpop__body { display: flex; flex-direction: column; gap: 6px; }
.bhrl-favpop__opt {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  width: 100%; margin: 0; padding: 3px 4px; border: 0; border-radius: 6px;
  background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.bhrl-favpop__opt:hover,
.bhrl-favpop__opt:focus-visible { background: color-mix(in oklab, var(--bhrl-ink) 8%, transparent); }
.bhrl-favpop__opt:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--bhrl-ink) 40%, transparent);
  outline-offset: 1px;
}
.bhrl-favpop__opt:not(.is-on) .bhrl-favpop__name { color: var(--bhrl-ink-dim); }
.bhrl-favpop__opt.is-on .bhrl-favpop__meta { color: var(--bhrl-ink-dim); }
@keyframes bhrl-favpop-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}

.bhrl-foot .bhrl-sep { opacity: 0.5; margin: 0 4px; }
.bhrl-foot .bhrl-act {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; border-radius: 50%;
  border: 1px solid var(--bhrl-line-soft); background: color-mix(in srgb, currentColor 5%, transparent);
  color: var(--bhrl-ink-dim); cursor: pointer; flex: none;
  transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
}
.bhrl-foot .bhrl-act:hover:not(:disabled) { color: var(--bhrl-ink); border-color: var(--bhrl-line); background: color-mix(in srgb, currentColor 11%, transparent); }
.bhrl-foot .bhrl-act:disabled { opacity: 0.42; cursor: default; }
/* A mark with nothing to act on looks dim but still answers the pointer, so
   its list stays reachable from an empty card or before a title arrives. */
.bhrl-foot .bhrl-act[aria-disabled="true"] { opacity: 0.42; cursor: default; }
.bhrl-foot .bhrl-act[aria-disabled="true"]:hover { color: var(--bhrl-ink-dim); border-color: var(--bhrl-line-soft); background: color-mix(in srgb, currentColor 5%, transparent); }
.bhrl-foot .bhrl-act.is-on { color: color-mix(in srgb, #ffab52 58%, currentColor); border-color: color-mix(in srgb, #ffab52 34%, transparent); }
.bhrl-foot .bhrl-act-like.is-on { color: color-mix(in srgb, #ff6b8e 58%, currentColor); border-color: color-mix(in srgb, #ff6b8e 34%, transparent); }
/* The hover rule above counts one more class than the "on" rules, so under the
   pointer an on mark would drop back to plain ink exactly while it is being
   read. Repeat the tint at the hover weight instead: the mark stays warm, and
   the pointer answers through a slightly stronger mix rather than a colour
   change. */
.bhrl-foot .bhrl-act.is-on:hover:not(:disabled) { color: color-mix(in srgb, #ffab52 72%, currentColor); }
.bhrl-foot .bhrl-act-like.is-on:hover:not(:disabled) { color: color-mix(in srgb, #ff6b8e 72%, currentColor); }

/* The two marks that belong to a line, not to the transport: they sit inline
 * with the name and the track, quiet until they are on. No ring in any state —
 * not at rest, not under the pointer, not once they are on and tinted: the
 * glyph's colour is the whole answer, and a ring here would have made the mark
 * look like a third control boxed into the line. The border stays declared as
 * transparent, so turning it off costs no layout: the 16px and 14px boxes keep
 * the sizes below. */
.bhrl-fcard__row .bhrl-act,
.bhrl-fcard__row .bhrl-act:hover:not(:disabled),
.bhrl-fcard__row .bhrl-act.is-on,
.bhrl-fcard__row .bhrl-act.is-on:hover:not(:disabled) {
  width: 16px; height: 16px; border-color: transparent; background: transparent;
}
/* The sub row's mark is a size smaller than the name row's, and it keeps that
 * size under the pointer: the pair below has to repeat the hover clause the
 * row rule above carries, or the resting 14px would lose to it on hover and
 * grow the button by 2px — which re-centres the whole text block and nudges
 * the name, the star and the heart sideways for as long as the pointer is
 * there. */
.bhrl-fcard__row--sub .bhrl-act,
.bhrl-fcard__row--sub .bhrl-act.is-on,
.bhrl-fcard__row--sub .bhrl-act:hover:not(:disabled),
.bhrl-fcard__row--sub .bhrl-act.is-on:hover:not(:disabled) { width: 14px; height: 14px; }

.bhrl-foot .bhrl-eq { display: inline-block; width: 3px; height: 8px; background: currentColor; }
.bhrl-foot .bhrl-eq.is-on { animation: bhrl-eq 900ms ease-in-out infinite alternate; }
@keyframes bhrl-eq { from { height: 3px; } to { height: 9px; } }

.bhrl-foot-rail {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border-radius: 50%;
  border: 1px solid var(--bhrl-line-soft); background: color-mix(in srgb, currentColor 6%, transparent);
  cursor: pointer;
}
.bhrl-foot-rail__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--bhrl-ink-faint); }
.bhrl-foot-rail.is-playing .bhrl-foot-rail__dot { background: color-mix(in srgb, #ffab52 60%, currentColor); box-shadow: 0 0 0 3px color-mix(in srgb, #ffab52 16%, transparent); }
`;

    return {
      inject: ['slots', 'locale', 'layout'],

      apply(ctx) {
        const localeSvc = ctx.get ? ctx.get('locale') : null;
        const layoutSvc = ctx.get ? ctx.get('layout') : null;

        // Declared before the first `else` branch that may push onto it: a
        // host without `ctx.effect` takes that branch, and a `const` below
        // would make it a TDZ ReferenceError rather than a graceful fallback.
        const disposers = [];

        // The shared state exists before any view does and outlives all of them.
        // Its teardown is bound to the plugin's own lifecycle, never to a panel
        // unmounting: closing the black hole or dropping a WebGL context must
        // not silence the radio.
        const shared = createSharedState();
        // Closing DSH hides the window before the renderer goes; stop at the
        // first unload signal instead of waiting to be killed. `pagehide` is
        // that signal — a media element does not stop itself.
        shared.watchUnload();
        // Optional access, never an inject: a host without a theme service must
        // still load the plugin, it only loses the light/dark answer.
        shared.theme = createThemeSource(ctx);
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => shared.dispose(), 'blackhole-radio-lab: shared playback and state');
        } else {
          disposers.push(() => shared.dispose());
        }

        if (!document.getElementById(STYLE_ID)) {
          const style = document.createElement('style');
          style.id = STYLE_ID;
          style.textContent = CSS;
          document.head.appendChild(style);
        }

        if (localeSvc && typeof localeSvc.register === 'function') {
          ctx.effect(() => localeSvc.register(NS, DICT), 'blackhole-radio-lab: dictionaries');
        }

        const claim = (meta, component) => {
          const dispose = ctx.slots.inject(meta.name, () => ctx.slots.register(meta, component));
          if (typeof dispose === 'function') disposers.push(dispose);
        };

        /**
         * The card is the way in.
         *
         * There is no sidebar entry for this plugin any more: the card itself
         * is the station, and pressing its blank area opens the hole. Nothing
         * else in the navigation column changes shape because of us.
         */
        const openPanel = () => {
          try {
            if (layoutSvc && typeof layoutSvc.selectPanel === 'function') layoutSvc.selectPanel(PANEL_ID);
          } catch {
            /* no keyed main entry in this composition — nothing to open */
          }
        };

        /**
         * The station card lives in the sidebar foot, not in the panel.
         *
         * The host declares this cell as "optional actions beside Settings at
         * the sidebar foot", so it outlives the main column: closing the panel,
         * switching away from it, or releasing the stage's WebGL context never
         * unmounts it. It receives `{ wide }` and nothing else — all its state
         * comes from `shared`, which `apply()` owns.
         */
        claim({ name: 'sidebar.footer.action', id: `${PANEL_ID}-station`, order: 46, label: () => makeT(localeSvc)('sidebarEntry') }, (ownerProps) =>
          h(SidebarStation, {
            localeSvc,
            requireAsync: require.async,
            shared,
            onOpen: openPanel,
            wide: !(ownerProps && ownerProps.wide === false),
          }),
        );

        claim(
          { name: 'main', key: PANEL_ID },
          () => h(Panel, { localeSvc, requireAsync: require.async, shared, layoutSvc }),
        );

        ctx.effect(
          () => () => {
            for (const dispose of disposers.splice(0)) {
              try {
                dispose();
              } catch {
                /* already disposed by the framework's own unload */
              }
            }
            const node = document.getElementById(STYLE_ID);
            if (node && node.parentNode) node.parentNode.removeChild(node);
          },
          'blackhole-radio-lab: client teardown',
        );
      },
    };
  },
});
