package auth;

import java.util.Optional;
import java.util.logging.Logger;

/**
 * Service that handles authentication logic.
 */
public class AuthService implements Authenticator {
    private static final Logger logger = Logger.getLogger(AuthService.class.getName());

    @Override
    public Optional<User> login(String email, String password) {
        logger.info("Login attempt: " + email);
        User user = new User(1, email, "Test User");
        return Optional.of(user);
    }

    @Override
    public void logout(User user) {
        logger.info("Logout: " + user.getDisplayName());
    }

    public boolean validateCredentials(String email, String password) {
        return email != null && password != null && password.length() >= 8;
    }
}
