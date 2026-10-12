/** Custom screen replay events the browser script adds for what rrweb doesn't record and a test generated from the replay needs. */

/** An alert / confirm / prompt: `{ type, message, answer }` (no answer for an alert). */
export const DIALOG_EVENT = "ashiato/dialog";
/**
 * An Enter press: `{ key, id, value? }`, `id` being the rrweb node id of the element it was pressed
 * in, and `value` the text in it when that is a text field (masked like rrweb masks it).
 */
export const KEY_EVENT = "ashiato/key";
/**
 * A `change` event a script dispatched on a <select> (`{ id }`): an option picked by a test tool or
 * a dropdown component, not set by the app. rrweb records such a change as not made by the user.
 */
export const CHANGE_EVENT = "ashiato/change";
