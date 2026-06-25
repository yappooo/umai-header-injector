// Maintains one declarativeNetRequest rule that stamps venue-api-key
// (plus Origin/Referer) onto UMAI API calls. Stripe traffic is excluded
// via excludedRequestDomains so payment requests stay untouched.
const RULE_ID = 1;
const HARVEST_URL = "https://reservation.umai.io/en/widget/rembayung";
const CF_TIMEOUT_MS = 45000;

async function applyRule(apiKey, excludedTabIds = []) {
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
              excludedTabIds,
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

async function currentApiKey() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  return apiKey || "";
}

chrome.runtime.onInstalled.addListener(async () => {
  applyRule(await currentApiKey());
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "local" && "apiKey" in changes) {
    const { harvest } = await chrome.storage.local.get("harvest");
    const excluded = harvest && harvest.tabId && harvest.status !== "done" && harvest.status !== "timeout"
      ? [harvest.tabId]
      : [];
    applyRule(changes.apiKey.newValue || "", excluded);
  }
});

// ── Harvest flow ──────────────────────────────────────────────────────────
// Opens the rembayung widget in its own tab, excluded from our own header
// injection rule, waits out Cloudflare ("just a moment" title), then
// sniffs the venue-api-key the widget's own JS attaches to its real
// request — that's the freshest live key, not whatever we last saved.

async function setHarvest(patch) {
  const { harvest = {} } = await chrome.storage.local.get("harvest");
  const next = { ...harvest, ...patch };
  await chrome.storage.local.set({ harvest: next });
  return next;
}

async function startHarvest() {
  const apiKey = await currentApiKey();
  await setHarvest({ status: "opening", key: "", tabId: null, startedAt: Date.now() });

  const tab = await chrome.tabs.create({ url: HARVEST_URL, active: true });
  await applyRule(apiKey, [tab.id]); // don't let our own rule mask the real key
  await setHarvest({ status: "waiting-cf", tabId: tab.id });

  setTimeout(async () => {
    const { harvest } = await chrome.storage.local.get("harvest");
    if (harvest && harvest.tabId === tab.id && harvest.status !== "done") {
      await setHarvest({ status: "timeout" });
      await applyRule(await currentApiKey(), []); // restore normal injection
    }
  }, CF_TIMEOUT_MS);
}

function clickReserveButtonInPage() {
  return new Promise((resolve) => {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").trim().toLowerCase().includes("make a reservation")
      );
      if (btn) {
        btn.click();
        clearInterval(iv);
        resolve(true);
      } else if (tries > 20) {
        clearInterval(iv);
        resolve(false);
      }
    }, 500);
  });
}

async function autoClickReserve(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: clickReserveButtonInPage,
    });
  } catch (e) {
    // tab may have navigated/closed — harvest timeout will catch it
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const { harvest } = await chrome.storage.local.get("harvest");
  if (!harvest || harvest.tabId !== tabId || !changeInfo.title) return;
  const t = changeInfo.title.toLowerCase();
  const cf = t.includes("just a moment") || t.includes("checking your browser");
  if (!cf && harvest.status === "waiting-cf") {
    await setHarvest({ status: "capturing" });
    autoClickReserve(tabId);
  }
});

chrome.webRequest.onSendHeaders.addListener(
  async (details) => {
    const { harvest } = await chrome.storage.local.get("harvest");
    if (!harvest || harvest.tabId !== details.tabId || harvest.status === "done") return;
    const h = (details.requestHeaders || []).find(
      (x) => x.name.toLowerCase() === "venue-api-key"
    );
    if (h && h.value) {
      await setHarvest({ status: "done", key: h.value });
      await applyRule(await currentApiKey(), []); // restore normal injection for that tab
    }
  },
  { urls: ["*://*.umai.io/*", "*://*.letsumai.com/*"] },
  ["requestHeaders"]
);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { harvest } = await chrome.storage.local.get("harvest");
  if (harvest && harvest.tabId === tabId && harvest.status !== "done") {
    await setHarvest({ status: "timeout" });
    await applyRule(await currentApiKey(), []);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg === "startHarvest") startHarvest();
});
