use sha2::{Digest, Sha256};
use wasm_bindgen::JsValue;

/// HMAC-SHA256 (RFC 2104) implemented over the `sha2` crate.
fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut key_block = [0u8; 64];
    if key.len() > 64 {
        let h = Sha256::digest(key);
        key_block[..32].copy_from_slice(&h);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }
    let mut ih = Sha256::new();
    ih.update(ipad);
    ih.update(data);
    let ihash = ih.finalize();
    let mut oh = Sha256::new();
    oh.update(opad);
    oh.update(ihash);
    oh.finalize().into()
}

/// PBKDF2-HMAC-SHA256 (RFC 2898). `dk_len` capped at 32*blocks.
pub fn pbkdf2_sha256(password: &[u8], salt: &[u8], iters: u32, dk_len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(dk_len);
    let mut block: u32 = 1;
    while out.len() < dk_len {
        let mut msg = salt.to_vec();
        msg.extend_from_slice(&block.to_be_bytes());
        let mut u = hmac_sha256(password, &msg);
        let mut t = u;
        for _ in 1..iters {
            u = hmac_sha256(password, &u);
            for i in 0..32 {
                t[i] ^= u[i];
            }
        }
        out.extend_from_slice(&t);
        block += 1;
    }
    out.truncate(dk_len);
    out
}

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    for i in (0..bytes.len()).step_by(2) {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

/// Constant-time equality check.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn crypto_obj() -> Option<JsValue> {
    let global = js_sys::global();
    let c = js_sys::Reflect::get(&global, &JsValue::from_str("crypto")).ok()?;
    if c.is_undefined() || c.is_null() {
        None
    } else {
        Some(c)
    }
}

/// Fill a buffer with crypto-random bytes via `crypto.getRandomValues`.
pub fn random_bytes(n: usize) -> Vec<u8> {
    let arr = js_sys::Uint8Array::new_with_length(n as u32);
    if let Some(c) = crypto_obj() {
        if let Ok(f) = js_sys::Reflect::get(&c, &JsValue::from_str("getRandomValues")) {
            let f: js_sys::Function = f.into();
            let _ = f.call1(&c, &arr);
        }
    }
    arr.to_vec()
}

/// `crypto.randomUUID()` — falls back to random hex if unavailable.
pub fn uuid() -> String {
    if let Some(c) = crypto_obj() {
        if let Ok(f) = js_sys::Reflect::get(&c, &JsValue::from_str("randomUUID")) {
            let f: js_sys::Function = f.into();
            if let Ok(v) = f.call0(&c) {
                if let Some(s) = v.as_string() {
                    return s;
                }
            }
        }
    }
    hex_encode(&random_bytes(16))
}
