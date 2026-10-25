/**
 * Radio card prototype — Host half.
 *
 * This half exists only so the package can be mounted as a profile layer: the
 * loader entry must declare `dsh.bundle.patch`, and the browser half is
 * discovered from this entry's `dsh.client` declaration.
 *
 * It deliberately owns no state, no route and no audio. The card is a browser
 * concern, and this round the card is not connected to the live DSH sidebar at
 * all: the host does not declare `sidebar.footer.card` yet, so the client half
 * simply waits (see src/plugin.js).
 */

/** Plugin identity for cordis.yml rows and diagnostics. */
export const name = 'radio-card-prototype';

/** No host services are needed: there is nothing to configure or serve. */
export const inject = [];

export function apply() {
  // Intentionally empty. Nothing is registered on the Host side.
}
