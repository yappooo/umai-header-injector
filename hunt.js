// hunt.js — UI-click booking automation for the UMAI widget. Loaded via
// importScripts() from background.js (shares its global scope, so helpers
// like isCloudflareTitle/setHunt-style storage patterns are reused as-is).
//
// Ports the old Playwright bot's click-emulation flow (poll for slots ->
// click best match -> fill contact form -> submit -> stop at Stripe
// checkout for manual pay) to chrome.scripting.executeScript calls driven
// by one async loop here in the service worker, instead of an external
// browser-automation process.
//
// Known MV3 limitation: if the service worker is evicted mid-hunt (it can
// happen after ~30s of no extension-API activity), the in-memory loop dies
// and won't resume on its own. chrome.storage.local["hunt"] is checkpointed
// at every state transition so the popup always shows the last known status,
// but a dead loop needs the user to hit START again. The frequent
// chrome.storage/chrome.tabs/chrome.scripting calls inside the loop (every
// few hundred ms to a few seconds) count as activity and keep the worker
// alive in practice for a normal hunt session.

const HUNT_TIMEOUT_MS = 15 * 60 * 1000;
const PAX_FALLBACK_LIST = [3, 4, 5, 6, 8];

let huntStopRequested = false;
let huntRunToken = 0;

async function getHuntConfig() {
  const { huntConfig } = await chrome.storage.local.get("huntConfig");
  return huntConfig || null;
}

async function setHunt(patch, logMsg) {
  const { hunt = {} } = await chrome.storage.local.get("hunt");
  const log = hunt.log ? hunt.log.slice(-49) : [];
  if (logMsg) {
    log.push({ t: Date.now(), msg: logMsg });
    console.log("[HUNT]", logMsg);
  }
  const next = { ...hunt, ...patch, log };
  await chrome.storage.local.set({ hunt: next });
  return next;
}

function buildWidgetUrl(cfg, pax) {
  return `${cfg.widgetUrl}?party_size=${pax}&date=${cfg.targetDate}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

async function exec(tabId, func, args = [], frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId };
  try {
    const results = await chrome.scripting.executeScript({ target, func, args });
    return results && results[0] ? results[0].result : undefined;
  } catch (e) {
    // Frame removed / tab navigating — treat as "not ready yet", caller handles undefined
    const msg = (e && e.message) || String(e);
    if (
      msg.includes("Frame with ID") ||
      msg.includes("Cannot access") ||
      msg.includes("No tab with id") ||
      msg.includes("The tab was closed")
    ) {
      console.log("[HUNT] exec swallowed transient error:", msg);
      return undefined;
    }
    throw e;
  }
}

async function notifyHuntResult(kind, detail) {
  try {
    await chrome.notifications.create(`hunt-${kind}-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title:
        kind === "success"
          ? "UMAI slot booked!"
          : kind === "timeout"
          ? "UMAI hunt timed out"
          : "UMAI hunt failed",
      message: detail || "",
    });
  } catch (e) {
    // notifications permission issue — non-fatal, status is still in storage
  }
  try {
    await chrome.action.setBadgeText({ text: kind === "success" ? "OK" : "ERR" });
    await chrome.action.setBadgeBackgroundColor({
      color: kind === "success" ? "#1b5e20" : "#b71c1c",
    });
  } catch (e) {}
}

// ── Injected (page-context) step functions ──────────────────────────────
// Each is a plain, self-contained function — chrome.scripting.executeScript
// serializes and runs it inside the target tab/frame, so it can't close over
// anything from hunt.js. Data goes in via the `args` array, comes back as the
// function's return value (or resolved Promise value).

function checkClosedDayInPage() {
  const el = document.querySelector(".um-day-closed__title");
  if (el) return { closed: true, text: (el.textContent || "").trim() };
  return { closed: false };
}

