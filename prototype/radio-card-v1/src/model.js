/**
 * Demo model for the radio card prototype.
 *
 * This is a *demo* store, not a player:
 *   - pressing play only flips a boolean;
 *   - favourite / like / volume only mutate this object;
 *   - prev / next cycle a handful of hard-coded entries;
 *   - nothing here touches audio, the network, or a real station catalogue.
 *
 * The card and the preview share this one module, so both render from the same
 * state transitions instead of drifting apart.
 */

/** Explicitly fake entries. `unknown: true` exercises the missing-metadata case. */
export const DEMO_STATIONS = Object.freeze([
  {
    id: 'demo-1',
    name: '宇宙边缘 · 深空电台 · 柯伊伯带中继站 · 长波观测阵列',
    song: '在猎户座旋臂尽头等待一次没有回音的呼叫（现场版）',
    artist: '无名观测者与银河管弦乐团',
  },
  {
    id: 'demo-2',
    name: '低频潮汐 · 24 小时环境广播',
    song: '吸积盘边缘的第七次日落',
    artist: '事件视界合唱团',
  },
  {
    id: 'demo-3',
    name: '未知电台',
    song: '未知歌曲信息',
    artist: '未知艺术家',
    unknown: true,
  },
  {
    id: 'demo-4',
    name: '类星体回声 · 复古合成器频道',
    song: '喷流尽头的一封信',
    artist: 'Sagittarius A* Studio',
  },
  {
    id: 'demo-5',
    name: '安静的黑洞 · 白噪声与雨声',
    song: '凌晨四点的银河系第三旋臂',
    artist: '失眠者电台',
  },
]);

/**
 * Display-text variants for layout checks.
 *
 * They override only the three text slots, never the station identity: the
 * favourite/like state keeps following the underlying demo station, so a
 * variant switch cannot fake a different station's saved state.
 */
export const TEXT_VARIANTS = Object.freeze({
  short: { name: '城市电台', song: '夜航', artist: '林一' },
  medium: { name: '城市电台 · 午夜频率', song: '夜航西飞', artist: '林一与夜班乐队' },
  long: {
    name: '宇宙边缘 · 深空电台 · 柯伊伯带中继站 · 长波观测阵列',
    song: '在猎户座旋臂尽头等待一次没有回音的呼叫（现场版）',
    artist: '无名观测者与银河管弦乐团',
  },
});

/** Volume starts mid-scale so the expanded slider has a visible position. */
const DEFAULT_VOLUME = 0.42;

export function createDemoModel() {
  /** @type {Set<string>} */
  const favourites = new Set(['demo-2']);
  /** @type {Set<string>} */
  const likes = new Set(['demo-1']);

  let state = {
    index: 0,
    playing: false,
    volume: DEFAULT_VOLUME,
    volumeOpen: false,
    /** null | 'short' | 'medium' | 'long' — layout-check text override. */
    variant: null,
    /** Recorded intent only: this round never opens an exploration page. */
    intents: [],
  };
  const listeners = new Set();

  const snapshot = () => {
    const base = DEMO_STATIONS[state.index];
    const override = state.variant ? TEXT_VARIANTS[state.variant] : null;
    const station = override ? { ...base, ...override } : base;
    return {
      ...state,
      station,
      favourite: favourites.has(base.id),
      liked: likes.has(base.id),
      intents: state.intents.slice(),
    };
  };

  let current = snapshot();

  const emit = () => {
    current = snapshot();
    for (const listener of listeners) listener(current);
  };

  return {
    getState() {
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    togglePlay() {
      state = { ...state, playing: !state.playing };
      emit();
    },
    next() {
      state = { ...state, index: (state.index + 1) % DEMO_STATIONS.length };
      emit();
    },
    prev() {
      state = {
        ...state,
        index: (state.index - 1 + DEMO_STATIONS.length) % DEMO_STATIONS.length,
      };
      emit();
    },
    toggleFavourite() {
      const id = DEMO_STATIONS[state.index].id;
      if (favourites.has(id)) favourites.delete(id);
      else favourites.add(id);
      emit();
    },
    toggleLike() {
      const id = DEMO_STATIONS[state.index].id;
      if (likes.has(id)) likes.delete(id);
      else likes.add(id);
      emit();
    },
    setVolume(value) {
      const nextValue = Math.min(1, Math.max(0, Number(value) || 0));
      state = { ...state, volume: nextValue };
      emit();
    },
    /** Layout-check helper: null restores the demo station's own text. */
    setTextVariant(variant) {
      const next = variant && TEXT_VARIANTS[variant] ? variant : null;
      if (state.variant === next) return;
      state = { ...state, variant: next };
      emit();
    },
    setVolumeOpen(open) {
      if (state.volumeOpen === Boolean(open)) return;
      state = { ...state, volumeOpen: Boolean(open) };
      emit();
    },
    /** Non-control areas only record that the user wants the exploration page. */
    requestEntry(source) {
      state = {
        ...state,
        intents: [...state.intents, { source, at: Date.now() }].slice(-20),
      };
      emit();
    },
  };
}
