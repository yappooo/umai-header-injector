// Maintains one declarativeNetRequest rule that stamps venue-api-key
// (plus Origin/Referer) onto UMAI API calls. Stripe traffic is excluded
// via excludedRequestDomains so payment requests stay untouched.
//
// NOTE: tabIds/excludedTabIds conditions are only valid on session-scoped
// rules, not on rules added via updateDynamicRules. Putting them on a
// dynamic rule makes the whole updateDynamicRules call fail silently, so
// keep this rule's condition tabId-free.
importScripts("hunt.js");

const RULE_ID = 1;
const HARVEST_URL = "https://reservation.umai.io/en/widget/rembayung";
const CF_TIMEOUT_MS = 45000;

function isCloudflareTitle(title) {
  const t = (title || "").toLowerCase();
  return (
    t.includes("just a moment") ||
    t.includes("checking your browser") ||
    t.includes("waiting room") ||
    t.includes("attention required") ||
    t.includes("cloudflare")
  );
}

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

async function currentApiKey() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  return apiKey || "";
}

chrome.runtime.onInstalled.addListener(async () => {
  applyRule(await currentApiKey());
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "local" && "apiKey" in changes) {
    applyRule(changes.apiKey.newValue || "");
  }
});

// ── Harvest flow ──────────────────────────────────────────────────────────
// Opens the rembayung widget in its own tab, waits out Cloudflare ("just a
// moment" title), clicks through to the booking flow, then sniffs the
// venue-api-key the widget's own JS attaches to its real request — the
// freshest live key, not whatever we last saved. Our own injection rule is
// pulled entirely for the few seconds this takes (it can't be scoped to a
// single tab on a dynamic rule), then restored once we have the key.

async function setHarvest(patch) {
  const { harvest = {} } = await chrome.storage.local.get("harvest");
  const next = { ...harvest, ...patch };
  await chrome.storage.local.set({ harvest: next });
  return next;
}

async function restoreRule() {
  await applyRule(await currentApiKey());
}

async function startHarvest() {
  await setHarvest({ status: "opening", key: "", tabId: null, startedAt: Date.now() });
  await applyRule(""); // pull injection so the real key isn't masked

  const tab = await chrome.tabs.create({ url: HARVEST_URL, active: true });
  await setHarvest({ status: "waiting-cf", tabId: tab.id });

  setTimeout(async () => {
    const { harvest } = await chrome.storage.local.get("harvest");
    if (harvest && harvest.tabId === tab.id && harvest.status !== "done") {
      await setHarvest({ status: "timeout" });
      await restoreRule();
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

chrome.webRequest.onSendHeaders.addListener(
  async (details) => {
    const { harvest } = await chrome.storage.local.get("harvest");
    if (!harvest || harvest.tabId !== details.tabId || harvest.status === "done") return;
    const h = (details.requestHeaders || []).find(
      (x) => x.name.toLowerCase() === "venue-api-key"
    );
    if (h && h.value) {
      await setHarvest({ status: "done", key: h.value });
      await restoreRule();
    }
  },
  { urls: ["*://*.umai.io/*", "*://*.letsumai.com/*"] },
  ["requestHeaders"]
);

// ── Shared tab lifecycle listeners ───────────────────────────────────────
// One listener each for onUpdated/onRemoved, branching on which flow (if
// any) owns the tab — harvest and hunt never run on the same tab at once.

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.title) return;
  const cf = isCloudflareTitle(changeInfo.title);

  const { harvest } = await chrome.storage.local.get("harvest");
  if (harvest && harvest.tabId === tabId) {
    if (!cf && harvest.status === "waiting-cf") {
      await setHarvest({ status: "capturing" });
      autoClickReserve(tabId);
    }
    return;
  }

  if (typeof onHuntTabTitleUpdated === "function") {
    await onHuntTabTitleUpdated(tabId, cf);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { harvest } = await chrome.storage.local.get("harvest");
  if (harvest && harvest.tabId === tabId && harvest.status !== "done") {
    await setHarvest({ status: "timeout" });
    await restoreRule();
    return;
  }
  if (typeof onHuntTabRemoved === "function") {
    await onHuntTabRemoved(tabId);
  }
});

async function requestOTP() {
  const { apiKey, huntConfig } = await chrome.storage.local.get(["apiKey", "huntConfig"]);
  const email = huntConfig && huntConfig.email;
  console.log("[OTP] requestOTP start — email:", email, "apiKey len:", (apiKey || "").length);
  if (!email) return { ok: false, msg: "No email set — open Configure hunt and fill email first." };

  const umiTabs = await chrome.tabs.query({
    url: ["https://*.umai.io/*", "https://*.letsumai.com/*"],
  });
  console.log("[OTP] UMAI tabs found:", umiTabs.length, umiTabs.map(t => t.url));

  if (umiTabs.length > 0) {
    console.log("[OTP] Firing from tab", umiTabs[0].id, umiTabs[0].url);
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: umiTabs[0].id },
        func: function (emailAddr, venueApiKey) {
          return fetch("https://api.letsumai.com/widget/api/v2/email_otps", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "venue-api-key": venueApiKey || "",
            },
            body: JSON.stringify({ email: emailAddr, locale: "en" }),
          })
            .then((r) => r.text().then((body) => ({ status: r.status, body })))
            .catch((e) => ({ status: 0, body: String(e && e.message ? e.message : e) }));
        },
        args: [email, apiKey || ""],
      });
      console.log("[OTP] executeScript results:", JSON.stringify(results));
      const res = results && results[0] && results[0].result;
      if (res) {
        const ok = [200, 201, 204].includes(res.status);
        if (ok) await chrome.storage.local.set({ otpTriggerTs: Date.now() });
        const msg = ok
          ? `OTP sent to ${email}`
          : `Failed ${res.status}: ${(res.body || "").slice(0, 120)}`;
        console.log("[OTP] page fetch result:", msg);
        return { ok, status: res.status, msg };
      }
      console.log("[OTP] executeScript returned no result");
    } catch (e) {
      console.log("[OTP] executeScript threw:", e && e.message ? e.message : String(e));
    }
  }

  // Fallback: direct service worker fetch
  console.log("[OTP] Trying direct SW fetch...");
  try {
    const res = await fetch("https://api.letsumai.com/widget/api/v2/email_otps", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "venue-api-key": apiKey || "",
      },
      body: JSON.stringify({ email, locale: "en" }),
    });
    const body = await res.text();
    console.log("[OTP] SW fetch status:", res.status, "body:", body.slice(0, 120));
    const ok = [200, 201, 204].includes(res.status);
    if (ok) await chrome.storage.local.set({ otpTriggerTs: Date.now() });
    return {
      ok,
      status: res.status,
      msg: ok ? `OTP sent to ${email}` : `Failed ${res.status}: ${body.slice(0, 100)}`,
    };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    console.log("[OTP] SW fetch threw:", msg);
    return { ok: false, msg: `${msg} — open the UMAI widget tab first, then try again` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg === "startHarvest") startHarvest();
  if (msg === "startHunt" && typeof startHunt === "function") startHunt();
  if (msg === "stopHunt" && typeof stopHunt === "function") stopHunt();
  if (msg === "requestOTP") {
    requestOTP().then(sendResponse);
    return true;
  }
});
