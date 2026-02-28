package main

import (
	"fmt"
	"example.com/small-go/auth"
)

var AppName = "small-go"

func main() {
	user, err := auth.Login("admin@test.com", "secret")
	if err != nil {
		fmt.Println("Error:", err)
		return
	}
	fmt.Println("Welcome", user.FullName())
}
