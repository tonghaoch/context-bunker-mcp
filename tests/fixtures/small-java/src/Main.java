package src;

import auth.User;
import auth.AuthService;
import auth.Role;
import java.util.Optional;

/**
 * Main application entry point.
 */
public class Main {
    public static void main(String[] args) {
        AuthService service = new AuthService();
        Optional<User> user = service.login("admin@test.com", "secret123");
        if (user.isPresent()) {
            System.out.println("Welcome " + user.get().getDisplayName());
        }
    }

    public static String getAppName() {
        return "small-java";
    }
}
