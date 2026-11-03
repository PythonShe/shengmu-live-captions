// lib/ cannot reach chrome.i18n, so it describes user-facing text as a
// message: a messages.json key plus params, rendered by whoever has a
// translator (pages, worker, offscreen). A param may itself be a message,
// e.g. a provider name inside an error.

/**
 * @typedef {{ key: string, params: Array<unknown> }} LocalMessage
 */

/**
 * @param {string} key messages.json key
 * @param {...unknown} params $1..$9
 * @returns {LocalMessage}
 */
export function msg(key, ...params) {
  return { key, params };
}

/** @returns {value is LocalMessage} */
export function isLocalMessage(value) {
  return Boolean(value && typeof value === "object" && typeof value.key === "string");
}

/**
 * @param {(key: string, ...params: string[]) => string} translate
 * @param {unknown} value a string, a LocalMessage, or nothing
 * @returns {string}
 */
export function renderWith(translate, value) {
  if (isLocalMessage(value)) {
    const params = Array.isArray(value.params) ? value.params : [];
    return translate(value.key, ...params.map((param) => renderWith(translate, param)));
  }
  return value === null || value === undefined ? "" : String(value);
}

/** An Error whose user-facing text is a LocalMessage; `message` is the key. */
export class LocalizedError extends Error {
  /**
   * @param {LocalMessage} message
   * @param {ErrorOptions} [options]
   */
  constructor(message, options) {
    super(message.key, options);
    this.name = "LocalizedError";
    this.localMessage = message;
  }
}

/**
 * The user-facing description of anything thrown: its LocalMessage when it
 * has one, otherwise its message text.
 * @param {unknown} error
 * @returns {LocalMessage | string}
 */
export function errorMessage(error) {
  const local = /** @type {any} */ (error)?.localMessage;
  if (isLocalMessage(local)) return local;
  if (isLocalMessage(error)) return error;
  if (error instanceof Error) return error.message;
  return error === null || error === undefined ? "" : String(error);
}
