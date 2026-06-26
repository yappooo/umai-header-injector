const input = document.getElementById("apiKey");
const status = document.getElementById("status");
const harvestBtn = document.getElementById("harvest");
const harvestStatus = document.getElementById("harvestStatus");
const useHarvestedBtn = document.getElementById("useHarvested");

chrome.storage.local.get("apiKey").then(({ apiKey }) => {
  if (apiKey) input.value = apiKey;
});

document.getElementById("save").addEventListener("click", async () => {
  const apiKey = input.value.trim();
  await chrome.storage.local.set({ apiKey });
  status.textContent = apiKey
    ? "Active: header injection ON for umai.io / letsumai.com"
    : "Cleared: header injection OFF";
});

const STATUS_TEXT = {
  opening: "Opening rembayung widget tab...",
  "waiting-cf": "Waiting for Cloudflare to clear...",
  capturing: "Cloudflare cleared, waiting for venue-api-key on the wire...",
  done: "Captured fresh key.",
  timeout: "Timed out — no key captured. Try again.",
};

function renderHarvest(harvest) {
  if (!harvest || !harvest.status) {
    harvestBtn.disabled = false;
    harvestStatus.textContent = "";
    useHarvestedBtn.style.display = "none";
    return;
  }
  harvestStatus.textContent = STATUS_TEXT[harvest.status] || harvest.status;
  const active = harvest.status === "opening" || harvest.status === "waiting-cf" || harvest.status === "capturing";
  harvestBtn.disabled = active;
  useHarvestedBtn.style.display = harvest.status === "done" && harvest.key ? "block" : "none";
}

chrome.storage.local.get("harvest").then(({ harvest }) => renderHarvest(harvest));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "harvest" in changes) {
    renderHarvest(changes.harvest.newValue);
  }
});

harvestBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage("startHarvest");
});

useHarvestedBtn.addEventListener("click", async () => {
  const { harvest } = await chrome.storage.local.get("harvest");
  if (!harvest || !harvest.key) return;
  input.value = harvest.key;
  await chrome.storage.local.set({ apiKey: harvest.key });
  status.textContent = "Active: header injection ON for umai.io / letsumai.com";
});

// ── Hunt ──────────────────────────────────────────────────────────────────
const openOptionsLink = document.getElementById("openOptions");
const startHuntBtn = document.getElementById("startHunt");
const stopHuntBtn = document.getElementById("stopHunt");
const huntStatus = document.getElementById("huntStatus");
const huntLog = document.getElementById("huntLog");

openOptionsLink.addEventListener("click", () => chrome.runtime.openOptionsPage());

const HUNT_STATUS_TEXT = {
  idle: "",
  opening: "Opening widget tab...",
  "waiting-cf": "Waiting for Cloudflare to clear...",
  "blocked-queue": "Queue not open yet, waiting...",
  "polling-slots": "Polling for slots...",
  "clicking-slot": "Slot found — clicking...",
  "verifying-click": "Verifying slot is secured...",
  "slot-lost-retry": "Slot lost — re-hunting...",
  "form-filling": "Filling contact form...",
  "submitting-checkout": "Submitting checkout...",
  "awaiting-stripe-frame": "Waiting for Stripe checkout to load...",
  success: "Slot secured — pay manually!",
  failed: "Failed.",
  timeout: "Timed out.",
  stopped: "Stopped.",
};

const HUNT_ACTIVE_STATUSES = new Set([
  "opening",
  "waiting-cf",
  "blocked-queue",
  "polling-slots",
  "clicking-slot",
  "verifying-click",
  "slot-lost-retry",
  "form-filling",
  "submitting-checkout",
  "awaiting-stripe-frame",
]);

function renderHunt(hunt) {
  if (!hunt || !hunt.status) {
    startHuntBtn.style.display = "block";
    stopHuntBtn.style.display = "none";
    huntStatus.textContent = "";
    return;
  }
  const active = HUNT_ACTIVE_STATUSES.has(hunt.status);
  startHuntBtn.style.display = active ? "none" : "block";
  stopHuntBtn.style.display = active ? "block" : "none";
  let text = HUNT_STATUS_TEXT[hunt.status] || hunt.status;
  if (hunt.bestSlotText) text += ` (${hunt.bestSlotText})`;
  if (hunt.detail) text += ` — ${hunt.detail}`;
  huntStatus.textContent = text;

  if (Array.isArray(hunt.log)) {
    huntLog.textContent = "";
    for (const e of hunt.log) {
      const ts = new Date(e.t).toLocaleTimeString();
      const line = document.createElement("div");
      line.textContent = `[${ts}] ${e.msg}`;
      huntLog.appendChild(line);
    }
    huntLog.scrollTop = huntLog.scrollHeight;
  }
}

chrome.storage.local.get("hunt").then(({ hunt }) => renderHunt(hunt));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "hunt" in changes) {
    renderHunt(changes.hunt.newValue);
  }
});

startHuntBtn.addEventListener("click", async () => {
  const { huntConfig } = await chrome.storage.local.get("huntConfig");
  if (!huntConfig || !huntConfig.targetDate) {
    huntStatus.textContent = "Configure hunt first.";
    return;
  }
  chrome.runtime.sendMessage("startHunt");
});

stopHuntBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage("stopHunt");
});
