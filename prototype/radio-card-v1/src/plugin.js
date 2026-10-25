/**
 * Browser half of the prototype.
 *
 * Seat strategy (real dsh-web host, 0.2.1-rc.3):
 *
 *   1. Preferred: the **proposed** seat `sidebar.footer.card`. If a host ever
 *      declares it, the card mounts there and nothing else happens.
 *   2. Fallback: the **existing** `sidebar.footer.action` seat. The installed
 *      host renders that seat as a single horizontal flex row, so the card
 *      shares one line with any other footer occupant. The card adapts to the
 *      width it actually gets (full / compact / compact-min); this is measured
 *      and reported as an experiment, NOT as the final host contract.
 *
 * Exactly one seat is used per host: the fallback only runs when mounting into
 * the proposed seat fails (the seat is not declared), so the card cannot appear
 * twice.
 *
 * Collapsed sidebar: the host passes `wide: false` to the occupant. The card is
 * then unmounted instead of being squeezed into the 56px icon rail. The demo
 * model lives at module scope, so the current entry, favourite, like, volume and
 * playing state survive the unmount; expanding the sidebar remounts the card
 * with the same state. The host's own expand control is the only way back — no
 * extra collapsed-mode player is added this round.
 */

import { createDemoModel } from './model.js';
import { createCard } from './card.js';

window.__ModuleLoader__.load({
  id: '@local/dsh-radio-card-prototype',

  factory(require) {
    const React = require('react');
    const { createElement: h, useEffect, useRef } = React;

    /** Proposed seat: vertical card stack above the footer actions. */
    const SEAT_PROPOSED = 'sidebar.footer.card';
    /** Existing seat used for the load-bearing experiment. */
    const SEAT_EXISTING = 'sidebar.footer.action';
    const CARD_ID = 'radio-card';
    const ORDER = 10;

    // Survives occupant remounts on purpose (see the header comment).
    const model = createDemoModel();

    /** Set in apply(); read by the occupant so the DOM carries its seat name. */
    let activeSeat = SEAT_PROPOSED;
    /** The card instance currently mounted, for the real-host test hooks. */
    let activeCard = null;
    let lastWide = null;

    function CardOccupant(props) {
      // The sidebar passes { wide } to its footer occupants. Treat an unknown
      // host as "expanded": hiding the player on a missing prop would be a
      // silent regression, while rendering it is the old behaviour.
      const wide = props && typeof props.wide === 'boolean' ? props.wide : true;
      lastWide = wide;
      const hostRef = useRef(null);

      useEffect(() => {
        if (!wide) return undefined;
        const card = createCard({
          model,
          onEntry: (source) => model.requestEntry(source),
        });
        activeCard = card;
        const host = hostRef.current;
        if (host) {
          host.dataset.seat = activeSeat;
          host.dataset.wide = String(wide);
          host.appendChild(card.el);
        }
        return () => {
          activeCard = null;
          card.destroy();
        };
      }, [wide]);

      // Collapsed rail: render nothing at all — no text, no background, no
      // tooltip layer, no focusable leftovers.
      if (!wide) return null;

      return h('div', { className: 'rc-occupant', 'data-wide': String(wide), ref: hostRef });
    }

    return {
      inject: ['slots'],

      apply(ctx) {
        const slots = ctx.get ? ctx.get('slots') : null;
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          return;
        }

        const mount = (seat) => {
          activeSeat = seat;
          return ctx.slots.register({ name: seat, id: CARD_ID, order: ORDER }, CardOccupant);
        };

        // Probe the proposed seat once. A host that does not declare it throws
        // (or returns nothing) before anything is mounted, so the fallback below
        // cannot double-mount the card.
        try {
          const mounted = mount(SEAT_PROPOSED);
          if (mounted) return;
        } catch {
          /* seat not declared in this host — expected on 0.2.1-rc.3 */
        }

        // Existing-seat experiment: inject() is the lifecycle-aware wrapper the
        // shipped sidebar uses for every one of its own occupants.
        // Test hooks for the real-host verification round: the demo model, the
        // seat actually used, the live card and the last `wide` value. No audio,
        // no host mutation.
        window.__radioCardPrototype = {
          model,
          seat: () => activeSeat,
          card: () => activeCard,
          mode: () => (activeCard ? activeCard.mode() : null),
          width: () => (activeCard ? activeCard.el.getBoundingClientRect().width : null),
          lastWide: () => lastWide,
        };

        ctx.slots.inject(SEAT_EXISTING, () => {
          try {
            return mount(SEAT_EXISTING);
          } catch (error) {
            console.warn('[radio-card-prototype] footer.action registration failed:', error);
            return undefined;
          }
        });
      },
    };
  },
});
