from auth import login, User


def test_login_success():
    user = login("test@test.com", "password")
    assert isinstance(user, User)


def test_login_returns_user():
    result = login("admin@test.com", "secret")
    assert result.email == "admin@test.com"
