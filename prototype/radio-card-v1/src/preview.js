/**
 * Isolated preview harness.
 *
 * It simulates the left rail — padding, conversation list, the proposed card
 * area, existing bottom-plugin action rows and the DSH settings entry — and
 * mounts the *same* card component and demo model the plugin uses.
 *
 * It is evidence for the card's own layout and interactions only. It is NOT
 * evidence that the DSH host declares the seat, that other plugins coexist in
 * the real sidebar, or that the plugin is installed.
 */

import { createCard } from './card.js';
import { createDemoModel } from './model.js';

/** Source-derived sidebar padding: 6px top/bottom, 12px left/right. */
const RAIL_PADDING_Y = 12;
/** Design suggestions carried over from the stage-0 supplement. */
const GAP_ABOVE_CARDS = 8;
const GAP_BELOW_CARDS = 6;
/** Conversation-list reserve used for this preview only (a policy value). */
let reserve = 160;
/**
 * Degradation floors. These are DESIGN SUGGESTIONS, not measurements: below
 * the region floor the conversation list stops being useful, and below the card
 * sliver the card is no longer a usable entry.
 */
const REGION_FLOOR = 96;
const CARD_SLIVER = 96;
/** Bottom padding of the rail (half of the 6px/6px pair from the source CSS). */
const RAIL_PADDING_BOTTOM = RAIL_PADDING_Y / 2;

const WIDTHS = [264, 280, 420];
const HEIGHTS = [860, 640, 520, 420];

const model = createDemoModel();

const dom = {
  frame: document.getElementById('frame'),
  rail: document.getElementById('rail'),
  top: document.getElementById('top'),
  region: document.getElementById('region'),
  cards: document.getElementById('cards'),
  actions: document.getElementById('actions'),
  settings: document.getElementById('settings'),
  report: document.getElementById('report'),
  log: document.getElementById('log'),
  metrics: document.getElementById('metrics'),
  warn: document.getElementById('warn'),
};

let width = 280;
let height = 860;
let cardCount = 1;
let stackOther = true;
let mounted = [];
/** Numbers from the last layout pass, so the report states what was applied. */
let lastLayout = {};
/** Uncapped count: the model keeps only the last 20 intents for display. */
let entryCalls = 0;

function logIntent(source) {
  entryCalls += 1;
  model.requestEntry(source);
}

function renderLog(state) {
  dom.log.textContent = state.intents.length
    ? state.intents.map((i) => `${i.source} @ ${new Date(i.at).toLocaleTimeString()}`).reverse().join('\n')
    : '（尚未记录）';
}

function renderCardCount() {
  for (const card of mounted) card.destroy();
  mounted = [];

  mounted.push(
    createCard({
      model,
      onEntry: logIntent,
    }),
  );

  if (cardCount > 1) {
    // A second occupier stands in for another plugin's card. It is deliberately
    // not a radio card: the point is vertical allocation, not another feature.
    const placeholder = document.createElement('div');
    placeholder.className = 'pv-other-card';
    placeholder.innerHTML =
      '<span class="pv-other-card__title">其他插件卡片（占位）</span>' +
      '<span class="pv-other-card__hint">用于检查多卡纵向分配与滚动</span>';
    mounted.push({ el: placeholder, destroy: () => placeholder.remove() });
  }

  dom.cards.replaceChildren(...mounted.map((card) => card.el));
}

function applySize() {
  dom.frame.style.setProperty('--rail-w', `${width}px`);
  dom.frame.style.setProperty('--frame-h', `${height}px`);
  dom.rail.dataset.width = String(width);
  layoutCards();
}

/**
 * Compute the card-area budget from real geometry, then size the area.
 *
 * Measurement pins the conversation list at its reserve height (flex: none) and
 * collapses the card area to 0, so the distance from the card area's top edge to
 * the rail's inner bottom — minus the action rows, the settings entry and the
 * lower gap — is the budget C. While measuring, the region must NOT be allowed
 * to flex-grow into the space the cards would use; afterwards it is restored to
 * flex: 1 so it absorbs any leftover space.
 */
