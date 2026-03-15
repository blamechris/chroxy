fn main() {
    // Compile the Swift speech helper for macOS
    #[cfg(target_os = "macos")]
    {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let swift_src = format!("{}/swift/speech-helper.swift", manifest_dir);
        let swift_out = format!("{}/swift/speech-helper", manifest_dir);

        if std::path::Path::new(&swift_src).exists() {
            let status = std::process::Command::new("swiftc")
                .args(["-O", &swift_src, "-o", &swift_out, "-framework", "Speech", "-framework", "AVFoundation"])
                .status()
                .expect("Failed to compile speech-helper.swift — is Xcode CLI tools installed?");

            if !status.success() {
                panic!("swiftc failed to compile speech-helper.swift");
            }

            println!("cargo:rerun-if-changed={}", swift_src);
        }
    }

    tauri_build::build()
}
