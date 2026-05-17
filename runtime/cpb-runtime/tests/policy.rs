use cpb_runtime::compile_policy;

#[test]
fn policy_compile_marks_rust_policy_experimental() {
    let policy = compile_policy("codex", "plan");
    assert_eq!(policy["experimental"], true);
    assert_eq!(policy["env"]["CPB_ACP_PERMISSION"], "reject");
}
