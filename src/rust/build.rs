fn main() {
  println!("cargo::rerun-if-changed=../../logo.ico");

  let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
  if target_os != "windows" {
    return;
  }

  let mut res = winres::WindowsResource::new();

  res.set_icon("../../logo.ico");

  if let Err(err) = res.compile() {
    panic!("failed to compile Windows resources : {err}");
  }
}
