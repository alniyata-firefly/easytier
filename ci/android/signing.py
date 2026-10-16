#!/usr/bin/env python3
"""Load the existing adapted-release key from CI secrets, never from Git."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

SECRETS = (
    "ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD",
)
# Public certificate fingerprint of the distributed adapted 2.7.2 APK.
# A different key cannot update those installations, even with the same package ID.
CERTIFICATE_SHA256 = "fc60783f1ad9abf01f27df0fa8c1d1c2e2a0b8c175bdc2e23330228283ac7961"
APPLICATION_ID = "com.kkrainbow.easytier.adapted"
VERSION_CODE = 2007003


def require_secrets(environment=None):
    environment = os.environ if environment is None else environment
    missing = [name for name in SECRETS if not environment.get(name)]
    if missing:
        raise RuntimeError("Signing check failed: configure GitHub Secrets " + ", ".join(missing)
                           + "; no replacement/debug key will be generated")
    return {name: environment[name] for name in SECRETS}


def property_value(value):
    result = []
    for char in value:
        if char in "\\:=#! ":
            result.append("\\" + char)
        elif not 0x21 <= ord(char) <= 0x7e:
            encoded = char.encode("utf-16-be")
            result.extend(f"\\u{int.from_bytes(encoded[offset:offset + 2], 'big'):04x}"
                          for offset in range(0, len(encoded), 2))
        else:
            result.append(char)
    return "".join(result)


@contextmanager
def signing_inputs(keytool, source, temporary_parent=None):
    values = require_secrets()
    try:
        key_bytes = base64.b64decode("".join(values[SECRETS[0]].split()), validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise RuntimeError("Signing check failed: ANDROID_KEYSTORE_BASE64 is invalid") from error
    if not key_bytes or len(key_bytes) > 1024 * 1024:
        raise RuntimeError("Signing check failed: invalid keystore size")
    with tempfile.TemporaryDirectory(prefix="easytier-android-signing-", dir=temporary_parent) as name:
        private = Path(name).resolve()
        if private.is_relative_to(Path(source).resolve()):
            raise RuntimeError("Signing files must remain outside the source checkout")
        private.chmod(0o700)
        keystore = private / "release.keystore"
        keystore.write_bytes(key_bytes)
        keystore.chmod(0o600)
        properties = private / "release.properties"
        properties.write_text("\n".join(f"{key}={property_value(value)}" for key, value in {
            "storeFile": str(keystore), "storePassword": values[SECRETS[1]],
            "keyAlias": values[SECRETS[2]], "keyPassword": values[SECRETS[3]],
        }.items()) + "\n", encoding="ascii")
        properties.chmod(0o600)
        # Passwords are passed only through inherited environment references.
        # Never echo keytool arguments/stderr, which can expose private aliases.
        common = ["-keystore", str(keystore), "-storepass:env", SECRETS[1], "-alias", values[SECRETS[2]]]
        certificate = subprocess.run([str(keytool), "-exportcert", *common], capture_output=True)
        if certificate.returncode:
            raise RuntimeError("Signing check failed: cannot open the configured keystore/alias")
        if hashlib.sha256(certificate.stdout).hexdigest() != CERTIFICATE_SHA256:
            raise RuntimeError("Signing check failed: certificate differs from existing adapted releases")
        request = subprocess.run([str(keytool), "-certreq", *common, "-keypass:env", SECRETS[3],
                                  "-file", str(private / "key-check.csr")], capture_output=True)
        if request.returncode:
            raise RuntimeError("Signing check failed: private key password is invalid")
        yield properties, key_bytes, values


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-env", action="store_true", required=True)
    parser.parse_args()
    try:
        require_secrets()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
    print("Required Android signing secrets are present; key identity is checked before compilation.")
