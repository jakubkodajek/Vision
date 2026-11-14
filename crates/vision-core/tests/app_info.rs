//! F-001: the core crate reports the product name and its own version.

#[test]
fn app_info_reports_product_name_vision() {
    assert_eq!(vision_core::app_info().name, "Vision");
}

#[test]
fn app_info_reports_crate_version() {
    assert_eq!(vision_core::app_info().version, env!("CARGO_PKG_VERSION"));
}

#[test]
fn app_info_serialises_as_name_and_version_object() {
    let json = serde_json::to_value(vision_core::app_info()).expect("serialise AppInfo");
    assert_eq!(
        json,
        serde_json::json!({ "name": "Vision", "version": env!("CARGO_PKG_VERSION") })
    );
}
