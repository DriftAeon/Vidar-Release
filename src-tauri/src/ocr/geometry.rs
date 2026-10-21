// CSS selection -> physical screen rectangle, using the actual overlay client bounds.
#[derive(Debug, PartialEq)]
pub(super) struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

pub(super) fn screen_rect(
    selection: [f64; 4], viewport: [f64; 2], origin: [i32; 2], size: [u32; 2],
) -> Result<Rect, String> {
    let [x, y, w, h] = selection;
    if !selection.into_iter().chain(viewport).all(f64::is_finite)
        || viewport.iter().any(|v| *v < 1.0) || size.contains(&0) || w < 0.0 || h < 0.0
        || !(x + w).is_finite() || !(y + h).is_finite()
    {
        return Err("Invalid Capture Coordinates".into());
    }
    let edge = |v: f64, axis: usize| -> i64 {
        (v.clamp(0.0, viewport[axis]) * (size[axis] as f64 / viewport[axis])).round() as i64
    };
    let (left, top) = (edge(x, 0), edge(y, 1));
    let (right, bottom) = (edge(x + w, 0), edge(y + h, 1));
    let n = |v: i64| i32::try_from(v).map_err(|_| "Capture Coordinates Out of Range".to_string());
    Ok(Rect {
        x: n(origin[0] as i64 + left)?, y: n(origin[1] as i64 + top)?,
        w: n(right - left)?, h: n(bottom - top)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_coordinates_use_client_bounds_at_fractional_dpi_and_negative_origin() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let result = screen_rect([10.4, 20.4, 116.0, 25.0], [800.0, 600.0],
                [-1920, -200], [(800.0 * scale) as u32, (600.0 * scale) as u32]).unwrap();
            assert_eq!(result, Rect {
                x: -1920 + (10.4_f64 * scale).round() as i32,
                y: -200 + (20.4_f64 * scale).round() as i32,
                w: (126.4_f64 * scale).round() as i32 - (10.4_f64 * scale).round() as i32,
                h: (45.4_f64 * scale).round() as i32 - (20.4_f64 * scale).round() as i32,
            });
        }
    }

    #[test]
    fn ocr_coordinates_round_edges_and_clip_to_client() {
        // Rounding width alone would produce 13 instead of the covered 12 pixels.
        assert_eq!(screen_rect([0.4, 0.0, 10.0, 10.0], [80.0, 80.0], [0, 0], [100, 100]).unwrap().w, 12);
        assert_eq!(screen_rect([-4.0, 70.0, 100.0, 20.0], [80.0, 80.0], [-100, 20], [100, 100]).unwrap(),
            Rect { x: -100, y: 108, w: 100, h: 12 });
    }

    #[test]
    fn ocr_coordinates_reject_invalid_viewports_and_values() {
        for viewport in [[0.0, 600.0], [800.0, f64::NAN], [-1.0, 600.0]] {
            assert!(screen_rect([1.0, 2.0, 116.0, 25.0], viewport, [0, 0], [800, 600]).is_err());
        }
        assert!(screen_rect([f64::INFINITY, 0.0, 10.0, 10.0], [800.0, 600.0], [0, 0], [800, 600]).is_err());
        assert!(screen_rect([0.0, 0.0, -1.0, 10.0], [800.0, 600.0], [0, 0], [800, 600]).is_err());
    }
}
