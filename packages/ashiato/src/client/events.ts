/** Custom screen replay events the browser script adds for what rrweb doesn't record and a test generated from the replay needs. */

/** An alert / confirm / prompt: `{ type, message, answer }` (no answer for an alert). */
export const DIALOG_EVENT = "ashiato/dialog";
/**
 * An Enter press: `{ key, id, value? }`, `id` being the rrweb node id of the element it was pressed
 * in, and `value` the text in it when that is a text field (masked like rrweb masks it).
 */
export const KEY_EVENT = "ashiato/key";
/**
 * A `change` event a script dispatched on a <select> or a date-like <input> (`{ id }`): a value picked
 * by a test tool or a component, not set by the app. rrweb records such a change as not made by the user.
 */
export const CHANGE_EVENT = "ashiato/change";
/**
 * Comes right before a full snapshot taken again of the same page (every few minutes, or when the
 * recorder asks): it is not a page load, though the URL may differ (a single-page app moved on).
 */
export const RESNAPSHOT_EVENT = "ashiato/resnapshot";
