fn main() {
    // Software renderer, embedded fonts: nothing else to configure.
    slint_build::compile("src/ui.slint").expect("slint compile");
}