// Diagnostic only — used when the primary selector finds zero slot buttons,
// to report what the real DOM looks like on a venue/widget version whose
// class names differ from rembayung's (e.g. button.um-timeslot__button).
function debugFindTimeButtonsInPage() {
  const timeRe = /\b\d{1,2}:\d{2}\s*(AM|PM)?\b/i;
  const candidates = Array.from(document.querySelectorAll("button, [role='button']"))
    .filter((el) => timeRe.test((el.textContent || "").trim()))
    .slice(0, 15)
    .map((el) => ({
      tag: el.tagName,
      className: el.className,
      text: (el.textContent || "").trim().slice(0, 40),
    }));
  return { count: candidates.length, candidates };
}

// Widget is a React SPA — slots aren't in the DOM yet right after
// navigation/reload, they show up once the page's own JS finishes its
// slots API call. Poll for up to ~4s (matches the old bot's
// wait_for_selector(..., timeout=3000) before giving up) rather than taking
// a single immediate snapshot.
function pollSlotsInPage(opts) {
  // Slot buttons don't reliably carry the .um-timeslot__button/.um-timeslot
  // class on every venue's widget build — but the time text itself is
  // always in a child .um-timeslot__time span. Anchor on that span and walk
  // up to its clickable ancestor instead of trusting the outer class name.
  function findButtons() {
    const timeSpans = Array.from(document.querySelectorAll(".um-timeslot__time"));
    let buttons = timeSpans
      .map((span) => span.closest("button, [role='button']") || span.parentElement)
      .filter(Boolean);
    if (buttons.length === 0) {
      buttons = Array.from(
        document.querySelectorAll("button.um-timeslot__button, .um-timeslot")
      );
    }
    return buttons;
  }

  function snapshot() {
    const buttons = findButtons();
    const closedEl = document.querySelector(".um-day-closed__title");
    return { buttons, closed: !!closedEl };
  }

  function parseTime(text) {
    const clean = text.trim().toUpperCase();
    const ampm = clean.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
    if (ampm) {
      let h = parseInt(ampm[1], 10);
      const m = parseInt(ampm[2], 10);
      const suffix = ampm[3];
      if (suffix === "PM" && h !== 12) h += 12;
      if (suffix === "AM" && h === 12) h = 0;
      return { h, m };
    }
    const plain = clean.match(/^(\d{1,2}):(\d{2})$/);
    if (plain) return { h: parseInt(plain[1], 10), m: parseInt(plain[2], 10) };
    return null;
  }

  function buildResult(buttons) {
    const seenTimes = [];
    const valid = [];
    const idealTotal = opts.idealH * 60 + opts.idealM;

    buttons.forEach((btn) => {
      const timeSpan = btn.querySelector(".um-timeslot__time");
      const text = (timeSpan ? timeSpan.textContent : btn.textContent || "").trim();
      if (!text.includes(":")) return;
      seenTimes.push(text.toUpperCase());

      if (opts.noTakeaway) {
        const section = btn.closest("section");
        const label = section ? (section.getAttribute("aria-label") || "").toUpperCase() : "";
        if (label.includes("TAKEAWAY")) return;
      }

      const t = parseTime(text);
      if (!t) return;
      if (t.h < opts.startH || t.h > opts.endH) return;

      const diff = Math.abs(idealTotal - (t.h * 60 + t.m));
      valid.push({ text, diff });
    });

    valid.sort((a, b) => a.diff - b.diff);
    const best = valid[0];
    return {
      slotsFound: buttons.length,
      seenTimes,
      bestSlotText: best ? best.text : "",
    };
  }

  return new Promise((resolve) => {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const { buttons, closed } = snapshot();
      const result = buildResult(buttons);
      // Buttons can exist before their time text renders (skeleton/loading
      // state) — don't resolve on bare button presence, wait for at least
      // one to actually carry parseable time text, or give up at timeout.
      if (closed || result.seenTimes.length > 0 || tries > 20) {
        clearInterval(iv);
        resolve(result);
      }
    }, 200);
  });
}

