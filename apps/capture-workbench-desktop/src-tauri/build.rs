use std::{fs, path::PathBuf};

fn main() {
    ensure_product_icon();
    tauri_build::build()
}

fn ensure_product_icon() {
    let path = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"))
        .join("icons")
        .join("icon.ico");
    if path.is_file() {
        return;
    }
    fs::create_dir_all(path.parent().expect("icon directory")).expect("create icon directory");
    fs::write(path, product_icon()).expect("write product icon");
}

fn product_icon() -> Vec<u8> {
    const WIDTH: u32 = 32;
    const HEIGHT: u32 = 32;
    let pixel_bytes = WIDTH * HEIGHT * 4;
    let mask_bytes = ((WIDTH + 31) / 32) * 4 * HEIGHT;
    let image_bytes = 40 + pixel_bytes + mask_bytes;
    let mut icon = Vec::with_capacity((22 + image_bytes) as usize);

    icon.extend_from_slice(&0_u16.to_le_bytes());
    icon.extend_from_slice(&1_u16.to_le_bytes());
    icon.extend_from_slice(&1_u16.to_le_bytes());
    icon.extend_from_slice(&[WIDTH as u8, HEIGHT as u8, 0, 0]);
    icon.extend_from_slice(&1_u16.to_le_bytes());
    icon.extend_from_slice(&32_u16.to_le_bytes());
    icon.extend_from_slice(&image_bytes.to_le_bytes());
    icon.extend_from_slice(&22_u32.to_le_bytes());

    icon.extend_from_slice(&40_u32.to_le_bytes());
    icon.extend_from_slice(&(WIDTH as i32).to_le_bytes());
    icon.extend_from_slice(&((HEIGHT * 2) as i32).to_le_bytes());
    icon.extend_from_slice(&1_u16.to_le_bytes());
    icon.extend_from_slice(&32_u16.to_le_bytes());
    icon.extend_from_slice(&0_u32.to_le_bytes());
    icon.extend_from_slice(&pixel_bytes.to_le_bytes());
    icon.extend_from_slice(&0_i32.to_le_bytes());
    icon.extend_from_slice(&0_i32.to_le_bytes());
    icon.extend_from_slice(&0_u32.to_le_bytes());
    icon.extend_from_slice(&0_u32.to_le_bytes());

    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let accent = if (x / 8 + y / 8) % 2 == 0 { 0xE8 } else { 0xC4 };
            icon.extend_from_slice(&[accent, 0x77, 0x25, 0xFF]);
        }
    }
    icon.resize((22 + image_bytes) as usize, 0);
    icon
}
