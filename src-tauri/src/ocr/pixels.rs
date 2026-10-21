// OCR preparation: small text crops are enlarged with bilinear interpolation; crops over the
// engine's dimension cap are shrunk by box averaging.
// Thresholds are a local heuristic; recognition quality still needs a live check.
pub(super) fn ocr_size(w: i32, h: i32, max: i32) -> (i32, i32) {
    let requested: f64 = if h < 32 { 4.0 } else if h < 48 { 3.0 } else if h < 80 { 2.0 } else { 1.0 };
    let scale = requested.min(max as f64 / w.max(h) as f64);
    (((w as f64 * scale).floor() as i32).max(1), ((h as f64 * scale).floor() as i32).max(1))
}

pub(super) fn uniform(px: &[u8]) -> bool {
    px.len() >= 4 && px.chunks_exact(4).all(|p| p[..3] == px[..3])
}

/// Enlarge with bilinear interpolation; shrink by box-averaging each output pixel over its
/// source footprint, since bilinear sampling skips source rows and a 1-px stroke can vanish.
pub(super) fn resize(px: &[u8], w: i32, h: i32, cw: i32, ch: i32) -> Vec<u8> {
    if cw < w || ch < h { return shrink(px, w, h, cw, ch); }
    let mut out = vec![255; cw as usize * ch as usize * 4];
    for y in 0..ch {
        let sy = ((y as f64 + 0.5) * h as f64 / ch as f64 - 0.5).clamp(0.0, (h - 1) as f64);
        let y0 = sy.floor() as i32;
        let y1 = (y0 + 1).min(h - 1);
        let fy = sy - y0 as f64;
        for x in 0..cw {
            let sx = ((x as f64 + 0.5) * w as f64 / cw as f64 - 0.5).clamp(0.0, (w - 1) as f64);
            let x0 = sx.floor() as i32;
            let x1 = (x0 + 1).min(w - 1);
            let fx = sx - x0 as f64;
            for c in 0..3 {
                let p = |xx, yy| px[((yy * w + xx) * 4) as usize + c] as f64;
                let top = p(x0, y0) * (1.0 - fx) + p(x1, y0) * fx;
                let bottom = p(x0, y1) * (1.0 - fx) + p(x1, y1) * fx;
                out[((y * cw + x) * 4) as usize + c] = (top * (1.0 - fy) + bottom * fy).round() as u8;
            }
        }
    }
    out
}

/// Area-weighted average: output pixel (x, y) covers source [x*w/cw, (x+1)*w/cw) by the same in y,
/// and each source pixel counts by the fraction of it that falls inside. Alpha is set opaque.
fn shrink(px: &[u8], w: i32, h: i32, cw: i32, ch: i32) -> Vec<u8> {
    // (index, weight) pairs of the source pixels one output cell overlaps along one axis.
    fn spans(src: i32, dst: i32) -> Vec<Vec<(i32, f64)>> {
        let step = src as f64 / dst as f64;
        (0..dst).map(|i| {
            let (a, b) = (i as f64 * step, (i + 1) as f64 * step);
            (a.floor() as i32..(b.ceil() as i32).min(src))
                .map(|s| (s, (b.min(s as f64 + 1.0) - a.max(s as f64)).max(0.0)))
                .filter(|&(_, wt)| wt > 0.0)
                .collect()
        }).collect()
    }
    let (xs, ys) = (spans(w, cw), spans(h, ch));
    let mut out = vec![255; cw as usize * ch as usize * 4];
    for (y, ry) in ys.iter().enumerate() {
        for (x, rx) in xs.iter().enumerate() {
            let mut sum = [0.0f64; 3];
            let mut total = 0.0;
            for &(sy, wy) in ry {
                for &(sx, wx) in rx {
                    let i = ((sy * w + sx) * 4) as usize;
                    for c in 0..3 { sum[c] += px[i + c] as f64 * wx * wy; }
                    total += wx * wy;
                }
            }
            let o = (y * cw as usize + x) * 4;
            for c in 0..3 { out[o + c] = (sum[c] / total).round() as u8; }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_upscale_thresholds_and_dimension_cap() {
        assert_eq!(ocr_size(116, 25, 2600), (464, 100));
        for (height, scale) in [(31, 4), (32, 3), (47, 3), (48, 2), (79, 2), (80, 1)] {
            assert_eq!(ocr_size(100, height, 2600), (100 * scale, height * scale));
        }
        assert_eq!(ocr_size(2000, 25, 2600), (2600, 32));
        assert_eq!(ocr_size(5200, 2000, 2600), (2600, 1000));
        assert_eq!(ocr_size(4, 5200, 2600), (2, 2600));
        assert_eq!(ocr_size(116, 25, 300), (300, 64));
    }

    #[test]
    fn ocr_bilinear_resize_preserves_order_and_opaque_alpha() {
        let px = [0, 0, 0, 0, 200, 100, 40, 0];
        let out = resize(&px, 2, 1, 4, 2);
        assert_eq!(&out[..16], &[0, 0, 0, 255, 50, 25, 10, 255, 150, 75, 30, 255, 200, 100, 40, 255]);
        assert_eq!(&out[..16], &out[16..]);
    }

    /// White BGRA image, w x h, with a black 1-px vertical stroke at column `col`.
    fn stroke(w: i32, h: i32, col: i32) -> Vec<u8> {
        let mut px = vec![255u8; (w * h * 4) as usize];
        for y in 0..h { px[((y * w + col) * 4) as usize..][..3].fill(0); }
        px
    }

    #[test]
    fn ocr_shrink_box_averages_a_one_pixel_stroke() {
        // 2x shrink: the stroke's cell averages one black and one white column; the other cell stays white.
        let out = resize(&stroke(4, 2, 1), 4, 2, 2, 1);
        assert_eq!(out, [128, 128, 128, 255, 255, 255, 255, 255]);
        // 4x shrink at column 0: bilinear would sample columns 1-2 and drop the stroke; the box keeps it.
        let out = resize(&stroke(8, 4, 0), 8, 4, 2, 1);
        assert_eq!(&out[..4], &[191, 191, 191, 255]);
        assert_eq!(&out[4..], &[255, 255, 255, 255]);
    }

    #[test]
    fn ocr_blank_detection_ignores_alpha_but_keeps_low_contrast_text() {
        assert!(uniform(&[0, 0, 0, 0, 0, 0, 0, 255]));
        assert!(uniform(&[255; 8]));
        assert!(!uniform(&[255, 255, 255, 255, 254, 255, 255, 255]));
    }
}
