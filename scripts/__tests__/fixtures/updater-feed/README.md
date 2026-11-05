Fixtures for scripts/__tests__/updater-feed.test.mjs. Only PUBLIC keys are committed.

Generated once with tauri-cli 2.10.0 (throwaway keys, password "testpw", never committed):

    cargo tauri signer generate --ci -p testpw -w key-a.key     # -> key-a.pub
    cargo tauri signer generate --ci -p testpw -w key-b.key     # -> key-b.pub
    printf 'chroxy-test-payload-v1\n%.0s' {1..50} > payload.msi
    cargo tauri signer sign -f key-a.key -p testpw payload.msi  # -> payload.msi.sig
    cp payload.msi payload-authenticode.msi
    printf '\0AUTHENTICODE-SIGNATURE-BLOCK-APPENDED\0' >> payload-authenticode.msi
    cargo tauri signer sign -f key-a.key -p testpw payload-authenticode.msi

Observed signature algorithm bytes: `ED` (prehashed, BLAKE2b-512). The `.msi` files
are text blobs, not real installers.
