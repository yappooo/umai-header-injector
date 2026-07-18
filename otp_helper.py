#!/usr/bin/env python3
"""
UMAI extension native messaging host.
Actions:
  send_otp  -- POST /widget/api/v2/email_otps via Python requests (bypasses CF browser check)
  read_otp  -- Poll IMAP for OTP code (default when action missing)
Chrome native messaging protocol: 4-byte LE length-prefixed JSON on stdin/stdout.
"""
import sys
import json
import struct
import imaplib
import email as email_lib
import email.header
import re
import time
import hashlib
import base64
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack("<I", raw)[0]
    data = sys.stdin.buffer.read(n)
    return json.loads(data.decode("utf-8"))


def send_msg(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def decode_header_val(val):
    parts = email_lib.header.decode_header(val or "")
    out = []
    for chunk, charset in parts:
        if isinstance(chunk, bytes):
            out.append(chunk.decode(charset or "utf-8", errors="ignore"))
        else:
            out.append(str(chunk))
    return " ".join(out)


def get_body(msg):
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            if ct in ("text/plain", "text/html"):
                payload = part.get_payload(decode=True)
                if payload:
                    body += payload.decode("utf-8", errors="ignore")
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            body = payload.decode("utf-8", errors="ignore")
    return body


def find_otp(host, user, password, after_ts_ms, timeout_s):
    """Poll IMAP until a 6-digit OTP code is found or timeout expires."""
    deadline = time.time() + timeout_s
    after_ts_s = after_ts_ms / 1000.0 if after_ts_ms else 0

    while time.time() < deadline:
        try:
            M = imaplib.IMAP4_SSL(host)
            M.login(user, password)
            M.select("INBOX")
            _, data = M.search(None, "UNSEEN")
            uids = (data[0] or b"").split()
            for uid in reversed(uids):
                _, msg_data = M.fetch(uid, "(RFC822)")
                raw = msg_data[0][1]
                msg = email_lib.message_from_bytes(raw)

                from_h = decode_header_val(msg.get("From", "")).lower()
                subj = decode_header_val(msg.get("Subject", "")).lower()

                # Only look at UMAI-related emails
                umai = any(
                    k in from_h or k in subj
                    for k in ("umai", "letsumai", "reservation", "booking",
                               "verify", "verification", "otp", "code", "passcode")
                )
                if not umai:
                    continue

                body = get_body(msg)
                combined = body + " " + subj
                codes = re.findall(r"\b(\d{6})\b", combined)
                if codes:
                    M.close()
                    M.logout()
                    return codes[0]

            M.close()
            M.logout()
        except Exception:
            pass

        time.sleep(3)

    return None


_BASE = "https://letsumai.com"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def _http_get(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, resp.read().decode("utf-8", errors="ignore")


def _http_post(url, headers, payload_bytes):
    req = urllib.request.Request(url, data=payload_bytes, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="ignore")


def _altcha_worker(salt, target, lo, hi, stop):
    for n in range(lo, hi):
        if stop[0]:
            return None
        if hashlib.sha256(f"{salt}{n}".encode()).hexdigest() == target:
            stop[0] = True
            return n
    return None


def solve_altcha(data):
    salt = data["salt"]
    challenge = data["challenge"]
    maxn = int(data.get("maxnumber", 1_000_000))
    import os
    workers = max(4, os.cpu_count() or 4)
    chunk = max(1, (maxn + 1) // workers)
    stop = [False]
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(_altcha_worker, salt, challenge,
                          i * chunk, min((i + 1) * chunk, maxn + 1), stop)
                for i in range(workers)]
        n_found = None
        for f in as_completed(futs):
            v = f.result()
            if v is not None:
                n_found = v
                stop[0] = True
                break
    if n_found is None:
        return None
    sol = {k: data[k] for k in ("algorithm", "challenge", "salt", "signature")}
    sol["number"] = n_found
    return base64.b64encode(json.dumps(sol, separators=(",", ":")).encode()).decode()


def get_altcha_jwt(venue_api_key):
    headers = {"Accept": "application/json", "venue-api-key": venue_api_key or "", "User-Agent": _UA}
    status, body = _http_get(f"{_BASE}/widget/api/v2/altcha/challenge", headers)
    if status != 200:
        return None, f"challenge {status}: {body[:100]}"
    challenge = json.loads(body)
    solution = solve_altcha(challenge)
    if not solution:
        return None, "PoW solve failed"
    post_h = {**headers, "Content-Type": "application/json"}
    status2, body2 = _http_post(
        f"{_BASE}/widget/api/v2/altcha/verify", post_h,
        json.dumps({"solution": solution}).encode(),
    )
    if status2 == 200:
        d = json.loads(body2)
        jwt = d.get("token") or d.get("jwt") or (d.get("data") or {}).get("token") or ""
        if jwt:
            return jwt, None
    # raw fallback
    status3, body3 = _http_post(
        f"{_BASE}/widget/api/v2/altcha/verify",
        {**headers, "Content-Type": "text/plain"}, solution.encode(),
    )
    if status3 == 200:
        d3 = json.loads(body3)
        jwt3 = d3.get("token") or d3.get("jwt") or ""
        if jwt3:
            return jwt3, None
    return None, f"verify {status2}: {body2[:100]}"


def send_otp_request(api_url, venue_api_key, email_addr):
    """Solve ALTCHA then POST email_otps — same flow as Python bot."""
    url = api_url or f"{_BASE}/widget/api/v2/email_otps"
    jwt, err = get_altcha_jwt(venue_api_key)
    if not jwt:
        return {"ok": False, "status": 0, "body": f"ALTCHA failed: {err}"}
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "venue-api-key": venue_api_key or "",
        "X-Altcha-Token": jwt,
        "User-Agent": _UA,
    }
    status, body = _http_post(url, headers, json.dumps({"email": email_addr, "locale": "en"}).encode())
    return {"ok": status in (200, 201, 204), "status": status, "body": body[:200]}


if __name__ == "__main__":
    msg = read_msg()
    if not msg:
        send_msg({"ok": False, "error": "no message received"})
        sys.exit(0)

    action = msg.get("action", "read_otp")

    if action == "send_otp":
        result = send_otp_request(
            msg.get("api_url", ""),
            msg.get("venue_api_key", ""),
            msg.get("email", ""),
        )
        send_msg(result)
        sys.exit(0)

    # default: read_otp
    code = find_otp(
        msg.get("host", "imap.gmail.com"),
        msg.get("email", ""),
        msg.get("password", ""),
        msg.get("after_ts", 0),
        msg.get("timeout", 120),
    )

    if code:
        send_msg({"ok": True, "code": code})
    else:
        send_msg({"ok": False, "code": "", "error": "OTP not found within timeout"})
