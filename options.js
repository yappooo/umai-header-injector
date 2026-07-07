const FIELDS = {
  widgetUrl: "text",
  targetDate: "text",
  pax: "number",
  pollInterval: "number",
  startH: "number",
  endH: "number",
  idealH: "number",
  idealM: "number",
  noTakeaway: "checkbox",
  disableAutoRefresh: "checkbox",
  fname: "text",
  lname: "text",
  email: "text",
  phone: "text",
};

function getEl(id) {
  return document.getElementById(id);
}

async function load() {
  const { huntConfig } = await chrome.storage.local.get("huntConfig");
  if (!huntConfig) {
    getEl("widgetUrl").value = "https://reservation.umai.io/en/widget/rembayung";
    return;
  }
  getEl("widgetUrl").value = huntConfig.widgetUrl || "";
  getEl("targetDate").value = huntConfig.targetDate || "";
  getEl("pax").value = huntConfig.pax || 4;
  getEl("pollInterval").value = (huntConfig.pollIntervalMs || 1000) / 1000;
  getEl("startH").value = huntConfig.startH ?? 19;
  getEl("endH").value = huntConfig.endH ?? 21;
  getEl("idealH").value = huntConfig.idealH ?? 20;
  getEl("idealM").value = huntConfig.idealM ?? 0;
  getEl("noTakeaway").checked = huntConfig.noTakeaway !== false;
  getEl("disableAutoRefresh").checked = !!huntConfig.disableAutoRefresh;
  getEl("fname").value = huntConfig.fname || "";
  getEl("lname").value = huntConfig.lname || "";
  getEl("email").value = huntConfig.email || "";
  getEl("phone").value = huntConfig.phone || "";
}

async function save() {
  const huntConfig = {
    widgetUrl: getEl("widgetUrl").value.trim(),
    targetDate: getEl("targetDate").value.trim(),
    pax: Number(getEl("pax").value) || 4,
    pollIntervalMs: Math.round((Number(getEl("pollInterval").value) || 1) * 1000),
    startH: Number(getEl("startH").value),
    endH: Number(getEl("endH").value),
    idealH: Number(getEl("idealH").value),
    idealM: Number(getEl("idealM").value),
    noTakeaway: getEl("noTakeaway").checked,
    disableAutoRefresh: getEl("disableAutoRefresh").checked,
    fname: getEl("fname").value.trim(),
    lname: getEl("lname").value.trim(),
    email: getEl("email").value.trim(),
    phone: getEl("phone").value.trim(),
  };
  await chrome.storage.local.set({ huntConfig });
  getEl("status").textContent = "Saved.";
}

document.getElementById("save").addEventListener("click", save);

// Auto-save on every field change so config survives even if you never
// click SAVE explicitly (e.g. closing the tab mid-edit during testing).
let autoSaveTimer = null;
Object.keys(FIELDS).forEach((id) => {
  const el = getEl(id);
  if (!el) return;
  el.addEventListener("input", () => {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(save, 400);
  });
  el.addEventListener("change", save);
});

load();
