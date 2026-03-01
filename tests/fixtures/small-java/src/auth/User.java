package auth;

import java.util.List;
import java.util.Optional;

/**
 * Represents a user in the system.
 */
public class User {
    private int id;
    private String email;
    private String name;
    public static final int MAX_NAME_LENGTH = 100;

    public User(int id, String email, String name) {
        this.id = id;
        this.email = email;
        this.name = name;
    }

    /** Returns the user's display name. */
    public String getDisplayName() {
        return name;
    }

    public int getId() {
        return id;
    }

    private void validate() {
        if (name.length() > MAX_NAME_LENGTH) {
            throw new IllegalArgumentException("Name too long");
        }
    }
}

/** Defines authentication methods. */
public interface Authenticator {
    Optional<User> login(String email, String password);
    void logout(User user);
}

/** User roles in the system. */
public enum Role {
    ADMIN,
    USER,
    GUEST
}
