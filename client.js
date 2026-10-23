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
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React;

    const PANEL_ID = 'blackhole-radio-lab';
    const NS = 'blackhole-radio-lab';
    const STYLE_ID = 'bhrl-styles';
    const CONFIG_URL = '/blackhole-radio-lab/config';
    const STAGE_CHUNK = './client.stage.js';
    const RADIO_CHUNK = './client.radio.js';

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
        searchLabel: '搜索',
        searchPlaceholder: '搜索电台、国家、语言或分类',
        searchClear: '清除',
        searchHint: '回车定位 · Esc 关闭',
        noResults: '没有匹配的模拟电台',
        categories: '分类',
        categoriesHint: '停留显示 · 选择进入',
        clusterBack: '黑洞',
        clusterSearch: '搜索电台',
        clusterStations: '个电台',
        detailTitle: '电台详情',
        country: '国家/地区',
        language: '语言',
        category: '分类',
        description: '简介',
        stationId: 'ID',
        focusStation: '聚焦',
        cancelSelection: '取消选择',
        closeDetail: '关闭详情',
        featuredNote: '精选电台 · 内环亮带中的稳定结构',
        demoNote: '模拟电台，仅用于界面演示；实时源不可用时替代显示，不含播放能力。',
        liveNote: '真实电台数据，来自 Radio Browser；本阶段尚未接入音频播放。',
        hintBlackHole: '点击中心搜索 · 停留显示分类 · 拖动环绕 · 滚轮缩放',
        hintCluster: '拖动环绕星团 · 滚轮缩放 · 点击星点查看',
        dataError: '模拟数据加载失败',
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
        searchLabel: 'Search',
        searchPlaceholder: 'Search stations, countries, languages or categories',
        searchClear: 'Clear',
        searchHint: 'Enter to locate · Esc to close',
        noResults: 'No matching mock stations',
        categories: 'Categories',
        categoriesHint: 'Dwell to reveal · pick to enter',
        clusterBack: 'Black hole',
        clusterSearch: 'Search stations',
        clusterStations: 'stations',
        detailTitle: 'Station detail',
        country: 'Country / region',
        language: 'Language',
        category: 'Categories',
        description: 'About',
        stationId: 'ID',
        focusStation: 'Focus',
        cancelSelection: 'Clear selection',
        closeDetail: 'Close detail',
        featuredNote: 'Featured · a steadier structure in the inner rim',
        liveNote: 'Real station from Radio Browser. This phase does not play audio yet.',
        demoNote: 'Simulated stations for this interface only. Shown when the live source is offline; nothing plays.',
        hintBlackHole: 'Click the centre to search · dwell for categories · drag to orbit · scroll to zoom',
        hintCluster: 'Drag to orbit the cluster · scroll to zoom · click a star',
        dataError: 'mock data failed to load',
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
     */
    function useRadio(requireAsync, cfg) {
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
        Promise.resolve()
          .then(() => requireAsync(RADIO_CHUNK))
          .then(async (radio) => {
            if (disposed) return;
            let repository = null;
            let fallback = null;
            try {
              const outcome = await radio.createRadioRepository({
                count: cfg.stationCount,
                seed: cfg.seed,
                featuredCount: cfg.featuredCount,
                mode: cfg.sourceMode || 'auto',
                budgetMs: cfg.sourceBudgetMs,
              });
              repository = outcome && outcome.repository ? outcome.repository : null;
              fallback = outcome ? outcome.fallback : null;
            } catch (error) {
              // The chunk already guarantees a mock fallback; this only catches
              // a failure below it (e.g. the mock generator itself).
              repository = radio.createMockRadioRepository({
                count: cfg.stationCount,
                seed: cfg.seed,
                featuredCount: cfg.featuredCount,
              });
              fallback = { reason: 'error', detail: String(error), attempts: [] };
            }
            if (disposed) return;
            if (fallback) {
              // Say it out loud: the rail must not present mock stations as live.
              reportData(fallback);
            }
            setState({
              status: 'ready',
              repository,
              categories: repository.categories(),
              anchors: repository.anchors(),
              error: null,
              fallback,
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
      }, [requireAsync, cfg]);

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

    function PanelIcon(props) {
      const size = Number((props && props.size) || 16);
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('ellipse', { cx: 12, cy: 12, rx: 10.2, ry: 3, stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.55 }),
        h('circle', { cx: 12, cy: 12, r: 4.4, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M12 7.6a4.4 4.4 0 0 1 0 8.8', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', opacity: 0.9 }),
        h('circle', { cx: 12, cy: 12, r: 1.3, fill: 'currentColor' }),
      );
    }

    function CategoryDot({ color }) {
      return h('i', { className: 'bhrl-catdot', style: { background: color }, 'aria-hidden': 'true' });
    }

    function Magnifier({ size }) {
      return h(
        'svg',
        { width: size || 13, height: size || 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 7, cy: 7, r: 4.6, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M10.5 10.5L14 14', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      );
    }

    function ArrowLeft({ size }) {
      return h(
        'svg',
        { width: size || 13, height: size || 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M13 8H3M7 4L3 8l4 4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    function Cross({ size }) {
      return h(
        'svg',
        { width: size || 13, height: size || 13, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 3l8 8M11 3l-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      );
    }

    function Panel({ localeSvc, closePanel, requireAsync }) {
      const t = useT(localeSvc);
      const lang = activeLanguage(localeSvc).startsWith('zh') ? 'zh' : 'en';
      const langRef = useRef(lang);
      langRef.current = lang;

      const [canvasNode, setCanvasNode] = useState(null);
      const [cfg, setCfg] = useState(null);
      const [attempt, setAttempt] = useState(0);
      const stageRef = useRef(null);
      const retryStage = useCallback(() => setAttempt((n) => n + 1), []);

      const [searchOpen, setSearchOpen] = useState(false);
      const [query, setQuery] = useState('');
      const [categoriesOpen, setCategoriesOpen] = useState(false);
      const [selected, setSelected] = useState(null);
      const [modeState, setModeState] = useState({
        state: 'black-hole',
        mode: 'black-hole',
        categoryId: null,
        progress: 0,
        transitioning: false,
      });

      const searchInputRef = useRef(null);
      const catsRef = useRef(null);
      const closeTimerRef = useRef(0);
      const searchOpenRef = useRef(false);
      const catsOpenRef = useRef(false);
      const modeRef = useRef(modeState);
      const selectedRef = useRef(null);
      searchOpenRef.current = searchOpen;
      catsOpenRef.current = categoriesOpen;
      modeRef.current = modeState;
      selectedRef.current = selected;

      /** Stable stage callbacks route through these closures. */
      const actionsRef = useRef({});

      const stageCallbacks = useMemo(
        () => ({
          onSelect(station) {
            setSelected(station || null);
          },
          onMode(snapshot) {
            setModeState(snapshot);
            if (snapshot.state === 'cluster') {
              setSearchOpen(false);
              setQuery('');
              setCategoriesOpen(false);
            }
          },
          onCenterClick() {
            if (actionsRef.current.openSearch) actionsRef.current.openSearch();
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
          try {
            const res = await fetch(CONFIG_URL, { cache: 'no-store', signal: controller ? controller.signal : undefined });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            // Verification knob: `?bhrlStations=5000` overrides the count.
            const asked = Number(new URLSearchParams(window.location.search).get('bhrlStations'));
            if (Number.isInteger(asked) && asked >= 200 && asked <= 20000) body.stationCount = asked;
            // Phase-2 fixture switch: `?bhrlRadio=all`, a kind, a business id or
            // a gpu id. Absent means the page renders the phase-1 baseline.
            const radioParam = new URLSearchParams(window.location.search).get('bhrlRadio');
            if (radioParam !== null) body.radio = radioParam;
            if (alive) setCfg(body);
          } catch {
            if (alive) setCfg({ antialias: true, pixelRatioCap: 2, reducedMotion: false, stationCount: 2000, seed: 20261022, featuredCount: 18 });
          }
        })();
        return () => {
          alive = false;
          if (controller) controller.abort();
        };
      }, []);

      const radio = useRadio(requireAsync, cfg);
      const repository = radio.repository;
      const categories = radio.categories || [];
      const anchors = radio.anchors || [];

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
          language: langRef.current,
          // Phase-2 fixture switch, carried through from the URL. `null` in the
          // default case, so the stage never even creates the overlay.
          radio: cfg.radio === undefined ? null : cfg.radio,
          onSelect: stageCallbacks.onSelect,
          onMode: stageCallbacks.onMode,
          onCenterClick: stageCallbacks.onCenterClick,
          onHoverChange: stageCallbacks.onHoverChange,
        };
      }, [cfg, repository, anchors, stageCallbacks]);

      const stage = useStage(requireAsync, canvasNode, stageSettings, stageRef, attempt);
      const stageReady = stage.status === 'ready';

      // ---- search ---------------------------------------------------------

      const focusSearchInput = useCallback(() => {
        const input = searchInputRef.current;
        if (!input) return;
        try {
          input.focus({ preventScroll: true });
          const end = input.value.length;
          input.setSelectionRange(end, end);
        } catch {
          /* focus can fail if the panel was detached mid-frame */
        }
      }, []);

      useEffect(() => {
        if (!searchOpen) return undefined;
        const id = setTimeout(focusSearchInput, 0);
        return () => clearTimeout(id);
      }, [searchOpen, focusSearchInput]);

      const closeSearch = useCallback(() => {
        setSearchOpen(false);
        setQuery('');
        const handle = stageRef.current;
        if (handle && typeof handle.setInteraction === 'function') handle.setInteraction('black-hole');
      }, []);

      const openSearch = useCallback(() => {
        if (!stageReady) return;
        if (closeTimerRef.current) {
          clearTimeout(closeTimerRef.current);
          closeTimerRef.current = 0;
        }
        setCategoriesOpen(false);
        setSearchOpen(true);
        const handle = stageRef.current;
        if (handle && typeof handle.setInteraction === 'function') handle.setInteraction('search');
      }, [stageReady]);

      // ---- category panel -------------------------------------------------

      const openCategories = useCallback(() => {
        if (!stageReady || searchOpenRef.current) return;
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

      const enterCategory = useCallback(
        (id) => {
          closeCategories();
          setSearchOpen(false);
          setQuery('');
          setSelected(null);
          const handle = stageRef.current;
          if (handle && typeof handle.enterCluster === 'function') handle.enterCluster(id);
        },
        [closeCategories],
      );

      const backToHole = useCallback(() => {
        closeCategories();
        setSearchOpen(false);
        setQuery('');
        setSelected(null);
        const handle = stageRef.current;
        if (!handle) return;
        if (typeof handle.clearSelection === 'function') handle.clearSelection(false);
        if (typeof handle.exitCluster === 'function') handle.exitCluster();
      }, [closeCategories]);

      // ---- station selection ---------------------------------------------

      const chooseStation = useCallback((station) => {
        if (!station) return;
        setSelected(station);
        setQuery('');
        setSearchOpen(false);
        setCategoriesOpen(false);
        const handle = stageRef.current;
        if (!handle) return;
        if (typeof handle.setInteraction === 'function') handle.setInteraction('black-hole');
        // locateStation is the cross-mode path: it enters the scene that owns
        // the station first, then focuses it. selectById would only work when
        // the station already sits in the active scene.
        if (typeof handle.locateStation === 'function') handle.locateStation(station.id);
        else if (typeof handle.selectById === 'function') handle.selectById(station.id, { focus: true, notify: false });
      }, []);

      const clearSelection = useCallback(() => {
        setSelected(null);
        const handle = stageRef.current;
        if (handle && typeof handle.clearSelection === 'function') handle.clearSelection(false);
      }, []);

      const focusSelected = useCallback(() => {
        const handle = stageRef.current;
        const station = selectedRef.current;
        if (handle && station && typeof handle.selectById === 'function') {
          handle.selectById(station.id, { focus: true, notify: false });
        }
      }, []);

      useEffect(() => {
        const handle = stageRef.current;
        if (handle && typeof handle.setLanguage === 'function') handle.setLanguage(lang);
      }, [lang, stage.status]);

      const results = useMemo(() => {
        if (!repository || query.trim().length === 0) return [];
        return repository.search(query, 10);
      }, [repository, query]);

      const submitSearch = useCallback(
        (event) => {
          if (event) event.preventDefault();
          if (results.length > 0) chooseStation(results[0]);
        },
        [results, chooseStation],
      );

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
      const detailNote = radio.fallback
        ? `${t('demoNote')} (${radio.fallback.reason})`
        : selected && selected.metadata && selected.metadata.source === 'radio-browser'
          ? t('liveNote')
          : t('demoNote');

      const inCluster = modeState.mode === 'cluster' || modeState.state === 'transition-to-cluster';
      const clusterCategory = modeState.categoryId || null;
      const clusterCount = clusterCategory ? categoryCounts.get(clusterCategory) || 0 : 0;

      // Esc: search, then the category panel, then the cluster.
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          if (searchOpenRef.current) {
            event.preventDefault();
            event.stopPropagation();
            if (actionsRef.current.closeSearch) actionsRef.current.closeSearch();
            return;
          }
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

      actionsRef.current = { openSearch, closeSearch, openCategories, closeCategories, scheduleClose, cancelClose, backToHole };

      const selectedCategories = selected ? selected.categories : [];
      const showHint = stageReady && !searchOpen && !selected;

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
              'aria-label': t('openSearch'),
              title: t('openSearch'),
              onClick: openSearch,
              'data-hidden': inCluster ? 'true' : 'false',
            }),

            h(
              'button',
              { type: 'button', className: 'bhrl-quit', onClick: closePanel, title: t('close'), 'aria-label': t('close') },
              h(Cross, { size: 14 }),
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
              h(
                'button',
                { type: 'button', className: 'bhrl-iconbtn', onClick: openSearch, title: t('clusterSearch'), 'aria-label': t('clusterSearch') },
                h(Magnifier, { size: 13 }),
              ),
            ),

            showHint ? h('p', { className: 'bhrl-hint' }, inCluster ? t('hintCluster') : t('hintBlackHole')) : null,
          ),

          searchOpen ? h('div', { className: 'bhrl-scrim', onPointerDown: closeSearch, 'aria-hidden': 'true' }) : null,
          searchOpen
            ? h(
                'div',
                { className: 'bhrl-search' },
                h(
                  'form',
                  {
                    className: 'bhrl-search__field',
                    role: 'search',
                    onSubmit: submitSearch,
                    onPointerDown: (event) => event.stopPropagation(),
                  },
                  h('span', { className: 'bhrl-search__icon' }, h(Magnifier, { size: 14 })),
                  h('input', {
                    ref: searchInputRef,
                    className: 'bhrl-search__input',
                    type: 'text',
                    value: query,
                    placeholder: t('searchPlaceholder'),
                    'aria-label': t('searchLabel'),
                    autoComplete: 'off',
                    spellCheck: false,
                    onChange: (event) => setQuery(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        closeSearch();
                      }
                    },
                  }),
                  query.length > 0
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'bhrl-search__clear',
                          onClick: () => {
                            setQuery('');
                            focusSearchInput();
                          },
                          'aria-label': t('searchClear'),
                        },
                        '×',
                      )
                    : null,
                ),
                h('p', { className: 'bhrl-search__hint' }, t('searchHint')),
                query.trim().length > 0
                  ? results.length > 0
                    ? h(
                        'ul',
                        { className: 'bhrl-results', 'aria-label': t('searchLabel') },
                        results.map((station) =>
                          h(
                            'li',
                            { key: station.id },
                            h(
                              'button',
                              { type: 'button', className: 'bhrl-result', onClick: () => chooseStation(station) },
                              h('span', { className: 'bhrl-result__name' }, station.name),
                              h(
                                'span',
                                { className: 'bhrl-result__meta' },
                                `${station.country[lang]} · ${station.language[lang]} · ${station.categories.map(categoryName).join(' / ')}`,
                              ),
                            ),
                          ),
                        ),
                      )
                    : h('p', { className: 'bhrl-results__empty' }, t('noResults'))
                  : null,
              )
            : null,

          h(
            'div',
            {
              className: 'bhrl-cats',
              ref: catsRef,
              'data-open': categoriesOpen && !searchOpen ? 'true' : 'false',
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

          h(
            'aside',
            { className: 'bhrl-detail', 'data-open': selected ? 'true' : 'false', 'aria-live': 'polite' },
            selected
              ? h(
                  'div',
                  null,
                  h(
                    'header',
                    { className: 'bhrl-detail__head' },
                    h('span', { className: 'bhrl-detail__kicker' }, t('detailTitle')),
                    h(
                      'button',
                      { type: 'button', className: 'bhrl-detail__close', onClick: clearSelection, title: t('closeDetail'), 'aria-label': t('closeDetail') },
                      h(Cross, { size: 11 }),
                    ),
                  ),
                  h('h2', { className: 'bhrl-detail__name' }, selected.name),
                  h('p', { className: 'bhrl-detail__id' }, `${t('stationId')} · ${selected.id}`),
                  h(
                    'dl',
                    { className: 'bhrl-detail__meta' },
                    h('div', null, h('dt', null, t('country')), h('dd', null, selected.country[lang])),
                    h('div', null, h('dt', null, t('language')), h('dd', null, selected.language[lang])),
                    h(
                      'div',
                      null,
                      h('dt', null, t('category')),
                      h(
                        'dd',
                        null,
                        selectedCategories.map((id, index) =>
                          h(
                            'span',
                            { key: id, className: 'bhrl-detail__cat' },
                            h(CategoryDot, { color: categoryColor(id) }),
                            categoryName(id),
                            index < selectedCategories.length - 1 ? ' / ' : '',
                          ),
                        ),
                      ),
                    ),
                  ),
                  h('p', { className: 'bhrl-detail__desc' }, selected.description[lang]),
                  selected.isFeatured ? h('p', { className: 'bhrl-detail__feat' }, t('featuredNote')) : null,
                  h(
                    'div',
                    { className: 'bhrl-detail__actions' },
                    h('button', { type: 'button', className: 'bhrl-btn', onClick: focusSelected }, t('focusStation')),
                    h('button', { type: 'button', className: 'bhrl-btn', onClick: clearSelection }, t('cancelSelection')),
                  ),
                  h('p', { className: 'bhrl-detail__note' }, detailNote),
                )
              : null,
          ),
        ),
      );
    }

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

.bhrl-scrim { position: absolute; inset: 0; z-index: 7; background: transparent; }
.bhrl-search {
  position: absolute; left: 50%; top: 50%; z-index: 8; width: min(430px, 82%);
  transform: translate(-50%, -50%); animation: bhrl-rise-in 200ms ease both;
}
.bhrl-search__field {
  display: flex; align-items: center; gap: 9px; padding: 11px 12px; border-radius: 11px;
  border: 1px solid rgba(255, 158, 96, 0.34); background: rgba(6, 8, 14, 0.84);
  box-shadow: 0 0 0 1px rgba(255, 140, 70, 0.05) inset, 0 0 46px rgba(255, 120, 46, 0.14), 0 18px 50px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(10px);
}
.bhrl-search__icon { display: inline-flex; color: rgba(255, 186, 140, 0.7); flex: 0 0 auto; }
.bhrl-search__input {
  flex: 1 1 auto; min-width: 0; padding: 0; border: 0; background: transparent; color: #f6f8fd;
  font: inherit; font-size: 14px; letter-spacing: 0.02em; outline: none;
}
.bhrl-search__input::placeholder { color: rgba(206, 218, 238, 0.36); }
.bhrl-search__clear {
  flex: 0 0 auto; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%;
  background: transparent; color: rgba(214, 224, 240, 0.5); font: inherit; font-size: 15px; line-height: 1; cursor: pointer;
}
.bhrl-search__clear:hover { color: var(--bhrl-ink); background: rgba(255, 255, 255, 0.06); }
.bhrl-search__hint { margin: 7px 2px 0; font-size: 9.5px; letter-spacing: 0.1em; color: rgba(206, 218, 238, 0.32); text-align: center; }
.bhrl-results {
  margin: 10px 0 0; padding: 5px; list-style: none; max-height: min(300px, 42vh); overflow: auto;
  border-radius: 11px; border: 1px solid var(--bhrl-line); background: rgba(5, 7, 12, 0.9);
  backdrop-filter: blur(10px); box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55);
}
.bhrl-result {
  display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 7px 9px; border: 0;
  border-radius: 7px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.bhrl-result:hover, .bhrl-result:focus-visible { background: rgba(255, 255, 255, 0.055); outline: none; }
.bhrl-result__name { font-size: 12px; color: var(--bhrl-ink); }
.bhrl-result__meta { font-size: 10px; color: var(--bhrl-ink-faint); }
.bhrl-results__empty {
  margin: 10px 0 0; padding: 10px 2px; font-size: 11px; color: var(--bhrl-ink-faint); text-align: center;
  border-radius: 10px; border: 1px solid var(--bhrl-line-soft); background: rgba(5, 7, 12, 0.55);
}

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

.bhrl-detail {
  position: absolute; left: 16px; bottom: 16px; z-index: 8; width: min(330px, calc(100% - 32px));
  max-height: min(56%, 420px); overflow: auto; padding: 12px 13px; border-radius: 12px;
  border: 1px solid var(--bhrl-line-soft); background: rgba(6, 8, 14, 0.8); backdrop-filter: blur(10px);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55); opacity: 0; transform: translateY(6px); pointer-events: none; visibility: hidden;
  transition: opacity 200ms ease, transform 200ms ease;
}
.bhrl-detail[data-open="true"] { opacity: 1; transform: none; pointer-events: auto; visibility: visible; }
.bhrl-detail__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.bhrl-detail__kicker { font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(232, 238, 250, 0.46); }
.bhrl-detail__close { width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: rgba(214, 224, 240, 0.5); cursor: pointer; }
.bhrl-detail__close:hover { color: var(--bhrl-ink); background: rgba(255, 255, 255, 0.06); }
.bhrl-detail__name { margin: 5px 0 2px; font-size: 15px; font-weight: 600; line-height: 1.32; overflow-wrap: anywhere; }
.bhrl-detail__id { margin: 0 0 8px; font-size: 9px; letter-spacing: 0.08em; color: rgba(206, 218, 238, 0.4); font-variant-numeric: tabular-nums; }
.bhrl-detail__meta { margin: 0 0 8px; display: grid; gap: 3px; }
.bhrl-detail__meta > div { display: flex; gap: 8px; align-items: baseline; font-size: 10px; }
.bhrl-detail__meta dt { color: rgba(206, 218, 238, 0.44); flex: 0 0 auto; }
.bhrl-detail__meta dd { margin: 0 0 0 auto; color: var(--bhrl-ink-dim); text-align: right; }
.bhrl-detail__cat { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
.bhrl-detail__desc { margin: 0 0 7px; font-size: 10.5px; line-height: 1.6; color: var(--bhrl-ink-dim); overflow-wrap: anywhere; }
.bhrl-detail__feat { margin: 0 0 6px; font-size: 9.5px; color: rgba(255, 190, 150, 0.75); }
.bhrl-detail__note { margin: 9px 0 0; padding-top: 7px; border-top: 1px solid var(--bhrl-line-soft); font-size: 9px; line-height: 1.55; color: rgba(206, 218, 238, 0.36); }
.bhrl-detail__actions { display: flex; gap: 6px; margin-top: 9px; flex-wrap: wrap; }
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
  .bhrl-detail { left: 10px; right: 10px; bottom: 10px; width: auto; max-height: 52%; }
  .bhrl-clusterbar { left: 10px; top: 10px; gap: 8px; }
  .bhrl-search { width: calc(100% - 28px); }
}
@media (prefers-reduced-motion: reduce) {
  .bhrl-boot__disc { animation: none; }
  .bhrl-cats, .bhrl-detail, .bhrl-clusterbar, .bhrl-search { transition-duration: 0ms; animation: none; }
}
`;

    return {
      inject: ['slots', 'locale', 'layout'],

      apply(ctx) {
        const localeSvc = ctx.get ? ctx.get('locale') : null;
        const layoutSvc = ctx.get ? ctx.get('layout') : null;

        if (!document.getElementById(STYLE_ID)) {
          const style = document.createElement('style');
          style.id = STYLE_ID;
          style.textContent = CSS;
          document.head.appendChild(style);
        }

        const disposers = [];

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

        claim(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 46, label: () => makeT(localeSvc)('sidebarEntry') },
          () => h(PanelIcon, { size: 16 }),
        );

        claim({ name: 'main', key: PANEL_ID }, () => h(Panel, { localeSvc, closePanel, requireAsync: require.async }));

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
