// TODO: add more integration tests
use small_rust::login;

#[tokio::test]
async fn test_login_success() {
    let result = login("test@example.com", "password").await;
    assert!(result.is_some());
}