function layoutCards() {
  dom.region.style.flex = '0 0 auto';
  dom.region.style.height = `${reserve}px`;
  dom.region.style.minHeight = `${reserve}px`;
  dom.cards.style.height = '0px';

  let effectiveReserve = reserve;
  let m = measure();
  const policyBudget = m.budget;

  // Stage 1 — if the policy reserve leaves no usable card entry, give the
  // conversation list's reserve back down to its floor and try again.
  if (policyBudget < CARD_SLIVER && reserve > REGION_FLOOR) {
    effectiveReserve = REGION_FLOOR;
    dom.region.style.height = `${effectiveReserve}px`;
    dom.region.style.minHeight = `${effectiveReserve}px`;
    m = measure();
  }

  const budget = m.budget;
  const natural =
    mounted.reduce((sum, card) => sum + card.el.getBoundingClientRect().height, 0) +
    Math.max(0, mounted.length - 1) * GAP_ABOVE_CARDS;

  const areaHeight = budget >= natural ? natural : Math.max(0, budget);
  dom.cards.style.height = `${areaHeight}px`;

  // Restore the region: it absorbs the slack, but never drops below its reserve.
  dom.region.style.flex = '1 1 auto';
  dom.region.style.height = '';
  dom.region.style.minHeight = `${effectiveReserve}px`;

  // Measure again AFTER applying: the honest question is whether the rail still
  // contains every region, not what the arithmetic predicted.
  const railRect = dom.rail.getBoundingClientRect();
  const settingsRect = dom.settings.getBoundingClientRect();
  const railOverflow = dom.rail.scrollHeight - dom.rail.clientHeight;
  const settingsClipped = settingsRect.bottom > railRect.bottom - RAIL_PADDING_BOTTOM + 1;
  const cramped = railOverflow > 0 || settingsClipped || budget <= 0;

  const warnings = [];
  if (effectiveReserve < reserve) {
    warnings.push(`会话列表保留被压到 ${effectiveReserve}px（策略值 ${reserve}px），用来保住卡片入口。`);
  }
  if (budget > 0 && areaHeight < natural) {
    warnings.push(`空间不足：卡片区 ${areaHeight}px < 需要 ${Math.round(natural)}px，卡片区内部滚动，单卡仍可完整访问。`);
  }
  if (budget <= 0) {
    warnings.push(`预算用尽（C=${budget}px）：卡片入口高度为 0，无法同时满足。`);
  }
  if (railOverflow > 0 || settingsClipped) {
    warnings.push(`极矮窗口：窗口高 ${height}px 时卡片入口、原有插件与 DSH 原有设置入口无法同时完整可见（按文档不承诺）。`);
  }

  dom.rail.dataset.cramped = String(cramped);
  dom.warn.hidden = warnings.length === 0;
  dom.warn.textContent = warnings.join(' ');

  dom.metrics.textContent = [
    `左栏宽 ${width}px，内容盒 ${width - 24}px`,
    `窗口高 ${height}px`,
    `固定区 T=${Math.round(dom.top.getBoundingClientRect().height)}px  A=${Math.round(dom.actions.getBoundingClientRect().height)}px  S=${Math.round(settingsRect.height)}px`,
    `间距 G₁=${GAP_ABOVE_CARDS}px  G₂=${GAP_BELOW_CARDS}px  保留 R：策略 ${reserve}px / 生效 ${effectiveReserve}px`,
    `卡片区预算 C：按策略 ${policyBudget}px / 实际 ${budget}px`,
    `内容需要 D_need=${Math.round(natural)}px，卡片区实际 ${areaHeight}px${budget > 0 && areaHeight < natural ? '（内部滚动）' : ''}`,
    `卡片数 ${mounted.length}${cramped ? ' · 极矮窗口边界' : ''}`,
  ].join('\n');

  lastLayout = {
    policyBudget,
    budget,
    effectiveReserve,
    natural: Math.round(natural),
    areaHeight,
    railOverflow,
    settingsClipped,
    cramped,
    warnings: warnings.join(' '),
  };
}

