fn main() {
    // Software renderer, embedded fonts: nothing else to configure.
    slint_build::compile("src/ui.slint").expect("slint compile");

    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/icon.ico");
        res.set("ProductName", "ScreenPilot Dashboard");
        res.set("FileDescription", "ScreenPilot Dashboard");
        res.compile().expect("embed the Windows icon");
    }
    println!("cargo:rerun-if-changed=assets/icon.ico");
    println!("cargo:rerun-if-changed=assets/icon.png");
}
