fn main() {
    println!("cargo:rustc-check-cfg=cfg(falcon_shell)");
    println!("cargo:rustc-cfg=falcon_shell");
    tauri_build::build()
}