function clickSlotInPage(slotText) {
  const timeSpans = Array.from(document.querySelectorAll(".um-timeslot__time"));
  let buttons = timeSpans
    .map((span) => span.closest("button, [role='button']") || span.parentElement)
    .filter(Boolean);
  if (buttons.length === 0) {
    buttons = Array.from(
      document.querySelectorAll("button.um-timeslot__button, .um-timeslot")
    );
  }
  const btn = buttons.find((b) => {
    const timeSpan = b.querySelector(".um-timeslot__time");
    const text = (timeSpan ? timeSpan.textContent : b.textContent || "").trim();
    return text === slotText;
  });
  if (!btn) return { clicked: false };
  btn.click();
  const confirmBtn = document.querySelector("button.um-dialog__button--confirm");
  if (confirmBtn) confirmBtn.click();
  return { clicked: true };
}

function verifySlotSecuredInPage() {
  return new Promise((resolve) => {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const form = document.querySelector("#um-field--first-name");
      const err = document.querySelector(".um-widget-error");
      if (form) {
        clearInterval(iv);
        resolve({ secured: true, lost: false });
      } else if (err) {
        clearInterval(iv);
        resolve({ secured: false, lost: true, errorText: (err.textContent || "").trim() });
      } else if (tries > 10) {
        clearInterval(iv);
        resolve({ secured: false, lost: false });
      }
    }, 100);
  });
}

function fillContactFormInPage(contact) {
  function setVal(sel, val) {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  const fnameEl = document.querySelector("#um-field--first-name");
  const already = !!(fnameEl && fnameEl.value && fnameEl.value.trim() !== "");
  if (!already) {
    setVal("#um-field--first-name", contact.fname);
    setVal("#um-field--last-name", contact.lname);
    setVal("#um-field--email", contact.email);
    setVal("#um-field--phone-number", contact.phone);
  }
  const cb = document.querySelector("#um-field-checkbox");
  if (cb && !cb.checked) {
    cb.click();
    cb.dispatchEvent(new Event("change", { bubbles: true }));
    cb.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return { filled: !already };
}

function submitCheckoutInPage() {
  const btn = document.querySelector(
    "footer.ums-footer button[type='submit'], button[type='submit']"
  );
  const clicked = !!btn;
  if (btn) btn.click();
  return new Promise((resolve) => {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const err = document.querySelector(".um-widget-error");
      const frame = document.querySelector(
        "iframe[title*='Secure payment input frame' i], iframe[title*='stripe' i], iframe[src*='stripe.com'], iframe[src*='js.stripe.com']"
      );
      const otpField = document.querySelector(
        "#um-field--email-otp, #um-field--otp, input[id*='otp' i], input[name*='otp' i], input[placeholder*='otp' i], input[placeholder*='verification' i], input[placeholder*='passcode' i]"
      );
      if (err) {
        clearInterval(iv);
        resolve({ lost: true, errorText: (err.textContent || "").trim() });
      } else if (frame) {
        clearInterval(iv);
        resolve({ stripeIframePresent: true });
      } else if (otpField) {
        clearInterval(iv);
        resolve({ otpRequired: true });
      } else if (tries > 100) {
        clearInterval(iv);
        const allIframes = Array.from(document.querySelectorAll("iframe")).map(
          (f) => ({ title: f.title, src: (f.src || "").slice(0, 80) })
        );
        resolve({
          stripeIframePresent: false,
          submitButtonClicked: clicked,
          debugIframes: allIframes,
        });
      }
    }, 100);
  });
}

function fillOTPInPage(code) {
  const field = document.querySelector(
    "#um-field--email-otp, #um-field--otp, input[id*='otp' i], input[name*='otp' i], input[placeholder*='otp' i], input[placeholder*='verification' i], input[placeholder*='passcode' i]"
  );
  if (!field) return { filled: false };
  field.value = code;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  return { filled: true };
}