function measure() {
  const railRect = dom.rail.getBoundingClientRect();
  const cardsRect = dom.cards.getBoundingClientRect();
  const actionsRect = dom.actions.getBoundingClientRect();
  const settingsRect = dom.settings.getBoundingClientRect();
  const innerBottom = railRect.bottom - RAIL_PADDING_BOTTOM;
  return {
    railRect,
    cardsRect,
    actionsRect,
    settingsRect,
    budget: Math.floor(innerBottom - cardsRect.top - GAP_BELOW_CARDS - actionsRect.height - settingsRect.height),
  };
}

function viewportChecks() {
  const railRect = dom.rail.getBoundingClientRect();
  const regionRect = dom.region.getBoundingClientRect();
  const cardsRect = dom.cards.getBoundingClientRect();
  const actionsRect = dom.actions.getBoundingClientRect();
  const settingsRect = dom.settings.getBoundingClientRect();
  const cardsArea = dom.cards;
  const cards = [...cardsArea.querySelectorAll('.rc-card')];

  const results = [];
  const check = (id, ok, detail) => results.push({ id, ok, detail });

  check(
    'cards-below-region',
    cardsRect.top >= regionRect.bottom - 1,
    `卡片区 top=${Math.round(cardsRect.top)}，会话列表 bottom=${Math.round(regionRect.bottom)}`,
  );
  check(
    'cards-above-actions',
    cardsRect.bottom <= actionsRect.top + 1,
    `卡片区 bottom=${Math.round(cardsRect.bottom)}，动作区 top=${Math.round(actionsRect.top)}`,
  );
  check(
    'settings-inside-rail',
    settingsRect.height > 0 && settingsRect.bottom <= railRect.bottom + 1,
    `设置入口高 ${Math.round(settingsRect.height)}，底 ${Math.round(settingsRect.bottom)} / 左栏底 ${Math.round(railRect.bottom)}`,
  );

  // Card-level horizontal overflow and pairwise overlap.
  for (const [index, card] of cards.entries()) {
    check(
      `card-${index}-no-horizontal-overflow`,
      card.scrollWidth <= card.clientWidth + 1,
      `scrollWidth=${card.scrollWidth} clientWidth=${card.clientWidth}`,
    );
  }
  for (let i = 1; i < cards.length; i += 1) {
    const a = cards[i - 1].getBoundingClientRect();
    const b = cards[i].getBoundingClientRect();
    check(`card-${i - 1}-${i}-no-overlap`, a.bottom <= b.top + 1, `上卡 bottom=${Math.round(a.bottom)}，下卡 top=${Math.round(b.top)}`);
  }

  // Reachability is two facts, not one: the last card's BOTTOM must be
  // reachable when scrolled to the end, and its TOP when scrolled to the start.
  // A single card taller than the area can never have its whole rect inside at
  // once — that is fine as long as both edges are reachable in turn. Compare
  // against the card area's visible boundary, never against clientHeight.
  const areaRect = cardsArea.getBoundingClientRect();
  const lastCard = cards[cards.length - 1];

  cardsArea.scrollTop = 0;
  const topEdge = lastCard?.getBoundingClientRect();
  check(
    'last-card-top-reachable',
    Boolean(topEdge) && topEdge.top >= areaRect.top - 1,
    topEdge ? `末卡 top=${Math.round(topEdge.top)}，可视区 top=${Math.round(areaRect.top)}` : '无卡片',
  );

  cardsArea.scrollTop = cardsArea.scrollHeight;
  const bottomEdge = lastCard?.getBoundingClientRect();
  check(
    'last-card-bottom-reachable',
    Boolean(bottomEdge) && bottomEdge.bottom <= areaRect.bottom + 1,
    bottomEdge ? `末卡 bottom=${Math.round(bottomEdge.bottom)}，可视区 bottom=${Math.round(areaRect.bottom)}` : '无卡片',
  );

  // Focus should be able to bring an off-screen card back into view; this is
  // still "preview only" — real-host behavior is marked unverified.
  const firstEntry = cards[0]?.querySelector('.rc-entry');
  if (firstEntry) {
    cardsArea.scrollTop = 0;
    const before = cardsArea.scrollTop;
    cards[cards.length - 1]?.querySelector('.rc-entry')?.focus();
    const after = cardsArea.scrollTop;
    check(
      'focus-scrolls-into-view (preview only)',
      before !== after || cards.length === 1,
      `scrollTop ${before} → ${after}`,
    );
    firstEntry.focus();
  }

  // Controls must not trigger the future exploration entry.
  const before = entryCalls;
  cards[0]?.querySelector('.rc-btn--play')?.click();
  const afterControl = entryCalls;
  const afterPlayState = model.getState().playing;
  cards[0]?.querySelector('.rc-btn--play')?.click(); // restore play state
  cards[0]?.querySelector('.rc-entry')?.click();
  const afterEntry = entryCalls;

  check('control-does-not-open-entry', afterControl === before, `播放按钮后 intent=${afterControl}（点击前 ${before}）`);
  check('entry-records-intent', afterEntry === afterControl + 1, `入口后 intent=${afterEntry}`);
  check('play-toggles-demo-state', afterPlayState !== model.getState().playing, '演示播放状态已切换并被恢复');

  // Volume expands inside the card, without widening it.
  const volumeButton = cards[0]?.querySelector('[aria-label="音量"]');
  const controls = cards[0]?.querySelector('.rc-controls');
  if (volumeButton && controls) {
    volumeButton.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
    const cardWidth = cards[0].getBoundingClientRect().width;
    const slider = cards[0].querySelector('.rc-volume input');
    check(
      'volume-expands-inside-card',
      controls.dataset.volumeOpen === 'true' && slider.getBoundingClientRect().width > 0,
      `展开=${controls.dataset.volumeOpen}，滑块宽 ${Math.round(slider.getBoundingClientRect().width)}，卡片宽 ${Math.round(cardWidth)}`,
    );
    check(
      'volume-expansion-keeps-card-width',
      Math.abs(cards[0].getBoundingClientRect().width - cardWidth) <= 1 && cards[0].scrollWidth <= cards[0].clientWidth + 1,
      `卡片宽 ${Math.round(cardWidth)}，scrollWidth=${cards[0].scrollWidth}`,
    );
    model.setVolumeOpen(false);
  }

  // Truncation must be real: long text clipped, full text still available.
  const stationEntry = cards[0]?.querySelector('.rc-entry');
  const stationText = stationEntry?.querySelector('.rc-ellipsis');
  if (stationText) {
    check(
      'long-text-truncated',
      stationText.scrollWidth > stationText.clientWidth + 1,
      `文本宽 ${stationText.scrollWidth} / 可见 ${stationText.clientWidth}`,
    );
    const tipNode = stationEntry.querySelector('.rc-tip');
    check(
      'full-text-available',
      stationEntry.getAttribute('aria-label') === stationText.textContent && tipNode?.textContent === stationText.textContent,
      `aria-label=${JSON.stringify(stationEntry.getAttribute('aria-label'))}`,
    );

    // The tip is position: fixed, so a scrolling card area must not clip it,
    // and the scroll caused by focusing a clipped line must not hide it.
    stationEntry.dispatchEvent(new FocusEvent('focus'));
    cards[0].querySelector('.rc-controls')?.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    const tipRect = tipNode.getBoundingClientRect();
    check(
      'tip-readable-on-focus',
      tipNode.dataset.open === 'true' && tipRect.width > 0 && tipRect.top >= 0 && tipRect.bottom <= window.innerHeight + 1,
      `open=${tipNode.dataset.open} tipRect=${Math.round(tipRect.top)}..${Math.round(tipRect.bottom)} viewport=${window.innerHeight}`,
    );
    stationEntry.dispatchEvent(new FocusEvent('blur'));
    check('tip-hides-on-blur', tipNode.dataset.open !== 'true', `open=${tipNode.dataset.open}`);
  }

  const railOverflow = dom.rail.scrollHeight > dom.rail.clientHeight + 1;
  check('rail-fits-window', !railOverflow, `rail scrollHeight=${dom.rail.scrollHeight} clientHeight=${dom.rail.clientHeight}`);

  const failed = results.filter((r) => !r.ok).length;
  return {
    at: new Date().toISOString(),
    size: { width, height, contentWidth: width - 24, cardCount, stackOther },
    budget: lastLayout,
    // A short window is an explicitly documented boundary, not a passing case.
    boundary: lastLayout.cramped
      ? '极矮窗口：四个区域无法同时完整满足，按阶段0文档不承诺；上面的失败项属于该边界。'
      : '各区域均在窗口内。',
    checks: results,
    failed,
  };
}

