// Maintains one declarativeNetRequest rule that stamps venue-api-key
// (plus Origin/Referer) onto UMAI API calls. Stripe traffic is excluded
// via excludedRequestDomains so payment requests stay untouched.
const RULE_ID = 1;

async function applyRule(apiKey) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: apiKey
      ? [
          {
            id: RULE_ID,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders: [
                { header: "venue-api-key", operation: "set", value: apiKey },
                { header: "Origin", operation: "set", value: "https://reservation.umai.io" },
                { header: "Referer", operation: "set", value: "https://reservation.umai.io/" },
              ],
            },
            condition: {
              requestDomains: ["umai.io", "letsumai.com"],
              excludedRequestDomains: ["stripe.com"],
              resourceTypes: [
                "xmlhttprequest",
                "sub_frame",
                "main_frame",
                "other",
              ],
            },
          },
        ]
      : [],
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  applyRule(apiKey || "");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "apiKey" in changes) {
    applyRule(changes.apiKey.newValue || "");
  }
});
