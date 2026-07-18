// Runs in MAIN world at document_start on UMAI tabs.
// Mirrors Python bot approach: inject email_otp into /reservations payload
// on FIRST call (not just retry). Three behaviours:
//   1. /reservations POST with stored code → inject email_otp before sending
//   2. /reservations POST returns 422 email_otp_required → get fresh code, retry
//   3. /email_otps POST with stored code → suppress (pre-sent code still valid)
(function () {
  if (window.__umai_otp_interceptor) return;
  window.__umai_otp_interceptor = true;

  const _orig = window.fetch;

  function checkStoredCode() {
    const entry = window.__umai_otp_code;
    if (!entry) return null;
    if (Date.now() - entry.ts > 600000) return null;
    return entry.code;
  }

  // Ask bridge (ISOLATED world) to send+read OTP via native host
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

  function injectOTP(init, code) {
    if (!init || !init.body) return init;
    try {
      const parsed = JSON.parse(init.body);
      if (parsed.reservation && typeof parsed.reservation === "object") {
        parsed.reservation.email_otp = code;
      } else {
        parsed.email_otp = code;
      }
      return { ...init, body: JSON.stringify(parsed) };
    } catch (_) {
      return init;
    }
  }

  window.fetch = async function (input, init) {
    const url =
      typeof input === "string" ? input
      : input && typeof input.url === "string" ? input.url
      : "";
    const method = (init && init.method && init.method.toUpperCase()) || "GET";

    // ── /reservations POST — inject OTP on first call like Python bot ──
    if (method === "POST" && url.includes("/reservations")) {
      const stored = checkStoredCode();
      if (stored) {
        console.log("[OTP-INTERCEPT] Injecting pre-sent OTP into /reservations:", stored);
        const newInit = injectOTP(init, stored);
        const resp = await _orig.call(this, input, newInit);
        if (resp.status !== 422) return resp;
        // 422 — code may have expired, get fresh one
        let bodyText = "";
        try { bodyText = await resp.clone().text(); } catch (_) {}
        if (!bodyText.includes("email_otp_required")) return resp;
        console.log("[OTP-INTERCEPT] Pre-sent code rejected (422) — fetching fresh code...");
        const fresh = await requestOTPCode();
        if (!fresh) return resp;
        console.log("[OTP-INTERCEPT] Retrying with fresh code:", fresh);
        return _orig.call(this, input, injectOTP(init, fresh));
      }

      // No pre-sent code — send as-is, handle 422 if it comes back
      const resp = await _orig.call(this, input, init);
      if (resp.status !== 422) return resp;
      let bodyText = "";
      try { bodyText = await resp.clone().text(); } catch (_) {}
      if (!bodyText.includes("email_otp_required")) return resp;
      console.log("[OTP-INTERCEPT] 422 email_otp_required — requesting fresh code...");
      const code = await requestOTPCode();
      if (!code) return resp;
      console.log("[OTP-INTERCEPT] Retrying /reservations with code:", code);
      return _orig.call(this, input, injectOTP(init, code));
    }

    // ── /email_otps POST — suppress if pre-sent code still valid ──
    if (method === "POST" && url.includes("/email_otps")) {
      const stored = checkStoredCode();
      if (stored) {
        console.log("[OTP-INTERCEPT] Suppressing /email_otps — pre-sent code valid:", stored);
        return new Response(JSON.stringify({ ok: true, suppressed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      console.log("[OTP-INTERCEPT] No pre-sent code — /email_otps goes through");
      return _orig.call(this, input, init);
    }

    return _orig.call(this, input, init);
  };
})();