function runChecks() {
  const report = viewportChecks();
  dom.report.textContent = JSON.stringify(report, null, 2);
  return report;
}

// ── toolbar wiring ───────────────────────────────────────────────────────────
function segmented(container, values, current, onPick, format) {
  container.replaceChildren(
    ...values.map((value) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = format ? format(value) : String(value);
      button.dataset.value = String(value);
      button.setAttribute('aria-pressed', String(value === current()));
      button.addEventListener('click', () => {
        onPick(value);
        for (const node of container.children) {
          node.setAttribute('aria-pressed', String(Number(node.dataset.value) === value));
        }
      });
      return button;
    }),
  );
}

segmented(document.getElementById('widths'), WIDTHS, () => width, (value) => {
  width = value;
  applySize();
}, (value) => `${value}px`);
segmented(document.getElementById('heights'), HEIGHTS, () => height, (value) => {
  height = value;
  applySize();
}, (value) => `${value}px`);

document.getElementById('cards-toggle').addEventListener('click', (event) => {
  cardCount = cardCount === 1 ? 2 : 1;
  event.currentTarget.setAttribute('aria-pressed', String(cardCount === 2));
  event.currentTarget.textContent = cardCount === 2 ? '2 张卡片' : '1 张卡片';
  renderCardCount();
  layoutCards();
});

