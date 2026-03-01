package auth

import "testing"

func TestLogin(t *testing.T) {
	user, err := Login("test@test.com", "secret")
	if err != nil {
		t.Fatal(err)
	}
	if user.Email != "test@test.com" {
		t.Errorf("expected test@test.com, got %s", user.Email)
	}
}
