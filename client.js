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
  id: '@local/dsh-blackhole-radio-lab',

  factory(require) {
    const React = require('react');
    const {
      createElement: h,
      useCallback,
      useEffect,
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
      stationCount: 2000,
      seed: 20261022,
      featuredCount: 18,
      // How much of the Radio Browser directory to pull. The API answers in
      // pages, so this is a count and a page size rather than one number; the
      // budget is what stops a slow mirror from stalling the boot.
      sourceLimit: 5000,
      sourcePageSize: 500,
      sourceTimeoutMs: 12000,
      sourceBudgetMs: 60000,
    };

    /** Close delay that lets the pointer travel from the hole into the panel. */
    const HOVER_CLOSE_MS = 320;

    const DICT = {
      zh: {
        sidebarEntry: '黑洞电台',
        wordmark: '黑洞电台',
        phaseTag: '第四阶段',
        close: '返回对话',
        stageLabel: '三维舞台',
        stageLoading: '正在加载三维场景',
        stageError: '场景加载失败',
        stageRetry: '重新加载',
        demoBadge: '演示数据',
        liveBadge: '真实电台',
        fallbackBadge: '模拟数据 · 实时源不可用',
        openSearch: '打开搜索',
        enterGenres: '进入流派星团',
        searchLabel: '搜索',
        searchPlaceholder: '搜索电台、国家、语言或分类',
        searchClear: '清除',
        searchHint: '回车定位 · Esc 关闭',
        noResults: '这里还没有电台',
        categories: '分类',
        categoriesHint: '停留显示 · 选择进入',
        clusterBack: '黑洞',
        clusterSearch: '搜索电台',
        clusterStations: '个电台',
        nebulaGroupAll: '全部',
        nebulaGroupBy: '按标签分组',
        country: '国家/地区',
        language: '语言',
        category: '分类',
        description: '简介',
        stationId: 'ID',
        closeDetail: '关闭详情',
        featuredNote: '精选电台 · 内环亮带中的稳定结构',
        demoNote: '模拟电台，仅用于界面演示；实时源不可用时替代显示，不含播放能力。',
        liveNote: '真实电台数据，来自 Radio Browser；本阶段尚未接入音频播放。',
        hintBlackHole: '点击星点选中电台 · 点击中心进入流派星团 · 拖动环绕 · 滚轮缩放',
        hintCluster: '拖动环绕星团 · 滚轮缩放 · 点击星点查看 · 右键返回黑洞',
        dataError: '模拟数据加载失败',
        // ---- phase 7: business actions -----------------------------------
        playAction: '播放',
        pauseAction: '暂停',
        favouriteAction: '收藏',
        unfavouriteAction: '取消收藏',
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
        viewNebula: '星云空间',
        viewHole: '黑洞',
        nebulaBack: '黑洞',
        nebulaTitle: '星云空间',
        nebulaGenres: '个流派',
        nebulaStationList: '流派电台',
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
        wordmark: 'BLACK HOLE RADIO',
        phaseTag: 'PHASE 4',
        close: 'Back to conversation',
        stageLabel: '3-D stage',
        stageLoading: 'loading the 3-D scene',
        stageError: 'scene failed to load',
        stageRetry: 'Reload',
        demoBadge: 'Demo data',
        liveBadge: 'Live stations',
        fallbackBadge: 'Simulated · live source offline',
        openSearch: 'Open search',
        enterGenres: 'Enter genre clusters',
        searchLabel: 'Search',
        searchPlaceholder: 'Search stations, countries, languages or categories',
        searchClear: 'Clear',
        searchHint: 'Enter to locate · Esc to close',
        noResults: 'No stations here yet',
        categories: 'Categories',
        categoriesHint: 'Dwell to reveal · pick to enter',
        clusterBack: 'Black hole',
        clusterSearch: 'Search stations',
        clusterStations: 'stations',
        nebulaGroupAll: 'All',
        nebulaGroupBy: 'Grouped by tag',
        country: 'Country / region',
        language: 'Language',
        category: 'Categories',
        description: 'About',
        stationId: 'ID',
        closeDetail: 'Close detail',
        featuredNote: 'Featured · a steadier structure in the inner rim',
        liveNote: 'Real station from Radio Browser. This phase does not play audio yet.',
        demoNote: 'Simulated stations for this interface only. Shown when the live source is offline; nothing plays.',
        hintBlackHole: 'Click a star for its station card · click the centre for genre clusters · drag to orbit · scroll to zoom',
        hintCluster: 'Drag to orbit the cluster · scroll to zoom · click a star · right-click for the hole',
        dataError: 'mock data failed to load',
        // ---- phase 7: business actions -----------------------------------
        playAction: 'Play',
        pauseAction: 'Pause',
        favouriteAction: 'Favourite',
        unfavouriteAction: 'Remove from favourites',
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
        viewNebula: 'Nebula space',
        viewHole: 'Black hole',
        nebulaBack: 'Black hole',
        nebulaTitle: 'Nebula space',
        nebulaGenres: 'genres',
        nebulaStationList: 'Genre stations',
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
     *              likes). Same object for the black hole and the nebula.
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
          shared.data = Promise.resolve()
            .then(() => requireAsync(RADIO_CHUNK))
            .then(async (radio) => {
              const store = shared.ensureStore(radio.createRadioStore);
              let repository = null;
              let fallback = null;
              try {
                const outcome = await radio.createRadioRepository({
                  count: conf.stationCount,
                  seed: conf.seed,
                  featuredCount: conf.featuredCount,
                  mode: conf.sourceMode || 'auto',
                  limit: conf.sourceLimit,
                  pageSize: conf.sourcePageSize,
                  timeoutMs: conf.sourceTimeoutMs,
                  budgetMs: conf.sourceBudgetMs,
                });
                repository = outcome && outcome.repository ? outcome.repository : null;
                fallback = outcome ? outcome.fallback : null;
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
              if (store && repository) store.index(repository.list());
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
              };
            });
          return shared.data;
        },
        /**
         * The data chunk is only loadable from a panel, so the store is built
         * on the first successful load and then reused for the plugin's life.
         */
        ensureStore(createStore) {
          if (!shared.radio && typeof createStore === 'function') shared.radio = createStore();
          return shared.radio;
        },
        ensurePlayback(createPlayback) {
          if (!shared.playback && typeof createPlayback === 'function') shared.playback = createPlayback();
          return shared.playback;
        },
        /**
         * The small amount of the data chunk the panel itself needs: genre
         * labels and colours for list headers, and the station-key function so
         * a list can compare a row's identity with the selection without
         * holding a second opinion about what identity means.
         */
        env: null,
        bindEnv(chunk) {
          if (shared.env || !chunk) return shared.env;
          shared.env = {
            genreLabel: typeof chunk.genreLabel === 'function' ? chunk.genreLabel : (id) => String(id),
            genreCss: typeof chunk.genreCss === 'function' ? chunk.genreCss : () => '#9a9a9a',
            stationKey: typeof chunk.stationKey === 'function' ? chunk.stationKey : null,
            isMusicGenre: typeof chunk.isMusicGenre === 'function' ? chunk.isMusicGenre : () => false,
          };
          return shared.env;
        },
        dispose() {
          if (shared.playback && typeof shared.playback.dispose === 'function') {
            try {
              shared.playback.dispose();
            } catch {
              /* the element may already be gone */
            }
          }
          shared.playback = null;
          shared.radio = null;
          shared.data = null;
          shared.env = null;
        },
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
      const memo = useRef({ version: -1, value: undefined, source: null });
      const getSnapshot = useCallback(() => {
        if (!subject) return undefined;
        const source = typeof subject.getSnapshot === 'function' ? subject.getSnapshot() : subject.getState();
        const version = source && typeof source.version === 'number' ? source.version : null;
        if (memo.current.source !== subject || (version !== null && memo.current.version !== version)) {
          memo.current = { version: version === null ? memo.current.version : version, value: selector(source), source: subject };
        } else if (memo.current.value === undefined) {
          memo.current.value = selector(source);
        }
        return memo.current.value;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps ? [subject, ...deps] : [subject]);
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
     *  Every surface (black-hole overlay, nebula list, search results, mini
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
     *   onFocus    optional: bring it into view / widen a nebula
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

    function CategoryDot({ color }) {
      return h('i', { className: 'bhrl-catdot', style: { background: color }, 'aria-hidden': 'true' });
    }

    /**
     * Group the catalogue by the genre the nebula space shows.
     *
     * A genre that folded into Other must appear inside Other's volume, not as
     * a fourteenth nebula nobody can click, so the grouping is resolved through
     * `display` exactly as `repository.listByGenre(id)` does by default. The
     * repository is the only classifier; nothing here re-derives a genre.
     */
    function groupByNebula(stations, nebulaIds) {
      const allowed = new Set(Array.isArray(nebulaIds) ? nebulaIds : []);
      const groups = new Map();
      for (const station of Array.isArray(stations) ? stations : []) {
        const raw = (station && station.genre) || 'other';
        const id = allowed.has(raw) ? raw : allowed.has('other') ? 'other' : null;
        if (!id) continue;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(station);
      }
      return groups;
    }

    /** How many stations one genre panel renders before it stops. */
    const NEBULA_LIST_LIMIT = 24;

    /** How many tag groups one genre panel opens at once. */
    const NEBULA_GROUP_LIMIT = 8;

    /**
     * Group one genre's stations by the tags they actually carry.
     *
     * The tags are the source's own strings, read from `metadata.tags`; a
     * station with no tag at all goes to the untagged bucket rather than being
     * given one. A station that carries several tags appears under each of
     * them — the same record, in several groups, never a second entity, and
     * every appearance still points at the same `station.id`.
     */
    function groupByTags(stations) {
      const groups = new Map();
      const untagged = [];
      for (const station of Array.isArray(stations) ? stations : []) {
        const info = stationInfoOf(station);
        if (info.tags.length === 0) {
          untagged.push(station);
          continue;
        }
        for (const tag of info.tags) {
          if (!groups.has(tag)) groups.set(tag, []);
          groups.get(tag).push(station);
        }
      }
      const ordered = [...groups.entries()].sort((a, b) => (b[1].length === a[1].length ? (a[0] < b[0] ? -1 : 1) : b[1].length - a[1].length));
      const shown = ordered.slice(0, NEBULA_GROUP_LIMIT);
      if (untagged.length > 0) shown.push(['', untagged]);
      return shown;
    }

    /**
     * The station list of one nebula volume.
     *
     * This is the nebula's station card surface: the volume is a genus, the rows
     * are its stations, and every row carries the same `StationCard` the bullet
     * information layer uses. The rows are grouped by the tags the stations
     * really have, so one genre opens as a small set of tag groups rather than
     * one undifferentiated list. A row is never a second owner of play,
     * favourite or like state — it renders `shared.radio` and calls
     * `shared.playback` and nothing else.
     */
    function NebulaStationList(props) {
      const { genreId, stations, genreLabelOf, genreColorOf, selectedKey, shared, t, onClose, onFocus } = props;
      if (!genreId) return null;
      const groups = groupByTags(stations);
      let budget = NEBULA_LIST_LIMIT;
      return h(
        'aside',
        {
          className: 'bhrl-nebula-list',
          'data-genre': genreId,
          'aria-live': 'polite',
          'aria-label': t('nebulaStationList'),
          onPointerDown: (event) => event.stopPropagation(),
        },
        h(
          'header',
          { className: 'bhrl-nebula-list__head' },
          h(CategoryDot, { color: genreColorOf(genreId) }),
          h('strong', null, genreLabelOf(genreId)),
          h('span', { className: 'bhrl-nebula-list__n' }, `${stations.length} ${t('clusterStations')}`),
          h(
            'button',
            { type: 'button', className: 'bhrl-act bhrl-act-close', onClick: onClose, title: t('closeDetail'), 'aria-label': t('closeDetail') },
            h(Cross, { size: 11 }),
          ),
        ),
        stations.length === 0
          ? h('p', { className: 'bhrl-nebula-list__empty' }, t('noResults'))
          : groups.map(([tag, members]) => {
              if (budget <= 0) return null;
              const shown = members.slice(0, budget);
              budget -= shown.length;
              const label = tag || t('nebulaGroupAll');
              return h(
                'section',
                { className: 'bhrl-nebula-group', key: tag || '__untagged', 'data-tag': tag || '' },
                h(
                  'header',
                  { className: 'bhrl-nebula-group__head' },
                  h('span', { className: 'bhrl-nebula-group__name' }, label),
                  h('span', { className: 'bhrl-nebula-group__n' }, String(members.length)),
                ),
                h(
                  'ul',
                  { className: 'bhrl-nebula-rows' },
                  shown.map((station) =>
                    h(StationCard, {
                      key: `${tag || 'untagged'}:${station.id}`,
                      station,
                      shared,
                      t,
                      variant: 'row',
                      active: selectedKey !== null && station.id === selectedKey,
                      onFocus,
                    }),
                  ),
                ),
              );
            }),
      );
    }

    /**
     * What played before the current station.
     *
     * Module scope on purpose: "previous" is a fact about the listening
     * session, not about one mount of the card. Bounded, so a long session
     * cannot grow it without limit.
     */
    const PLAY_HISTORY_MAX = 20;
    const playHistory = [];

    function notePlayed(stationId) {
      const id = stationId === null || stationId === undefined ? '' : String(stationId);
      if (!id) return;
      if (playHistory[playHistory.length - 1] === id) return;
      playHistory.push(id);
      if (playHistory.length > PLAY_HISTORY_MAX) playHistory.shift();
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
     * from the whole catalogue. Hovering either mark unfolds the list it owns.
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
      const lastPlayedRef = useRef(null);

      // What the station last said it was playing. Kept beside the station it
      // came from: a title only counts while its station is the one on the
      // card, so switching stations can never leave the last song behind.
      const [nowPlaying, setNowPlaying] = useState(EMPTY_NOW_PLAYING);
      // The mark whose list is unfolded, and where its panel is pinned. The
      // panel is an overlay positioned from the mark's own rectangle, because
      // the sidebar would clip anything drawn inside the card's box.
      const [reveal, setReveal] = useState(null);
      const closeTimer = useRef(0);
      useEffect(
        () => () => {
          if (closeTimer.current) clearTimeout(closeTimer.current);
        },
        [],
      );
      // An unfolded list is a popup, so it closes the ways a popup does: Escape,
      // or a press anywhere that is not the panel and not one of the two marks.
      useEffect(() => {
        if (!reveal) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setReveal(null);
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

      // Keep a short log of what the audio element has actually played, so
      // "previous" means the station heard before this one.
      useEffect(() => {
        const id = playState && playState.stationId ? String(playState.stationId) : null;
        if (!id || !playState || playState.status === 'idle') return;
        if (lastPlayedRef.current && lastPlayedRef.current !== id) notePlayed(lastPlayedRef.current);
        lastPlayedRef.current = id;
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
        let alive = true;
        let timer = 0;
        const ask = () => {
          let pending;
          try {
            pending = fetch(`${NOW_PLAYING_URL}?url=${encodeURIComponent(stream)}`, { cache: 'no-store' });
          } catch {
            return;
          }
          Promise.resolve(pending)
            .then((response) => (response && response.ok ? response.json() : null))
            .then((body) => {
              if (!alive) return;
              const title = body && typeof body.title === 'string' ? body.title.trim().slice(0, 160) : '';
              setNowPlaying((previous) =>
                previous.stationId === id && previous.title === title ? previous : { stationId: id, title },
              );
            })
            .catch(() => {
              if (!alive) return;
              setNowPlaying((previous) => (previous.stationId === id ? previous : { stationId: id, title: '' }));
            })
            .then(() => {
              if (alive) timer = setTimeout(ask, NOW_PLAYING_POLL_MS);
            });
        };
        ask();
        return () => {
          alive = false;
          if (timer) clearTimeout(timer);
        };
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

      const playPrevious = () => {
        const currentId = playState && playState.stationId ? String(playState.stationId) : '';
        while (playHistory.length > 0) {
          const id = playHistory.pop();
          if (!id || id === currentId) continue;
          const next = store ? store.getStation(id) : null;
          if (next && streamOf(next)) {
            startStation(next);
            return;
          }
        }
      };

      /**
       * Shuffle: the button to the right of play, and what play does when the
       * card has no station to resume yet. It never returns the station the
       * card is already showing, so "next" always means a different one.
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

      // The two marks own one list each and sit next to the line they belong
      // to: the star is the station, the heart is the song. A hover (or a
      // keyboard focus) unfolds that list above the card; the click is still
      // just the toggle, so the marks keep doing exactly one thing each.
      const cancelClose = () => {
        if (closeTimer.current) {
          clearTimeout(closeTimer.current);
          closeTimer.current = 0;
        }
      };
      const scheduleClose = () => {
        cancelClose();
        closeTimer.current = setTimeout(() => setReveal(null), 200);
      };
      // Where the panel hangs. It is aligned to the side of the mark that has
      // room: the sidebar sits on the left, so a mark there grows rightward,
      // and the clamp keeps the whole box inside the viewport.
      const FAVPOP_WIDTH = 208;
      const unfoldList = (kind, event) => {
        cancelClose();
        const node = event && event.currentTarget;
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
      const listHandlers = (kind) => ({
        onPointerEnter: (event) => unfoldList(kind, event),
        onPointerLeave: scheduleClose,
        onFocus: (event) => unfoldList(kind, event),
        onBlur: scheduleClose,
      });

      // A mark is never really `disabled`: a disabled button stops firing
      // pointer events, and that would take the list away exactly when it is
      // the only way to reach it. The click guards itself, and the dimming is
      // driven by `aria-disabled` so hovering still unfolds the panel.
      const favouriteButton = actButton(
        `bhrl-act-fav${favourite ? ' is-on' : ''}`,
        () => store && hasStation && store.toggleFavorite(station),
        favourite ? t('unfavouriteAction') : t('favouriteAction'),
        h(StarGlyph, { size: 12, filled: favourite }),
        Object.assign(
          {
            'aria-pressed': favourite ? 'true' : 'false',
            'aria-disabled': !hasStation || !store ? 'true' : 'false',
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
            'aria-pressed': liked ? 'true' : 'false',
            'aria-disabled': !song || !store ? 'true' : 'false',
          },
          listHandlers('songs'),
        ),
      );

      // The unfolded list. It is an overlay pinned to the mark's corner, so it
      // is never clipped by the foot and never moves the card's 236x93 box.
      const listEntries = reveal ? (reveal.kind === 'stations' ? favouriteStations : likedSongs) : [];
      const popover = reveal
        ? h(
            'div',
            Object.assign(
              {
                className: 'bhrl-favpop',
                style: {
                  bottom: `${reveal.bottom}px`,
                  right: reveal.right === undefined ? 'auto' : `${reveal.right}px`,
                  left: reveal.left === undefined ? 'auto' : `${reveal.left}px`,
                },
                role: 'dialog',
                'aria-label': reveal.kind === 'stations' ? t('favouriteListTitle') : t('likeListTitle'),
              },
              { onPointerEnter: cancelClose, onPointerLeave: scheduleClose },
            ),
            h(
              'p',
              { className: 'bhrl-favpop__title' },
              `${reveal.kind === 'stations' ? t('favouriteListTitle') : t('likeListTitle')} · ${listEntries.length}`,
            ),
            listEntries.length === 0
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
                    return h(
                      'li',
                      { className: 'bhrl-favpop__item', key: `${index}-${isStation ? entry.id : entry.key}` },
                      h('span', { className: 'bhrl-favpop__name' }, name),
                      meta ? h('span', { className: 'bhrl-favpop__meta' }, meta) : null,
                    );
                  }),
                ),
          )
        : null;

      // The hole has one door: the black-hole mark in the corner. Every other
      // pixel of the card belongs to the station — a stray click on a name
      // must not navigate away from what is being listened to.
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
            h(OverflowText, { tag: 'p', className: 'bhrl-fcard__track', text: displayTrack }),
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
          h('span', { className: 'bhrl-fcard__mark', 'aria-hidden': 'true' }),
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
            disabled: !playback || !canPick,
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
            shared.ensurePlayback(chunk.createPlaybackCore);
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

    function ArrowRight({ size }) {
      return h(
        'svg',
        { width: size || 13, height: size || 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 8h10M9 4l4 4-4 4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    function Cross({ size }) {
      return h(
        'svg',
        { width: size || 13, height: size || 13, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 3l8 8M11 3l-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      );
    }

    function Panel({ localeSvc, closePanel, requireAsync, shared }) {
      const t = useT(localeSvc);
      const lang = activeLanguage(localeSvc).startsWith('zh') ? 'zh' : 'en';
      const langRef = useRef(lang);
      langRef.current = lang;

      const [canvasNode, setCanvasNode] = useState(null);
      const [cfg, setCfg] = useState(null);
      const [attempt, setAttempt] = useState(0);
      const stageRef = useRef(null);
      const retryStage = useCallback(() => setAttempt((n) => n + 1), []);

      const [categoriesOpen, setCategoriesOpen] = useState(false);
      /**
       * The nebula's open genre, or null for the volume field.
       *
       * View state, not station state: it says which genus the user opened, so
       * it lives here and dies with the panel. The stations inside it keep
       * their identity, their favourites and their playback because those are
       * owned one level up in `shared`.
       */
      const [nebulaGenreId, setNebulaGenreId] = useState(null);
      const [modeState, setModeState] = useState({
        state: 'black-hole',
        mode: 'black-hole',
        categoryId: null,
        progress: 0,
        transitioning: false,
      });

      const catsRef = useRef(null);
      const closeTimerRef = useRef(0);
      const catsOpenRef = useRef(false);
      const modeRef = useRef(modeState);
      const nebulaGenreRef = useRef(nebulaGenreId);
      catsOpenRef.current = categoriesOpen;
      modeRef.current = modeState;
      nebulaGenreRef.current = nebulaGenreId;

      /** Stable stage callbacks route through these closures. */
      const actionsRef = useRef({});

      const stageCallbacks = useMemo(
        () => ({
          onSelect(station) {
            // The stage names stations by record; the store owns the choice.
            if (store) store.select(station || null);
          },
          onMode(snapshot) {
            setModeState(snapshot);
            // The scene owns which space is on screen; an open genre that the
            // scene no longer shows is closed here rather than left to rot as
            // an orphan list over a volume field.
            if (snapshot.mode !== 'nebula' && !snapshot.transitioning) setNebulaGenreId(null);
            setCategoriesOpen(false);
          },
          /**
           * The hole's centre is the way in: it enters the genre field — the
           * thirteen-genre nebula — where each genre volume is one star
           * cluster. The nebula is a navigation level, not a second app.
           */
          onCenterClick() {
            if (actionsRef.current.enterNebula) actionsRef.current.enterNebula();
          },
          onHoverChange(active) {
            if (active) {
              if (actionsRef.current.openCategories) actionsRef.current.openCategories();
            } else if (actionsRef.current.scheduleClose) {
              actionsRef.current.scheduleClose();
            }
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
            // Phase-3 development preview: `?bhrlNebula=1` mounts the stage
            // straight into the nebula space. Absent means the normal hole.
            const nebulaParam = new URLSearchParams(window.location.search).get('bhrlNebula');
            if (nebulaParam !== null) body.nebulaPreview = nebulaParam !== '0';
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
            shared.ensurePlayback(chunk.createPlaybackCore);
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

      /** Real membership counts — a station can carry several categories. */
      const categoryCounts = useMemo(() => {
        const map = new Map();
        if (!repository) return map;
        for (const station of repository.list()) {
          for (const id of station.categories || []) map.set(id, (map.get(id) || 0) + 1);
        }
        return map;
      }, [repository]);

      const stageSettings = useMemo(() => {
        if (!cfg || !repository) return null;
        return {
          antialias: cfg.antialias !== false,
          pixelRatioCap: typeof cfg.pixelRatioCap === 'number' ? cfg.pixelRatioCap : 2,
          reducedMotion: Boolean(cfg.reducedMotion),
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
          nebulaPreview: cfg.nebulaPreview === true,
          onSelect: stageCallbacks.onSelect,
          onMode: stageCallbacks.onMode,
          onCenterClick: stageCallbacks.onCenterClick,
          onHoverChange: stageCallbacks.onHoverChange,
        };
      }, [cfg, repository, anchors, stageCallbacks]);

      const stage = useStage(requireAsync, canvasNode, stageSettings, stageRef, attempt);
      const stageReady = stage.status === 'ready';

      // ---- category panel -------------------------------------------------

      const openCategories = useCallback(() => {
        if (!stageReady) return;
        if (closeTimerRef.current) {
          clearTimeout(closeTimerRef.current);
          closeTimerRef.current = 0;
        }
        setCategoriesOpen(true);
        const handle = stageRef.current;
        if (handle && typeof handle.setInteraction === 'function') handle.setInteraction('category-panel');
      }, [stageReady]);

      const closeCategories = useCallback(() => {
        if (closeTimerRef.current) {
          clearTimeout(closeTimerRef.current);
          closeTimerRef.current = 0;
        }
        setCategoriesOpen(false);
        const handle = stageRef.current;
        if (handle && typeof handle.setInteraction === 'function') handle.setInteraction('black-hole');
      }, []);

      const scheduleClose = useCallback(() => {
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        closeTimerRef.current = setTimeout(() => {
          closeTimerRef.current = 0;
          setCategoriesOpen(false);
          const handle = stageRef.current;
          if (handle && typeof handle.setInteraction === 'function') handle.setInteraction('black-hole');
        }, HOVER_CLOSE_MS);
      }, []);

      const cancelClose = useCallback(() => {
        if (closeTimerRef.current) {
          clearTimeout(closeTimerRef.current);
          closeTimerRef.current = 0;
        }
      }, []);

      useEffect(
        () => () => {
          if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        },
        [],
      );

      // While the panel is up the pointer may travel from the hole to the panel
      // (and back) without ever dismissing it. The canvas cannot see that
      // journey — the panel sits on top of it — so the travel is tracked here:
      // inside hole or panel keeps it, anywhere else starts the close delay.
      useEffect(() => {
        if (!categoriesOpen) return undefined;
        const onMove = (event) => {
          const node = catsRef.current;
          const box = node ? node.getBoundingClientRect() : null;
          const insidePanel =
            box &&
            event.clientX >= box.left &&
            event.clientX <= box.right &&
            event.clientY >= box.top &&
            event.clientY <= box.bottom;
          const handle = stageRef.current;
          const hole = handle && typeof handle.holeScreen === 'function' ? handle.holeScreen() : null;
          const radius = hole ? hole.region || hole.r : 0;
          const insideHole = hole ? Math.hypot(event.clientX - hole.x, event.clientY - hole.y) <= radius : false;
          if (insidePanel || insideHole) cancelClose();
          else scheduleClose();
        };
        document.addEventListener('pointermove', onMove, { capture: true });
        return () => document.removeEventListener('pointermove', onMove, { capture: true });
      }, [categoriesOpen, cancelClose, scheduleClose]);

      // ---- mode transitions ----------------------------------------------

      /** Selection lives in the store; these three keep the old call shape. */
      const selectNone = useCallback(() => {
        if (store) store.select(null);
      }, [store]);

      /**
       * Every space change goes through the store-owned selection rather than
       * the scene's private index, so switching views never resurrects an old
       * pick and never invents a new one. Playback is untouched by design: it
       * is not a property of the view that happens to be mounted.
       */
      const enterNebulaView = useCallback(() => {
        closeCategories();
        selectNone();
        setNebulaGenreId(null);
        const handle = stageRef.current;
        if (handle && typeof handle.enterNebula === 'function') handle.enterNebula();
      }, [closeCategories, selectNone]);

      const exitNebulaView = useCallback(() => {
        closeCategories();
        selectNone();
        setNebulaGenreId(null);
        const handle = stageRef.current;
        if (handle && typeof handle.exitNebula === 'function') handle.exitNebula();
        else if (handle && typeof handle.backToHole === 'function') handle.backToHole();
      }, [closeCategories, selectNone]);

      /**
       * Fold the volume field away, or reopen it. Closing a genre is not a
       * scene change: the nebula stays, only its station list leaves.
       */
      const closeNebulaGenre = useCallback(() => {
        setNebulaGenreId(null);
        const handle = stageRef.current;
        if (handle && typeof handle.setGenre === 'function') handle.setGenre(null);
      }, []);

      /**
       * Open one volume. The station list is a view of the catalogue, so this
       * may be called before the scene is ready; the scene is told afterwards
       * and its highlight is a hint, not the source of truth.
       */
      const openNebulaGenre = useCallback((id) => {
        const next = id ? String(id) : null;
        setNebulaGenreId(next);
        const handle = stageRef.current;
        if (handle && typeof handle.setGenre === 'function') handle.setGenre(next);
      }, []);

      const enterCategory = useCallback(
        (id) => {
          closeCategories();
          setNebulaGenreId(null);
          selectNone();
          const handle = stageRef.current;
          if (handle && typeof handle.enterCluster === 'function') handle.enterCluster(id);
        },
        [closeCategories, selectNone],
      );

      const backToHole = useCallback(() => {
        closeCategories();
        setNebulaGenreId(null);
        selectNone();
        const handle = stageRef.current;
        if (!handle) return;
        if (typeof handle.clearSelection === 'function') handle.clearSelection(false);
        if (typeof handle.exitCluster === 'function') handle.exitCluster();
      }, [closeCategories, selectNone]);

      // ---- station selection ---------------------------------------------

      const chooseStation = useCallback((station) => {
        if (!station) return;
        if (store) store.select(station);
        setCategoriesOpen(false);
        const handle = stageRef.current;
        if (!handle) return;
        if (typeof handle.setInteraction === 'function') handle.setInteraction('black-hole');
        // locateStation is the cross-mode path: it enters the scene that owns
        // the station first, then focuses it. selectById would only work when
        // the station already sits in the active scene.
        if (typeof handle.locateStation === 'function') handle.locateStation(station.id);
        else if (typeof handle.selectById === 'function') handle.selectById(station.id, { focus: true, notify: false });
      }, [store]);

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

      const categoryName = useCallback(
        (id) => {
          const category = categories.find((item) => item.id === id);
          if (!category) return id;
          return lang === 'en' ? category.en : category.zh;
        },
        [categories, lang],
      );

      const categoryColor = useCallback(
        (id) => {
          const category = categories.find((item) => item.id === id);
          if (!category) return '#9fb0cc';
          return `#${Number(category.color).toString(16).padStart(6, '0')}`;
        },
        [categories],
      );

      /**
       * Which source is on screen, in words. Live stations and simulated ones
       * must never look alike in the chrome.
       */
      const dataBadge = radio.fallback ? t('fallbackBadge') : radio.repository && radio.repository.kind === 'radio-browser' ? t('liveBadge') : t('demoBadge');

      const inCluster = modeState.mode === 'cluster' || modeState.state === 'transition-to-cluster';
      const clusterCategory = modeState.categoryId || null;
      const clusterCount = clusterCategory ? categoryCounts.get(clusterCategory) || 0 : 0;

      // Esc closes the category panel; a second Esc leaves the cluster.
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          if (catsOpenRef.current) {
            event.preventDefault();
            event.stopPropagation();
            if (actionsRef.current.closeCategories) actionsRef.current.closeCategories();
            return;
          }
          const snapshot = modeRef.current;
          if (snapshot.state === 'cluster' || snapshot.transitioning) {
            event.preventDefault();
            event.stopPropagation();
            if (actionsRef.current.backToHole) actionsRef.current.backToHole();
          }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, []);

      actionsRef.current = { enterNebula: enterNebulaView, openCategories, closeCategories, scheduleClose, cancelClose, backToHole };

      // ---- nebula station surfaces ---------------------------------------

      /**
       * The genre definitions the scene received. `radio.genres` is the
       * repository's own summary, so the chrome names and colours exactly what
       * the nebulae are drawn from — no second table, no second classifier.
       */
      const nebulaGenres = useMemo(() => {
        // Read the sample's own display groups straight from the repository.
        // `useRadio` only carries the status records, so there is no `genres`
        // field on it to read — asking it for one left the rail permanently
        // empty ("0 个流派") while thirteen volumes existed in the scene.
        if (!repository || typeof repository.visibleGenres !== 'function') return [];
        const visible = repository.visibleGenres();
        return (Array.isArray(visible) ? visible : []).filter((genre) => genre && genre.count > 0);
      }, [repository]);

      const nebulaGenresRef = useRef(nebulaGenres);
      nebulaGenresRef.current = nebulaGenres;

      const genreLabelOf = useCallback(
        (id) => {
          if (shared && shared.env) return shared.env.genreLabel(id, lang);
          const genre = nebulaGenresRef.current.find((item) => item.id === String(id));
          return genre ? (lang === 'en' ? genre.en : genre.zh) : String(id);
        },
        [shared, lang],
      );

      const genreCssOf = useCallback(
        (id) => {
          if (shared && shared.env) return shared.env.genreCss(id);
          const genre = nebulaGenresRef.current.find((item) => item.id === String(id));
          return genre ? `#${Number(genre.color).toString(16).padStart(6, '0')}` : '#9a9a9a';
        },
        [shared],
      );

      /**
       * Stations per volume, resolved through the repository so a genre folded
       * into Other is counted and listed inside Other — the same rule
       * `repository.listByGenre(id)` applies by default.
       */
      const genreStationCounts = useMemo(() => {
        const map = new Map();
        if (!repository) return map;
        for (const station of repository.list()) {
          const raw = (station && station.genre) || 'other';
          const id = nebulaGenres.some((genre) => genre.id === raw) ? raw : nebulaGenres.some((genre) => genre.id === 'other') ? 'other' : null;
          if (!id) continue;
          map.set(id, (map.get(id) || 0) + 1);
        }
        return map;
      }, [repository, nebulaGenres]);

      /**
       * The rows of the open volume.
       *
       * Read from the repository on every render rather than cached: the same
       * station objects come back, so the store keeps matching them by key and
       * a favourite set elsewhere is visible here on the next frame.
       */
      const nebulaStations = useMemo(() => {
        if (!repository || !nebulaGenreId) return [];
        try {
          const list = repository.listByGenre(nebulaGenreId);
          return Array.isArray(list) ? list : [];
        } catch {
          return [];
        }
      }, [repository, nebulaGenreId]);

      const showHint = stageReady && !selected;

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
          { className: 'bhrl-stage', 'aria-label': t('stageLabel') },
          h('div', { className: 'bhrl-stage__canvas', ref: setCanvasNode, 'data-bhrl-canvas': true }),

          stage.status === 'loading'
            ? h(
                'div',
                { className: 'bhrl-boot' },
                h('span', { className: 'bhrl-boot__disc', 'aria-hidden': 'true' }),
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

          h(
            'div',
            { className: 'bhrl-overlay' },
            h(
              'div',
              { className: 'bhrl-brand', 'data-hidden': inCluster ? 'true' : 'false' },
              h('span', { className: 'bhrl-brand__name' }, t('wordmark')),
              h('span', { className: 'bhrl-brand__tag' }, t('phaseTag')),
              h('span', { className: 'bhrl-brand__demo' }, dataBadge),
            ),

            // Keyboard focus stop over the hole. Pointer hits go to the canvas.
            h('button', {
              type: 'button',
              className: 'bhrl-core',
              'aria-label': t('enterGenres'),
              title: t('enterGenres'),
              onClick: enterNebulaView,
              'data-hidden': inCluster ? 'true' : 'false',
            }),

            h(
              'button',
              { type: 'button', className: 'bhrl-quit', onClick: closePanel, title: t('close'), 'aria-label': t('close') },
              h(Cross, { size: 14 }),
            ),

            /**
             * The way into the nebula space, and the way back out of it.
             *
             * Two views of one catalogue: the hole is where stations are
             * placed by category, the nebula is where they are placed by genre.
             * Switching between them is a scene change, so it never touches
             * the store or the transport — whatever is playing keeps playing.
             */
            h(
              'div',
              { className: 'bhrl-viewswitch', 'data-hidden': inCluster ? 'true' : 'false' },
              modeState.mode === 'nebula'
                ? h(
                    'button',
                    { type: 'button', className: 'bhrl-backbtn', onClick: exitNebulaView, title: t('viewHole') },
                    h(ArrowLeft, { size: 13 }),
                    h('span', null, t('viewHole')),
                  )
                : h(
                    'button',
                    { type: 'button', className: 'bhrl-backbtn', onClick: enterNebulaView, title: t('viewNebula') },
                    h('span', null, t('viewNebula')),
                    h(ArrowRight, { size: 13 }),
                  ),
            ),

            h(
              'div',
              { className: 'bhrl-clusterbar', 'data-open': inCluster ? 'true' : 'false' },
              h(
                'button',
                { type: 'button', className: 'bhrl-backbtn', onClick: backToHole, title: t('clusterBack') },
                h(ArrowLeft, { size: 13 }),
                h('span', null, t('clusterBack')),
              ),
              h(
                'div',
                { className: 'bhrl-clusterbar__title' },
                h('strong', null, clusterCategory ? categoryName(clusterCategory) : t('categories')),
                h('span', null, `${clusterCount} ${t('clusterStations')}`),
              ),
            ),

            showHint ? h('p', { className: 'bhrl-hint' }, inCluster ? t('hintCluster') : t('hintBlackHole')) : null,
          ),

          /**
           * The nebula's two surfaces: the volume field and, under it, the
           * station list of whichever volume is open.
           *
           * `modeState.mode === 'nebula'` is the scene's own answer to "where
           * am I", so the chrome follows the scene rather than a second local
           * idea of it. Opening a genre writes `nebulaGenreId` and asks the
           * scene to highlight it; closing it writes null and asks the scene to
           * highlight nothing. Neither touches the store or the transport.
           */
          h(
            'div',
            { className: 'bhrl-nebulabar', 'data-open': modeState.mode === 'nebula' ? 'true' : 'false' },
            h(
              'button',
              { type: 'button', className: 'bhrl-backbtn', onClick: exitNebulaView, title: t('nebulaBack') },
              h(ArrowLeft, { size: 13 }),
              h('span', null, t('nebulaBack')),
            ),
            h(
              'div',
              { className: 'bhrl-clusterbar__title' },
              h('strong', null, t('nebulaTitle')),
              h('span', null, `${nebulaGenres.length} ${t('nebulaGenres')}`),
            ),
          ),

          modeState.mode === 'nebula'
            ? h(
                'div',
                { className: 'bhrl-nebulacats', 'aria-label': t('nebulaGenres') },
                nebulaGenres.map((genre) => {
                  const count = genreStationCounts.get(genre.id) || 0;
                  return h(
                    'button',
                    {
                      type: 'button',
                      key: genre.id,
                      className: 'bhrl-cat bhrl-genrecat',
                      'data-open': nebulaGenreId === genre.id ? 'true' : 'false',
                      disabled: count === 0,
                      onClick: () => (nebulaGenreId === genre.id ? closeNebulaGenre() : openNebulaGenre(genre.id)),
                    },
                    h(CategoryDot, { color: genreCssOf(genre.id) }),
                    h('span', { className: 'bhrl-cat__name' }, genreLabelOf(genre.id)),
                    h('span', { className: 'bhrl-cat__n' }, String(count)),
                  );
                }),
              )
            : null,

          modeState.mode === 'nebula'
            ? h(NebulaStationList, {
                genreId: nebulaGenreId,
                stations: nebulaStations,
                genreLabelOf,
                genreColorOf: genreCssOf,
                selectedKey,
                shared,
                t,
                onClose: closeNebulaGenre,
                onFocus: (station) => locatePlaying(station && station.id),
              })
            : null,

          h(
            'div',
            {
              className: 'bhrl-cats',
              ref: catsRef,
              'data-open': categoriesOpen ? 'true' : 'false',
              role: 'menu',
              'aria-label': t('categories'),
              onPointerEnter: cancelClose,
              onPointerLeave: scheduleClose,
              onPointerDown: (event) => event.stopPropagation(),
            },
            h(
              'div',
              { className: 'bhrl-cats__head' },
              h('span', { className: 'bhrl-cats__title' }, t('categories')),
              h('span', { className: 'bhrl-cats__hint' }, t('categoriesHint')),
            ),
            categories.map((category) =>
              h(
                'button',
                {
                  type: 'button',
                  key: category.id,
                  className: 'bhrl-cat',
                  role: 'menuitem',
                  onClick: () => enterCategory(category.id),
                },
                h(CategoryDot, { color: categoryColor(category.id) }),
                h('span', { className: 'bhrl-cat__name' }, lang === 'en' ? category.en : category.zh),
                h('span', { className: 'bhrl-cat__n' }, String(categoryCounts.get(category.id) || 0)),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * The corner mark: the ring badge, inlined as a data URL.
     *
     * The source is a white brush drawing on a black square. The copy below has
     * its background lifted into the alpha channel, so it is a monochrome mask
     * rather than a picture: the card paints it with `currentColor` and it reads
     * on a light theme and a dark one without a second file or a filter. Inlined
     * because the client half is served as one file with no asset route, and
     * because a 10 KB string in the bundle is cheaper than a second request
     * that a sidebar cell would have to wait for.
     */
    const HOLE_MARK_URL = 'data:image/webp;base64,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';

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
.bhrl-overlay { position: absolute; inset: 0; z-index: 6; pointer-events: none; }

.bhrl-brand { position: absolute; left: 20px; top: 16px; display: flex; align-items: baseline; gap: 9px; transition: opacity 260ms ease; }
.bhrl-brand[data-hidden="true"] { opacity: 0; }
.bhrl-brand__name { font-size: 10px; font-weight: 600; letter-spacing: 0.26em; text-transform: uppercase; color: rgba(236, 240, 250, 0.78); }
.bhrl-brand__tag, .bhrl-brand__demo { font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(210, 220, 238, 0.36); }
.bhrl-brand__demo { color: rgba(255, 170, 120, 0.42); }

.bhrl-quit {
  position: absolute; right: 14px; top: 12px; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border-radius: 50%; border: 1px solid transparent;
  background: transparent; color: rgba(214, 224, 240, 0.5); cursor: pointer; pointer-events: auto;
  transition: color 140ms ease, border-color 140ms ease, background 140ms ease;
}
.bhrl-quit:hover { color: var(--bhrl-ink); border-color: var(--bhrl-line); background: rgba(255, 255, 255, 0.04); }
.bhrl-quit:focus-visible { outline: 1px solid rgba(255, 176, 120, 0.7); outline-offset: 2px; }

.bhrl-core {
  position: absolute; left: 50%; top: 50%; width: 120px; height: 120px; margin: -60px 0 0 -60px;
  padding: 0; border: 0; border-radius: 50%; background: transparent; color: transparent;
  pointer-events: none; opacity: 0; transition: opacity 160ms ease;
}
.bhrl-core[data-hidden="true"] { display: none; }
.bhrl-stage__canvas canvas:focus-visible { outline: 1px solid rgba(255, 190, 140, 0.55); outline-offset: -1px; }
.bhrl-core:focus-visible { opacity: 1; outline: none; box-shadow: inset 0 0 0 1px rgba(255, 190, 140, 0.55), 0 0 40px rgba(255, 140, 60, 0.18); }

.bhrl-hint {
  position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); margin: 0; padding: 0 14px;
  max-width: 88%; font-size: 10.5px; letter-spacing: 0.06em; color: rgba(206, 218, 238, 0.34);
  text-align: center; pointer-events: none; animation: bhrl-fade-in 700ms ease both;
}

.bhrl-clusterbar {
  position: absolute; left: 16px; top: 12px; display: flex; align-items: center; gap: 12px;
  padding: 6px 8px 6px 4px; border-radius: 10px; opacity: 0; transform: translateY(-4px);
  pointer-events: none; visibility: hidden; transition: opacity 240ms ease, transform 240ms ease;
}
.bhrl-clusterbar[data-open="true"] { opacity: 1; transform: none; pointer-events: auto; visibility: visible; }
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

.bhrl-cats {
  position: absolute; left: calc(50% + 104px); top: 50%; z-index: 8; width: 190px; padding: 9px;
  border-radius: 12px; border: 1px solid var(--bhrl-line-soft); background: rgba(6, 8, 14, 0.72);
  backdrop-filter: blur(10px); box-shadow: 0 16px 44px rgba(0, 0, 0, 0.5);
  opacity: 0; transform: translateY(-50%) translateX(-7px); pointer-events: none; visibility: hidden;
  transition: opacity 240ms ease, transform 240ms ease;
}
.bhrl-cats[data-open="true"] { opacity: 1; transform: translateY(-50%) translateX(0); pointer-events: auto; visibility: visible; }
.bhrl-cats__head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 1px 4px 6px; }
.bhrl-cats__title { font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(232, 238, 250, 0.6); }
.bhrl-cats__hint { font-size: 8.5px; letter-spacing: 0.04em; color: rgba(206, 218, 238, 0.3); }
.bhrl-cat {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px; border: 0; border-radius: 7px;
  background: transparent; color: inherit; font: inherit; font-size: 11.5px; text-align: left; cursor: pointer;
  transition: background 120ms ease;
}
.bhrl-cat:hover, .bhrl-cat:focus-visible { background: rgba(255, 255, 255, 0.055); outline: none; }
.bhrl-cat__name { color: rgba(232, 238, 250, 0.82); }
.bhrl-cat__n { margin-left: auto; font-size: 9.5px; font-variant-numeric: tabular-nums; color: rgba(206, 218, 238, 0.36); }
.bhrl-catdot { display: inline-block; width: 5px; height: 5px; border-radius: 50%; flex: 0 0 auto; }

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
.bhrl-boot__disc { width: 12px; height: 12px; border-radius: 50%; border: 1px solid rgba(255, 160, 100, 0.5); border-top-color: transparent; animation: bhrl-spin 900ms linear infinite; }
.bhrl-fail {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(320px, 80%);
  padding: 14px; border-radius: 10px; border: 1px solid rgba(255, 140, 90, 0.35); background: rgba(8, 9, 14, 0.9);
  text-align: center; font-size: 11px; color: var(--bhrl-ink-dim);
}
.bhrl-fail p { margin: 0 0 10px; overflow-wrap: anywhere; }

@keyframes bhrl-spin { to { transform: rotate(360deg); } }
@keyframes bhrl-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes bhrl-rise-in { from { opacity: 0; transform: translate(-50%, -48%); } to { opacity: 1; transform: translate(-50%, -50%); } }

@media (max-width: 900px) {
  .bhrl-cats { left: 50%; top: calc(50% + 128px); transform: translate(-50%, 0); width: min(320px, 74%); }
  .bhrl-cats[data-open="true"] { transform: translate(-50%, 0); }
}
@media (max-width: 560px) {
  .bhrl-brand__tag, .bhrl-brand__demo { display: none; }
  .bhrl-clusterbar { left: 10px; top: 10px; gap: 8px; }
}
@media (prefers-reduced-motion: reduce) {
  .bhrl-boot__disc { animation: none; }
  .bhrl-cats, .bhrl-clusterbar { transition-duration: 0ms; animation: none; }
  .bhrl-eq, .bhrl-eq.is-on { animation: none; }
  .bhrl-fcard [data-overflow="true"] .bhrl-fcard__scroll { animation: none; }
  .bhrl-favpop { animation: none; }
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

/* Row: the nebula's station list. */
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

/* ---- nebula space: view switch, genre field, station list ------------- */

.bhrl-viewswitch {
  position: absolute; right: 52px; top: 12px; display: flex; align-items: center; gap: 6px;
  pointer-events: auto; transition: opacity 220ms ease;
}
.bhrl-viewswitch[data-hidden="true"] { opacity: 0; pointer-events: none; }

.bhrl-nebulabar {
  position: absolute; left: 16px; top: 12px; z-index: 7; display: flex; align-items: center; gap: 12px;
  padding: 6px 8px 6px 4px; border-radius: 10px; opacity: 0; visibility: hidden;
  transform: translateY(-4px); pointer-events: none;
  transition: opacity 240ms ease, transform 240ms ease;
}
.bhrl-nebulabar[data-open="true"] { opacity: 1; visibility: visible; transform: none; pointer-events: auto; }

/*
 * The genre field. A single scrollable rail rather than thirteen floating
 * chips: the volumes are a set, and a set reads better in one line than
 * scattered around the canvas. It never overlaps the station list, which
 * starts under it.
 */
.bhrl-nebulacats {
  position: absolute; left: 16px; right: 16px; top: 52px; z-index: 7;
  display: flex; align-items: center; gap: 4px; padding: 4px;
  max-width: 100%; overflow-x: auto; overflow-y: hidden;
  border-radius: 10px; border: 1px solid var(--bhrl-line-soft);
  background: rgba(6, 9, 16, 0.62); backdrop-filter: blur(8px);
  pointer-events: auto; scrollbar-width: thin;
}
.bhrl-genrecat {
  width: auto; flex: 0 0 auto; padding: 5px 9px; border-radius: 999px; gap: 7px;
  border: 1px solid transparent; white-space: nowrap;
}
.bhrl-genrecat[data-open="true"] {
  background: rgba(255, 255, 255, 0.09); border-color: var(--bhrl-line);
}
.bhrl-genrecat[disabled] { opacity: 0.36; cursor: default; }
.bhrl-genrecat[disabled]:hover { background: transparent; }
.bhrl-genrecat .bhrl-cat__n { margin-left: 0; }

/*
 * The station list of one volume. It sits over the canvas, so every row is a
 * StationCard in its row variant: the same play/pause and favourite controls
 * the hole's information layer and the search results carry. The heart is not
 * among them — a row is a station, not a song, so the mark that belongs to a
 * song lives on the foot card where the song does.
 */
.bhrl-nebula-list {
  position: absolute; left: 16px; top: 100px; bottom: 76px; z-index: 7;
  width: min(340px, calc(100% - 32px)); display: flex; flex-direction: column;
  padding: 10px 11px; border-radius: 12px;
  border: 1px solid var(--bhrl-line-soft); background: rgba(5, 8, 14, 0.78);
  backdrop-filter: blur(12px); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
  pointer-events: auto; overflow: hidden;
}
.bhrl-nebula-list__head { display: flex; align-items: center; gap: 8px; padding: 0 2px 8px; }
.bhrl-nebula-list__head strong { font-size: 12px; font-weight: 550; letter-spacing: 0.04em; }
.bhrl-nebula-list__n { font-size: 9.5px; letter-spacing: 0.08em; color: var(--bhrl-ink-faint); }
.bhrl-nebula-list__head .bhrl-act-close { margin-left: auto; }
.bhrl-nebula-rows { list-style: none; margin: 0; padding: 0; overflow-y: auto; scrollbar-width: thin; }
.bhrl-nebula-list__empty { margin: 6px 2px; font-size: 11px; color: var(--bhrl-ink-faint); }
.bhrl-nebula-group { display: flex; flex-direction: column; gap: 1px; padding-top: 4px; }
.bhrl-nebula-group + .bhrl-nebula-group { margin-top: 2px; border-top: 1px solid var(--bhrl-line-soft); }
.bhrl-nebula-group__head { display: flex; align-items: baseline; gap: 6px; padding: 2px 4px 3px; }
.bhrl-nebula-group__name {
  font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: rgba(214, 224, 240, 0.48);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bhrl-nebula-group__n { font-size: 9px; color: rgba(214, 224, 240, 0.3); font-variant-numeric: tabular-nums; }

@media (max-width: 720px) {
  .bhrl-nebula-list { left: 10px; right: 10px; width: auto; top: 96px; bottom: 70px; }
  .bhrl-nebulacats { left: 10px; right: 10px; }
  .bhrl-viewswitch { right: 46px; }
}

/* ------------------------------------------------------------------ *
 *  The station card in the sidebar foot.
 *
 *  This block is deliberately NOT scoped to \`.bhrl-root\`: the card does not
 *  live inside the panel, it lives in the host's sidebar cell, which is a
 *  separate subtree. It therefore declares its own tokens and its own copy
 *  of the surface/act rules the panel uses, at the same visual weight.
 * ------------------------------------------------------------------ */
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
.bhrl-foot.is-wide { padding: 8px 10px 9px; }
.bhrl-foot.is-rail { display: flex; align-items: center; justify-content: center; padding: 2px 0; }

/* ---- the station card ----------------------------------------------- *
 * Two rows, nothing else: what the selected station is (name, the label line
 * it is airing) and the transport. Anything more pushes the session list up,
 * so the card is exactly as tall as its own controls.
 *
 * The surface is glass, not a painted panel: the app's own menu tint plus a
 * backdrop blur, with an SVG displacement pass that bends the sidebar behind
 * the rim. The tint is drawn by ::before so the box itself never becomes the
 * containing block for a filtered descendant.
 */
.bhrl-fcard {
  position: relative;
  isolation: isolate;
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
  border-radius: 12px;
  background: transparent;
}
.bhrl-fcard::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
  /* Glass, and only glass: the same fill and the same backdrop blur every DSH
   * menu uses. No border, no shadow, no highlight, no refraction — the surface
   * is a sheet of frosted material and nothing is drawn on top of it. */
  background-color: var(--dsw-specific-menu, color-mix(in srgb, currentColor 58%, transparent));
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
}
.bhrl-fcard__text { grid-area: text; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 1px; }
.bhrl-fcard__row { display: flex; align-items: center; gap: 5px; min-width: 0; }
.bhrl-fcard__row--sub { margin-top: 1px; }

/* The corner: the only door to the hole, and now the mark is the button.
 * No ring, no fill, no plate: the badge is the whole of what is drawn, and it
 * is a mask, so it takes the card's ink and inverts with the theme. */
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
  /* The badge, background lifted into alpha: 1080x620 of brush ring. */
  --bhrl-mark: url('${HOLE_MARK_URL}');
  display: block; width: 100%; height: 100%;
  background-color: currentColor;
  -webkit-mask-image: var(--bhrl-mark); mask-image: var(--bhrl-mark);
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
  -webkit-mask-position: center; mask-position: center;
  -webkit-mask-size: contain; mask-size: contain;
}

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
.bhrl-favpop__item {
  display: flex; flex-direction: column; gap: 1px;
  padding: 3px 4px; border-radius: 6px;
}
.bhrl-favpop__item:hover { background: color-mix(in oklab, var(--bhrl-ink) 8%, transparent); }
.bhrl-favpop__name {
  font-size: 11px; line-height: 1.3;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bhrl-favpop__meta {
  font-size: 10px; line-height: 1.25; color: var(--bhrl-ink-faint);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
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

/* The two marks that belong to a line, not to the transport: they sit inline
 * with the name and the track, quiet until they are on. */
.bhrl-fcard__row .bhrl-act,
.bhrl-fcard__row .bhrl-act:hover:not(:disabled) {
  width: 16px; height: 16px; border-color: transparent; background: transparent;
}
.bhrl-fcard__row .bhrl-act:hover:not(:disabled) { border-color: var(--bhrl-line-soft); }
/* The sub row's mark is a size smaller than the name row's, and it keeps that
 * size under the pointer: the pair below has to repeat the hover clause the
 * row rule above carries, or the resting 14px would lose to it on hover and
 * grow the button by 2px — which re-centres the whole text block and nudges
 * the name, the star and the heart sideways for as long as the pointer is
 * there. */
.bhrl-fcard__row--sub .bhrl-act,
.bhrl-fcard__row--sub .bhrl-act:hover:not(:disabled) { width: 14px; height: 14px; }

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

        const closePanel = () => {
          try {
            if (layoutSvc && typeof layoutSvc.selectPanel === 'function') layoutSvc.selectPanel('conversation');
          } catch {
            /* no conversation entry in this composition — leave the panel up */
          }
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

        claim({ name: 'main', key: PANEL_ID }, () => h(Panel, { localeSvc, closePanel, requireAsync: require.async, shared }));

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
