// Runs in MAIN world at document_start on UMAI tabs.
// Two behaviours:
//   1. Widget POSTs /email_otps → if extension has a fresh pre-sent code,
//      suppress the re-send (return fake 200) so the pre-sent code stays valid.
//   2. Booking POST returns 422 email_otp_required → request code from
//      extension, retry with email_otp injected into payload.
(function () {
  if (window.__umai_otp_interceptor) return;
  window.__umai_otp_interceptor = true;

  const _orig = window.fetch;

  // Check stored code directly from window variable — set by background via executeScript.
  function checkStoredCode() {
    const entry = window.__umai_otp_code;
    if (!entry) return null;
    if (Date.now() - entry.ts > 600000) return null; // expired
    return entry.code;
  }

  // Ask bridge to send+read a fresh OTP via native host.
  function requestOTPCode() {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      function handler(e) {
        if (e.source === window && e.data && e.data.__umai_otp_response === true && e.data.__id === id) {
          window.removeEventListener("message", handler);
          resolve(e.data.code || null);
        }
      }
      window.addEventListener("message", handler);
      window.postMessage({ __umai_otp_request: true, __id: id }, "*");
      setTimeout(() => { window.removeEventListener("message", handler); resolve(null); }, 130000);
    });
  }

  window.fetch = async function (input, init) {
    const url =
      typeof input === "string" ? input
      : input && typeof input.url === "string" ? input.url
      : "";
    const method = (init && init.method && init.method.toUpperCase()) || "GET";

    // ── Suppress widget's own /email_otps POST if we have a pre-sent code ──
    if (method === "POST" && url.includes("/email_otps")) {
      const stored = checkStoredCode(); // synchronous — no timeout race
      if (stored) {
        console.log("[OTP-INTERCEPT] Suppressing /email_otps re-send — pre-sent code valid:", stored);
        return new Response(JSON.stringify({ ok: true, suppressed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      console.log("[OTP-INTERCEPT] No pre-sent code — letting /email_otps through");
      return _orig.call(this, input, init);
    }

    // ── Pass-through for everything except reservation POST ──
    const resp = await _orig.call(this, input, init);
    if (resp.status !== 422 || !url.includes("/reservations")) return resp;

    let bodyText = "";
    try { bodyText = await resp.clone().text(); } catch (_) {}
    if (!bodyText.includes("email_otp_required")) return resp;

    console.log("[OTP-INTERCEPT] 422 email_otp_required — requesting code...");
    const code = await requestOTPCode();
    if (!code) return resp;

    console.log("[OTP-INTERCEPT] Retrying with email_otp:", code);
    let newInit = { ...init };
    if (init && init.body) {
      try {
        const parsed = JSON.parse(init.body);
        if (parsed.reservation && typeof parsed.reservation === "object") {
          parsed.reservation.email_otp = code;
        } else {
          parsed.email_otp = code;
        }
        newInit = { ...init, body: JSON.stringify(parsed) };
      } catch (_) {}
    }
    return _orig.call(this, input, newInit);
  };
})();