document.getElementById('other-toggle').addEventListener('click', (event) => {
  stackOther = !stackOther;
  dom.actions.hidden = !stackOther;
  event.currentTarget.setAttribute('aria-pressed', String(!stackOther));
  event.currentTarget.textContent = stackOther ? '隐藏其他插件' : '显示其他插件';
  layoutCards();
});

document.getElementById('reserve').addEventListener('input', (event) => {
  reserve = Number(event.target.value);
  document.getElementById('reserve-value').textContent = `${reserve}px`;
  layoutCards();
});
document.getElementById('reserve').value = String(reserve);
document.getElementById('reserve-value').textContent = `${reserve}px`;

document.getElementById('run-checks').addEventListener('click', () => {
  runChecks();
});

// ── boot ─────────────────────────────────────────────────────────────────────
// The mock rail in this page is dark, so the preview simulates DSH's dark theme
// by setting the same <body> marker the host uses. `?theme=light` renders the
// light variant instead. Preview-only: inside DSH, the host owns this marker.
if (new URLSearchParams(location.search).get('theme') !== 'light') {
  document.body.setAttribute('data-ds-dark-theme', '');
}
renderCardCount();
applySize();
model.subscribe(renderLog);
renderLog(model.getState());

window.addEventListener('resize', layoutCards);
// Expose for the browser-driven verification pass.
window.__cardPreview = { runChecks, model, layoutCards, applySize, setSize: (w, h) => { width = w; height = h; applySize(); } };
