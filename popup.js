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