function waitForStripeAfterOTPInPage() {
  // After filling OTP and clicking submit, wait for Stripe or error
  const btn = document.querySelector(
    "footer.ums-footer button[type='submit'], button[type='submit']"
  );
  if (btn) btn.click();
  return new Promise((resolve) => {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const err = document.querySelector(".um-widget-error");
      const frame = document.querySelector(
        "iframe[title*='Secure payment input frame' i], iframe[title*='stripe' i], iframe[src*='stripe.com'], iframe[src*='js.stripe.com']"
      );
      if (err) {
        clearInterval(iv);
        resolve({ lost: true, errorText: (err.textContent || "").trim() });
      } else if (frame) {
        clearInterval(iv);
        resolve({ stripeIframePresent: true });
      } else if (tries > 100) {
        clearInterval(iv);
        resolve({ stripeIframePresent: false });
      }
    }, 100);
  });
}

// ── Native OTP reader ────────────────────────────────────────────────────
// Calls otp_helper.py via Chrome native messaging (install_native.bat sets it up).
// Returns { ok, code } or null on error.
async function readOTPViaNative(cfg, afterTs) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(
        "com.umai.otp_helper",
        {
          action: "send_and_read_otp",
          api_url: "https://letsumai.com/widget/api/v2/email_otps",
          venue_api_key: apiKey || "",
          email: cfg.email || "",
          imap_host: cfg.imapHost || "imap.gmail.com",
          imap_user: cfg.imapUser || cfg.email || "",
          imap_password: cfg.imapPassword || "",
          after_ts: afterTs || Date.now() - 60000,
          timeout: 120,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.log("[OTP] Native messaging error:", chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(response || null);
        }
      );
    } catch (e) {
      console.log("[OTP] sendNativeMessage exception:", e);
      resolve(null);
    }
  });
}

// ── Orchestration ─────────────────────────────────────────────────────────

async function startHunt() {
  const cfg = await getHuntConfig();
  if (!cfg || !cfg.widgetUrl || !cfg.targetDate || !cfg.pax) {
    await setHunt({ status: "failed", detail: "Missing hunt config — open options first." });
    return;
  }

  huntStopRequested = false;
  const myToken = ++huntRunToken;

  // fresh log for this run
  await chrome.storage.local.set({
    hunt: {
      status: "opening",
      tabId: null,
      startedAt: Date.now(),
      currentPax: Number(cfg.pax),
      bestSlotText: "",
      detail: "",
      log: [{ t: Date.now(), msg: `Starting hunt: ${cfg.widgetUrl} date=${cfg.targetDate} pax=${cfg.pax}` }],
    },
  });

  const tab = await chrome.tabs.create({ url: buildWidgetUrl(cfg, cfg.pax), active: true });
  await setHunt({ status: "waiting-cf", tabId: tab.id }, `Tab ${tab.id} opened, waiting for Cloudflare...`);

  runHuntLoop(tab.id, myToken, cfg).catch(async (e) => {
    if (huntRunToken === myToken) {
      await setHunt({ status: "failed", detail: String(e && e.message ? e.message : e) });
      await notifyHuntResult("failed", String(e));
    }
  });
}

async function stopHunt() {
  huntStopRequested = true;
  await setHunt({ status: "stopped" }, "Stopped by user.");
}

async function onHuntTabTitleUpdated(tabId, cf) {
  const { hunt } = await chrome.storage.local.get("hunt");
  if (!hunt || hunt.tabId !== tabId) return;
  if (!cf && hunt.status === "waiting-cf") {
    await setHunt({ status: "polling-slots" }, "Cloudflare cleared (title check).");
  } else if (cf && hunt.status !== "waiting-cf" && hunt.status !== "success") {
    await setHunt({ status: "waiting-cf" }, "Cloudflare challenge reappeared.");
  }
}

