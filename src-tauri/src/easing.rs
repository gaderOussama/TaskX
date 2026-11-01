/// Cubic-bezier easing, the same curve the CSS spec names.
/// Solves x(u) = t for u, then returns y(u).
fn bezier(a1: f64, a2: f64, t: f64) -> f64 {
    let mt = 1.0 - t;
    3.0 * mt * mt * t * a1 + 3.0 * mt * t * t * a2 + t * t * t
}

fn bezier_slope(a1: f64, a2: f64, t: f64) -> f64 {
    let mt = 1.0 - t;
    3.0 * mt * mt * a1 + 6.0 * mt * t * (a2 - a1) + 3.0 * t * t * (1.0 - a2)
}

pub fn make_ease(x1: f64, y1: f64, x2: f64, y2: f64) -> impl Fn(f64) -> f64 {
    move |x: f64| {
        if x <= 0.0 {
            return 0.0;
        }
        if x >= 1.0 {
            return 1.0;
        }
        let mut u = x;
        for _ in 0..8 {
            let err = bezier(x1, x2, u) - x;
            if err.abs() < 1e-6 {
                break;
            }
            let slope = bezier_slope(x1, x2, u);
            if slope.abs() < 1e-6 {
                break;
            }
            u = (u - err / slope).clamp(0.0, 1.0);
        }
        bezier(y1, y2, u)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPAND: (f64, f64, f64, f64) = (0.22, 1.0, 0.36, 1.0);
    const COLLAPSE: (f64, f64, f64, f64) = (0.4, 0.0, 1.0, 1.0);

    #[test]
    fn ends_are_exact() {
        for curve in [EXPAND, COLLAPSE] {
            let e = make_ease(curve.0, curve.1, curve.2, curve.3);
            assert_eq!(e(0.0), 0.0);
            assert_eq!(e(1.0), 1.0);
        }
    }

    #[test]
    fn stays_within_range_and_covers_the_distance() {
        for curve in [EXPAND, COLLAPSE] {
            let e = make_ease(curve.0, curve.1, curve.2, curve.3);
            let mut previous = 0.0;
            for i in 0..=200 {
                let v = e(i as f64 / 200.0);
                assert!((0.0..=1.0).contains(&v), "eased value out of range: {v}");
                assert!(v >= previous - 1e-9, "easing went backwards at {i}");
                previous = v;
            }
        }
    }

    #[test]
    fn expand_is_fast_at_the_start_and_settles_slowly() {
        let e = make_ease(EXPAND.0, EXPAND.1, EXPAND.2, EXPAND.3);
        // Most of the distance is covered in the first half of the time.
        assert!(e(0.25) > 0.5, "expected a fast start, got {}", e(0.25));
        assert!(e(0.5) > 0.85, "expected to be nearly there by half, got {}", e(0.5));
    }

    #[test]
    fn collapse_leaves_late() {
        let e = make_ease(COLLAPSE.0, COLLAPSE.1, COLLAPSE.2, COLLAPSE.3);
        // Nothing much happens early, then it goes: this curve is behind a
        // straight line for its whole run, by design.
        assert!(e(0.25) < 0.12, "expected a slow start, got {}", e(0.25));
        assert!(e(0.5) < 0.5, "expected to lag a linear collapse, got {}", e(0.5));
        assert!(e(0.9) > 0.8, "expected it nearly gone by now, got {}", e(0.9));
    }

    #[test]
    fn midpoints_are_sane() {
        let e = make_ease(0.0, 0.0, 1.0, 1.0);
        for t in [0.1, 0.33, 0.5, 0.66, 0.9] {
            assert!((e(t) - t).abs() < 0.02, "linear curve drifted at {t}");
        }
    }
}
