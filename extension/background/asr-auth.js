// A WebSocket opened from a page cannot carry an Authorization header, and
// Bailian's realtime ASR accepts the key nowhere else. A session rule adds it
// to the handshake instead, limited to this extension's own non-tab requests
// so a web page opening the same endpoint gets nothing.
export const ASR_AUTH_RULE_ID = 8101;

/**
 * @param {{ dnr?: typeof chrome.declarativeNetRequest, extensionId?: string }} [deps]
 */
export function createAsrAuth({
  dnr = chrome.declarativeNetRequest,
  extensionId = chrome.runtime.id
} = {}) {
  /** @param {string} url wss:// endpoint @param {string} apiKey */
  async function grant(url, apiKey) {
    const { host, pathname } = new URL(url);
    await dnr.updateSessionRules({
      removeRuleIds: [ASR_AUTH_RULE_ID],
      addRules: [
        {
          id: ASR_AUTH_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [{ header: "Authorization", operation: "set", value: `Bearer ${apiKey}` }]
          },
          condition: {
            urlFilter: `|wss://${host}${pathname}`,
            resourceTypes: ["websocket"],
            initiatorDomains: [extensionId],
            tabIds: [-1]
          }
        }
      ]
    });
  }

  async function revoke() {
    try {
      await dnr.updateSessionRules({ removeRuleIds: [ASR_AUTH_RULE_ID] });
    } catch (error) {
      console.warn("声幕移除语音识别鉴权规则失败", error);
    }
  }

  return { grant, revoke };
}