async function onHuntTabRemoved(tabId) {
  const { hunt } = await chrome.storage.local.get("hunt");
  if (
    hunt &&
    hunt.tabId === tabId &&
    !["success", "stopped", "failed", "timeout"].includes(hunt.status)
  ) {
    await setHunt({ status: "failed", detail: "Tab closed unexpectedly." });
  }
}

async function waitForCfClear(tabId, myToken, deadline) {
  while (true) {
    if (huntStopRequested || huntRunToken !== myToken) return false;
    if (Date.now() > deadline) return false;
    const { hunt } = await chrome.storage.local.get("hunt");
    if (!hunt || hunt.tabId !== tabId) return false;
    if (hunt.status !== "waiting-cf") return true;
    await sleep(500);
  }
}

async function runHuntLoop(tabId, myToken, cfg) {
  const deadline = Date.now() + HUNT_TIMEOUT_MS;

  const cleared = await waitForCfClear(tabId, myToken, deadline);
  if (!cleared) {
    if (huntRunToken === myToken && !huntStopRequested) {
      await setHunt({ status: "timeout", detail: "Cloudflare never cleared." });
      await notifyHuntResult("timeout", "Cloudflare never cleared.");
    }
    return;
  }

  // Small grace period — page finishes its final navigation after CF clears
  await sleep(1200);

  let currentPax = Number(cfg.pax);
  let paxFallback = PAX_FALLBACK_LIST.filter((p) => p !== currentPax);
  let noSlotCount = 0;

  while (true) {
    if (huntStopRequested || huntRunToken !== myToken) return;
    if (Date.now() > deadline) {
      await setHunt({ status: "timeout", detail: "15-minute hunt cutoff reached." });
      await notifyHuntResult("timeout", "15-minute hunt cutoff reached.");
      return;
    }

    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (e) {
      await setHunt({ status: "failed", detail: "Tab no longer exists." }, "Tab no longer exists — aborting.");
      return;
    }

    if ((tab.url || "").includes("/block/")) {
      await setHunt({ status: "blocked-queue" }, `Queue not open yet (url: ${tab.url}). Waiting...`);
      await sleep(randomBetween(3000, 5000));
      if (!cfg.disableAutoRefresh) {
        await chrome.tabs.update(tabId, { url: buildWidgetUrl(cfg, currentPax) });
        await sleep(800);
      }
      continue;
    }

    if (isCloudflareTitle(tab.title)) {
      await setHunt({ status: "waiting-cf" }, `Cloudflare title detected: "${tab.title}".`);
      await sleep(1000);
      continue;
    }

    const closed = await exec(tabId, checkClosedDayInPage);
    if (closed && closed.closed) {
      if (cfg.disableAutoRefresh) {
        await setHunt({ status: "polling-slots", detail: closed.text }, `Day closed: ${closed.text}. Waiting for manual refresh...`);
        await sleep(randomBetween(2000, 3000));
      } else {
        await setHunt({ status: "polling-slots", detail: closed.text }, `Day closed: ${closed.text}. Reloading...`);
        await sleep(randomBetween(500, 1000));
        await chrome.tabs.reload(tabId);
        await sleep(800);
      }
      continue;
    }

    await setHunt({ status: "polling-slots" }, `Polling slots (url: ${tab.url}, pax: ${currentPax})...`);
    const slotResult = await exec(tabId, pollSlotsInPage, [
      {
        startH: Number(cfg.startH),
        endH: Number(cfg.endH),
        idealH: Number(cfg.idealH),
        idealM: Number(cfg.idealM),
        noTakeaway: !!cfg.noTakeaway,
      },
    ]);

    const pollMs = Math.max(300, Number(cfg.pollIntervalMs) || 1000);

    if (!slotResult || slotResult.slotsFound === 0) {
      const debug = await exec(tabId, debugFindTimeButtonsInPage);
      const reloadSuffix = cfg.disableAutoRefresh ? "Waiting for manual refresh..." : "Reloading...";
      const msg =
        debug && debug.count > 0
          ? `No match on button.um-timeslot__button/.um-timeslot, but found ${debug.count} time-like buttons with class(es): ${[
              ...new Set(debug.candidates.map((c) => c.className || "(none)")),
            ].join(" | ")}`
          : `No slot buttons on page yet. ${reloadSuffix}`;
      await setHunt({}, msg);
      if (cfg.disableAutoRefresh) {
        await sleep(randomBetween(pollMs * 2, pollMs * 3));
      } else {
        await sleep(randomBetween(pollMs * 2.5, pollMs * 4.5));
        await chrome.tabs.reload(tabId);
        await sleep(800);
      }
      continue;
    }

    if (!slotResult.bestSlotText) {
      noSlotCount++;
      await setHunt(
        {},
        `Saw [${(slotResult.seenTimes || []).join(", ")}] — none match pax ${currentPax}/window ${cfg.startH}-${cfg.endH}h (${noSlotCount}/3).`
      );
      if (noSlotCount >= 3) {
        noSlotCount = 0;
        if (!cfg.disableAutoRefresh) {
          if (paxFallback.length > 0) {
            currentPax = paxFallback.shift();
          } else {
            currentPax = Number(cfg.pax);
            paxFallback = PAX_FALLBACK_LIST.filter((p) => p !== currentPax);
          }
          await setHunt({ currentPax }, `Pax fallback: switching to pax ${currentPax}.`);
          await chrome.tabs.update(tabId, { url: buildWidgetUrl(cfg, currentPax) });
          await sleep(800);
        } else {
          await setHunt({}, `No match 3x — skipping pax fallback (manual refresh mode). Waiting...`);
          await sleep(randomBetween(pollMs * 2, pollMs * 3));
        }
        continue;
      }
      if (cfg.disableAutoRefresh) {
        await setHunt({}, `No slot in window [${cfg.startH}-${cfg.endH}h]. Waiting for manual refresh...`);
        await sleep(randomBetween(pollMs * 1.5, pollMs * 2.5));
      } else {
        await sleep(randomBetween(pollMs * 1.5, pollMs * 2.5));
        await chrome.tabs.reload(tabId);
        await sleep(800);
      }
      continue;
    }

    // slot found — click + verify, retry up to 3x
    await setHunt(
      { status: "clicking-slot", bestSlotText: slotResult.bestSlotText },
      `Match found: ${slotResult.bestSlotText}. Clicking...`
    );
    let secured = false;
    let lost = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await exec(tabId, clickSlotInPage, [slotResult.bestSlotText]);
      await setHunt({ status: "verifying-click" }, `Click attempt ${attempt + 1}/3 — verifying...`);
      const verify = await exec(tabId, verifySlotSecuredInPage);
      if (verify && verify.secured) {
        secured = true;
        await setHunt({}, "Slot secured — contact form visible.");
        break;
      }
      if (verify && verify.lost) {
        lost = true;
        await setHunt({}, `Slot lost: ${verify.errorText || "widget error"}.`);
        break;
      }
      await sleep(300);
    }

    if (lost) {
      if (cfg.disableAutoRefresh) {
        await setHunt({ status: "slot-lost-retry" }, "Slot lost — waiting for manual refresh to re-hunt...");
        await sleep(randomBetween(1500, 2500));
      } else {
        await setHunt({ status: "slot-lost-retry" }, "Reloading to re-hunt after lost slot...");
        await sleep(randomBetween(500, 1000));
        await chrome.tabs.reload(tabId);
        await sleep(800);
      }
      continue;
    }
    if (!secured) {
      await setHunt({}, "Click did not register (no form, no error). Retrying loop...");
      await sleep(500);
      continue;
    }

    // contact form
    await setHunt({ status: "form-filling" }, "Filling contact form...");
    const fillResult = await exec(tabId, fillContactFormInPage, [
      { fname: cfg.fname, lname: cfg.lname, email: cfg.email, phone: cfg.phone },
    ]);
    await setHunt(
      {},
      fillResult && fillResult.filled ? "Form filled from config." : "Form already had values (widget autofill)."
    );

    await setHunt({ status: "submitting-checkout" }, "Submitting checkout...");
    const checkout = await exec(tabId, submitCheckoutInPage);
    if (checkout && checkout.lost) {
      if (cfg.disableAutoRefresh) {
        await setHunt({ status: "slot-lost-retry" }, `Lost slot at checkout: ${checkout.errorText || ""}. Waiting for manual refresh...`);
        await sleep(randomBetween(1500, 2500));
      } else {
        await setHunt({ status: "slot-lost-retry" }, `Lost slot at checkout: ${checkout.errorText || ""}. Re-hunting...`);
        await chrome.tabs.reload(tabId);
        await sleep(800);
      }
      continue;
    }

    // OTP required — read from email via native IMAP helper, fill and resubmit
    if (checkout && checkout.otpRequired) {
      await setHunt({ status: "waiting-otp" }, "OTP field detected — reading code from email via IMAP...");
      const { otpTriggerTs } = await chrome.storage.local.get("otpTriggerTs");
      const otpResult = await readOTPViaNative(cfg, otpTriggerTs || Date.now() - 120000);
      if (!otpResult || !otpResult.code) {
        const errMsg = otpResult ? otpResult.error : "Native messaging unavailable (run install_native.bat first)";
        await setHunt({ status: "failed", detail: `OTP not received: ${errMsg}` }, `OTP read failed: ${errMsg}`);
        await notifyHuntResult("failed", `OTP not received: ${errMsg}`);
        return;
      }
      await setHunt({ status: "filling-otp" }, `OTP received: ${otpResult.code} — filling...`);
      await exec(tabId, fillOTPInPage, [otpResult.code]);
      await sleep(400);
      const afterOtp = await exec(tabId, waitForStripeAfterOTPInPage);
      if (afterOtp && afterOtp.lost) {
        await setHunt({ status: "slot-lost-retry" }, `Lost slot after OTP: ${afterOtp.errorText || ""}. Re-hunting...`);
        if (!cfg.disableAutoRefresh) {
          await chrome.tabs.reload(tabId);
          await sleep(800);
        }
        continue;
      }
      if (!afterOtp || !afterOtp.stripeIframePresent) {
        await setHunt({ status: "failed", detail: "Stripe checkout never loaded after OTP." }, "Stripe iframe missing after OTP fill.");
        await notifyHuntResult("failed", "Stripe not loaded after OTP.");
        return;
      }
      await setHunt(
        { status: "success", detail: "OTP filled — Stripe checkout loaded, pay manually." },
        `Slot secured at ${slotResult.bestSlotText} — OTP filled, pay manually.`
      );
      await notifyHuntResult("success", `Slot secured at ${slotResult.bestSlotText} — pay manually.`);
      return;
    }

    if (!checkout || !checkout.stripeIframePresent) {
      const debugMsg = checkout
        ? `Stripe iframe never appeared (submit clicked: ${checkout.submitButtonClicked}, iframes on page: ${JSON.stringify(
            checkout.debugIframes
          )})`
        : "Stripe iframe never appeared (no result from page).";
      await setHunt({ status: "failed", detail: "Stripe checkout never loaded." }, debugMsg);
      await notifyHuntResult("failed", "Stripe checkout never loaded.");
      return;
    }

    await setHunt(
      { status: "success", detail: "Slot secured — Stripe checkout loaded, pay manually." },
      `Slot secured at ${slotResult.bestSlotText} — checkout loaded, pay manually.`
    );
    await notifyHuntResult(
      "success",
      `Slot secured at ${slotResult.bestSlotText} — pay manually.`
    );
    return;
  }
}
