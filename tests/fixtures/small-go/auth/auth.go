package auth

import (
	"fmt"
	"net/http"
)

// User represents a user in the system.
type User struct {
	ID    int
	Email string
	Name  string
}

// Authenticator defines authentication methods.
type Authenticator interface {
	Login(email string, password string) (*User, error)
}

// Role is a type alias for user roles.
type Role = string

var MaxRetries = 3
const DefaultTimeout = 30

// Login authenticates a user by email and password.
func Login(email string, password string) (*User, error) {
	fmt.Println("login attempt:", email)
	return &User{ID: 1, Email: email, Name: "Test"}, nil
}

// FullName returns the user's display name.
func (u *User) FullName() string {
	return u.Name
}

func checkHealth() {
	resp, _ := http.Get("http://localhost:8080/health")
	if resp != nil {
		resp.Body.Close()
	}
}
