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
    // Log every API call URL so we can identify the real endpoint domain
    if (details.url.includes("/widget/api/")) {
      console.log("[WEBREQ]", details.method, details.url);
    }
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

async function tryFillOTPInTab(tabId, code) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: function (otpCode) {
        // Split-box OTP modal (.um-otp-input__box — one digit per box)
        const boxes = document.querySelectorAll(".um-otp-input__box");
        if (boxes.length >= 2) {
          const digits = otpCode.split("");
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
          ).set;

          // Try filling first box with full code (React may auto-split on paste)
          boxes[0].focus();
          setter.call(boxes[0], otpCode);
          boxes[0].dispatchEvent(new InputEvent("input", { bubbles: true, data: otpCode }));
          boxes[0].dispatchEvent(new Event("change", { bubbles: true }));

          // Check if React split it; if not, fill each box individually
          const allFilled = Array.from(boxes).every(
            (b, i) => b.value === (digits[i] || "")
          );
          if (!allFilled) {
            boxes.forEach((box, i) => {
              box.focus();
              setter.call(box, digits[i] || "");
              box.dispatchEvent(
                new InputEvent("input", { bubbles: true, data: digits[i] || "" })
              );
              box.dispatchEvent(new Event("change", { bubbles: true }));
            });
          }

          // Click confirm — poll until enabled (React enables it after state update)
          const btn = document.querySelector(
            "button.um-email-otp__confirm, button.um-dialog__button--confirm"
          );
          if (btn) {
            if (!btn.disabled) {
              btn.click();
            } else {
              let tries = 0;
              const iv = setInterval(() => {
                tries++;
                if (!btn.disabled) {
                  btn.click();
                  clearInterval(iv);
                } else if (tries > 40) {
                  clearInterval(iv);
                }
              }, 200);
            }
          }
          return true;
        }

        // Fallback: single-field OTP
        const field = document.querySelector(
          "#um-field--email-otp, #um-field--otp, input[id*='otp' i], " +
          "input[name*='otp' i], input[placeholder*='verification' i]"
        );
        if (!field) return false;
        const setter2 = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        ).set;
        setter2.call(field, otpCode);
        field.dispatchEvent(new InputEvent("input", { bubbles: true, data: otpCode }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        const btn2 = document.querySelector(
          "footer.ums-footer button[type='submit'], button[type='submit']"
        );
        if (btn2) btn2.click();
        return true;
      },
      args: [code],
      world: "MAIN",
    });
    return results && results[0] && results[0].result === true;
  } catch (_) {
    return false;
  }
}

function watchAndFillOTP(code) {
  const deadline = Date.now() + 60000; // 60s window — modal may take time to appear
  let done = false;

  async function tick() {
    if (done || Date.now() > deadline) return;
    const tabs = await chrome.tabs.query({
      url: ["https://*.umai.io/*", "https://*.letsumai.com/*"],
    });
    for (const tab of tabs) {
      const filled = await tryFillOTPInTab(tab.id, code);
      if (filled) {
        console.log("[OTP] Auto-filled into tab", tab.id, tab.url);
        done = true;
        return;
      }
    }
    setTimeout(tick, 800);
  }

  tick();
}

async function requestOTP() {
  const { apiKey, huntConfig } = await chrome.storage.local.get(["apiKey", "huntConfig"]);
  const email = huntConfig && huntConfig.email;
  console.log("[OTP] requestOTP start — email:", email, "apiKey len:", (apiKey || "").length);
  if (!email) return { ok: false, msg: "No email set — open Configure hunt and fill email first." };

  const umiTabs = await chrome.tabs.query({
    url: ["https://*.umai.io/*", "https://*.letsumai.com/*"],
  });
  console.log("[OTP] UMAI tabs found:", umiTabs.length, umiTabs.map(t => t.url));

  // Use native host: send OTP + read code from IMAP in one call
  console.log("[OTP] Sending + reading via native host...");
  const { huntConfig: cfg } = await chrome.storage.local.get("huntConfig");
  try {
    const nativeResult = await new Promise((resolve) => {
      chrome.runtime.sendNativeMessage(
        "com.umai.otp_helper",
        {
          action: "send_and_read_otp",
          api_url: "https://letsumai.com/widget/api/v2/email_otps",
          venue_api_key: apiKey || "",
          email,
          imap_host: (cfg && cfg.imapHost) || "imap.gmail.com",
          imap_user: (cfg && cfg.imapUser) || email,
          imap_password: (cfg && cfg.imapPassword) || "",
          timeout: 120,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.log("[OTP] Native msg error:", chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(response || null);
          }
        }
      );
    });
    console.log("[OTP] Native result:", JSON.stringify(nativeResult));
    if (nativeResult) {
      if (nativeResult.ok && nativeResult.code) {
        const code = nativeResult.code;
        await chrome.storage.local.set({
          otpTriggerTs: Date.now(),
          otpCode: { code, ts: Date.now() },
        });
        // Watch UMAI tabs for OTP field to appear and auto-fill (30s window)
        watchAndFillOTP(code);
        return { ok: true, msg: `OTP received — will auto-fill when form appears.` };
      }
      return { ok: false, msg: nativeResult.error || `Failed: ${(nativeResult.body || "").slice(0, 120)}` };
    }
  } catch (e) {
    console.log("[OTP] Native threw:", e && e.message ? e.message : String(e));
  }

  return {
    ok: false,
    msg: "Native host unavailable — run install_native.bat first, then reload extension",
  };
}

async function requestOTPBackground() {
  // Same as requestOTP but just returns { code } for the fetch interceptor
  const { apiKey, huntConfig } = await chrome.storage.local.get(["apiKey", "huntConfig"]);
  const email = huntConfig && huntConfig.email;
  if (!email) return { code: null, error: "No email configured" };

  const cfg = huntConfig;
  try {
    const nativeResult = await new Promise((resolve) => {
      chrome.runtime.sendNativeMessage(
        "com.umai.otp_helper",
        {
          action: "send_and_read_otp",
          api_url: "https://letsumai.com/widget/api/v2/email_otps",
          venue_api_key: apiKey || "",
          email,
          imap_host: (cfg && cfg.imapHost) || "imap.gmail.com",
          imap_user: (cfg && cfg.imapUser) || email,
          imap_password: (cfg && cfg.imapPassword) || "",
          timeout: 120,
        },
        (response) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response || null);
        }
      );
    });
    if (nativeResult && nativeResult.ok && nativeResult.code) {
      const code = nativeResult.code;
      await chrome.storage.local.set({ otpCode: { code, ts: Date.now() } });
      return { code };
    }
    return { code: null, error: nativeResult && nativeResult.error };
  } catch (e) {
    return { code: null, error: String(e) };
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
  if (msg === "requestOTPBackground") {
    requestOTPBackground().then(sendResponse);
    return true;
  }
});
