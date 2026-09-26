"""Ed25519 did:key signing, byte-compatible with technocore-chat scripts/sign.py.

The seed never touches disk: it comes from $SIGN_SEED or an interactive prompt.
64 hex characters are the raw 32-byte seed; anything else is SHA-256'd (sign.py rules).
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import os
import re
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
CODEC = b"\xed\x01"
DID_RE = re.compile(r"did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}")
SIG_RE = re.compile(r"[A-Za-z0-9_-]{86}")


def _b58encode(raw: bytes) -> str:
    n, out = int.from_bytes(raw, "big"), ""
    while n:
        n, rem = divmod(n, 58)
        out = B58[rem] + out
    return out


def _b58decode(text: str) -> bytes:
    n = 0
    for ch in text:
        n = n * 58 + B58.index(ch)
    return n.to_bytes(34, "big")


def key_from_seed(seed: str) -> Ed25519PrivateKey:
    if len(seed) == 64:
        try:
            return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed))
        except ValueError:
            pass
    return Ed25519PrivateKey.from_private_bytes(hashlib.sha256(seed.encode()).digest())


def load_key() -> Ed25519PrivateKey:
    seed = os.environ.get("SIGN_SEED")
    if not seed:
        if not sys.stdin.isatty():
            raise SystemExit("no key: set $SIGN_SEED or run in a terminal to be prompted")
        seed = getpass.getpass("Seed (hidden): ")
    if not seed:
        raise SystemExit("empty seed")
    return key_from_seed(seed)


def did_of(key: Ed25519PrivateKey) -> str:
    did = "did:key:z" + _b58encode(CODEC + key.public_key().public_bytes_raw())
    if not DID_RE.fullmatch(did):
        raise RuntimeError(f"internal: malformed did {did}")
    return did


def sign(key: Ed25519PrivateKey, message: str) -> str:
    return base64.urlsafe_b64encode(key.sign(message.encode("utf-8"))).decode().rstrip("=")


def public_key(did: str) -> Ed25519PublicKey:
    if not DID_RE.fullmatch(did):
        raise ValueError(f"not an Ed25519 did:key: {did!r}")
    raw = _b58decode(did[len("did:key:z"):])
    if raw[:2] != CODEC:
        raise ValueError("not an ed25519-pub multicodec")
    return Ed25519PublicKey.from_public_bytes(raw[2:])


def verify(did: str, message: str, sig: str) -> bool:
    if not isinstance(sig, str) or not SIG_RE.fullmatch(sig):
        return False
    try:
        public_key(did).verify(base64.urlsafe_b64decode(sig + "=="), message.encode("utf-8"))
        return True
    except (InvalidSignature, ValueError):
        return False
